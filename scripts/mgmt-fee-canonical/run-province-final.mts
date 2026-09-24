/**
 * Province-parameterized historical management-fee closeout (same protocol as run-gyeonggi-final).
 * Freezes every never-attempted exact identity of one sido into one cohort (sha256 pinned).
 * Acquires in segments of 40. Identity guard: frozen KAPT must still match live link.
 * No Production write. Exit 2 = quota/429 hold (resume later), exit 0 + PROVINCE_SEGMENT_PAUSE = budget pause.
 *
 *   npx tsx scripts/mgmt-fee-canonical/run-province-final.mts --province=incheon [--freeze-only]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { provinceArtifactPrefix, provinceFromArgv } from "./provinces";
import { classifyFeeMonth } from "./classify";
import { classifyComplex, sharedKaptCodes, buildProbePeriods, choosePublishedPeriod, KAPT_CODE_RE } from "./national-inventory";
import { buildLiveCalls, type LiveCall } from "./live-calls";
import { RateLimitStop, parseFeeResponse, scrub, type ParsedOp } from "./live-parse";
import { OpCheckpointStore } from "./op-checkpoint";
import { planWriteAction, runExpansionDryRun, type WaveTarget } from "./national-batch";
import { openReadOnlyClient, readNationalComplexes } from "./read-national-inventory";
import { assertReadOnlySql } from "./real-sample";
import { CANONICAL_AMOUNT_BASIS, CANONICAL_SOURCE, type OpObservation } from "./types";

const DIR = resolve(import.meta.dirname, "../../data/poc/mgmt-fee-canonical");
const PROVINCE = provinceFromArgv(process.argv);
const PREFIX = provinceArtifactPrefix(PROVINCE);
const CHECKPOINT_PATH = resolve(DIR, `${PREFIX}-op-checkpoint.json`);
const COHORT_PATH = resolve(DIR, `${PREFIX}-cohort.json`);
const COHORT_SHA_PATH = resolve(DIR, `${PREFIX}-cohort.sha256`);
const REPORT_PATH = resolve(DIR, `${PREFIX}-dryrun.json`);
const STATE_PATH = resolve(DIR, `${PREFIX}-segment-state.json`);
const IDENTITY_GUARD_PATH = resolve(DIR, `${PREFIX}-identity-guard.json`);
const SIDO_CODE = PROVINCE.sido_code;
const SIDO_NAME = PROVINCE.sido;
const TOTAL_CAP = 5000;
const SEGMENT_SIZE = 40;
const SLEEP_MS = 1000;
const PERIOD_CEILING = "202609";
const PROCESS_BUDGET_MS = 46 * 60 * 1000;
const UPSTREAM_ERROR_ATTEMPTS = 3;
const UPSTREAM_ERROR_BACKOFF_MS = 10000;
const OBSOLETE_OPS = new Set([
  "getHsmpDisinfectCostInfoV3",
  "getHsmpElevatorCostInfoV3",
  "getHsmpLiquifiedTaxCostInfoV3",
  "getHsmpManageCostInfoV3",
  "getHsmpDomesticWasteCostInfoV3",
  "getHsmpMeetingCostInfoV3",
  "getHsmpBuildingInsuranceCostInfoV3",
  "getHsmpOtherCostInfoV3",
  "getHsmpHeatingCostInfoV3",
  "getHsmpGasCostInfoV3",
  "getHsmpPurificationCostInfoV3",
]);

type CohortRow = {
  complex_id: string;
  kapt_code: string;
  sido: string;
  sido_code: string;
  band: "A" | "B" | "C" | "D";
  tx_12m: number;
  tx_30d: number;
  supply_ready: boolean;
  profile_promoted: boolean;
};

type TerminalStatus = "COMPLETE" | "NO_PUBLISHED_MONTH" | "PARTIAL" | "MISSING" | "FAILED" | "IDENTITY_CONFLICT";

type SegmentState = {
  version: 1;
  wave: PROVINCE.slug;
  started_at: string;
  updated_at: string;
  segment_size: number;
  segments_completed: number;
  api_calls: number;
  retries: number;
  http_429: number;
  http_5xx: number;
  timeouts: number;
  reused_ops: number;
  runtime_ms: number;
  classifications: Record<string, TerminalStatus>;
  unfinished_complex_ids: string[];
};

let store = OpCheckpointStore.empty();
let checkpointLoaded = false;
let processStarted = 0;
let runtimeLoaded = 0;
const stats = {
  api_calls: 0,
  retries: 0,
  http_429: 0,
  http_5xx: 0,
  timeouts: 0,
  reused_ops: 0,
  segments_completed: 0,
  started_at: "",
};

function referenceCalls(): LiveCall[] {
  const calls = buildLiveCalls().filter((call) => call.in_reference);
  for (const call of calls) {
    if (OBSOLETE_OPS.has(call.op)) throw new Error(`obsolete op in reference plan: ${call.op}`);
  }
  if (calls.length !== 28) throw new Error(`reference ops ${calls.length}`);
  return calls;
}

function sha256Of(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

function emptyState(): SegmentState {
  return {
    version: 1,
    wave: PROVINCE.slug,
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    segment_size: SEGMENT_SIZE,
    segments_completed: 0,
    api_calls: 0,
    retries: 0,
    http_429: 0,
    http_5xx: 0,
    timeouts: 0,
    reused_ops: 0,
    runtime_ms: 0,
    classifications: {},
    unfinished_complex_ids: [],
  };
}

function loadState(): void {
  const state = existsSync(STATE_PATH)
    ? (JSON.parse(readFileSync(STATE_PATH, "utf8")) as SegmentState)
    : emptyState();
  if (state.version !== 1 || state.wave !== PROVINCE.slug || state.segment_size !== SEGMENT_SIZE) {
    throw new Error("province segment state mismatch");
  }
  stats.api_calls = state.api_calls;
  stats.retries = state.retries;
  stats.http_429 = state.http_429;
  stats.http_5xx = state.http_5xx;
  stats.timeouts = state.timeouts;
  stats.reused_ops = state.reused_ops;
  stats.segments_completed = state.segments_completed;
  stats.started_at = state.started_at;
  runtimeLoaded = state.runtime_ms;
}

function persist(): void {
  if (!checkpointLoaded) return;
  writeFileSync(CHECKPOINT_PATH, store.serialize());
  const snapshot = snapshotClassifications();
  const body: SegmentState = {
    version: 1,
    wave: PROVINCE.slug,
    started_at: stats.started_at,
    updated_at: new Date().toISOString(),
    segment_size: SEGMENT_SIZE,
    segments_completed: stats.segments_completed,
    api_calls: stats.api_calls,
    retries: stats.retries,
    http_429: stats.http_429,
    http_5xx: stats.http_5xx,
    timeouts: stats.timeouts,
    reused_ops: stats.reused_ops,
    runtime_ms: runtimeLoaded + (processStarted > 0 ? Date.now() - processStarted : 0),
    classifications: snapshot.classifications,
    unfinished_complex_ids: snapshot.unfinished,
  };
  writeFileSync(STATE_PATH, `${JSON.stringify(body, null, 2)}\n`);
}

let cohortRef: CohortRow[] = [];
let callsRef: LiveCall[] = [];
let probeRef: LiveCall | null = null;
const periodsRef = buildProbePeriods(PERIOD_CEILING, 3);

process.on("SIGINT", () => {
  try { persist(); } catch { /* checkpoint may not be loaded */ }
  process.exit(130);
});
process.on("SIGTERM", () => {
  try { persist(); } catch { /* checkpoint may not be loaded */ }
  process.exit(143);
});

function noteResponse(status: number): void {
  if (status === 429) stats.http_429 += 1;
  else if (status >= 500) stats.http_5xx += 1;
}

async function fetchText(url: URL): Promise<{ status: number; body: string }> {
  let last: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetchBounded(url);
      if (response.status === 429 || response.status >= 500) {
        noteResponse(response.status);
        last = new Error(`http ${response.status}`);
        if (attempt < 3) {
          stats.retries += 1;
          await sleep(SLEEP_MS * (response.status === 429 ? 5 * attempt : attempt));
          continue;
        }
      }
      return response;
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      const message = error instanceof Error ? error.message : String(error);
      const retryable =
        name === "AbortError" ||
        name === "TimeoutError" ||
        name === "TypeError" ||
        /fetch failed|network|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket/i.test(message);
      if (!retryable) throw error;
      stats.timeouts += 1;
      last = error;
      if (attempt < 3) {
        stats.retries += 1;
        await sleep(SLEEP_MS * attempt);
      }
    }
  }
  throw last instanceof Error ? last : new Error("timeout");
}

async function fetchBounded(url: URL): Promise<{ status: number; body: string }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const error = new Error("timeout");
      error.name = "TimeoutError";
      reject(error);
    }, 25000);
  });
  try {
    return await Promise.race([
      (async () => {
        const response = await fetch(url, {
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        const body = await response.text();
        return { status: response.status, body };
      })(),
      deadline,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchOp(
  serviceKey: string,
  kapt: string,
  period: string,
  call: { op: string; service: string; service_name: string },
): Promise<ParsedOp> {
  const url = new URL(`https://apis.data.go.kr/1613000/${call.service_name}/${call.op}`);
  url.searchParams.set("serviceKey", serviceKey);
  url.searchParams.set("kaptCode", kapt);
  url.searchParams.set("searchDate", period);
  url.searchParams.set("_type", "json");
  // OpenAPI gateway envelopes (e.g. openapi_04 "HTTP_ERROR") are portal/upstream outages, not answers
  // about the complex. Never store them as terminal: retry with backoff, then hold (exit 2) so the
  // op is refetched on resume. Storing them made failed probes read as NO_PUBLISHED_MONTH (daegu 2026-09-24).
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetchText(url);
    let parsed: ParsedOp;
    try {
      parsed = parseFeeResponse({ http: response.status, body: response.body, expectedKapt: kapt });
    } catch (error) {
      if (error instanceof RateLimitStop) throw error;
      throw new Error(scrub(error instanceof Error ? error.message : "fetch failed"));
    }
    if (parsed.state === "failed" && /^openapi_/.test(parsed.result_class)) {
      stats.retries += 1;
      if (attempt >= UPSTREAM_ERROR_ATTEMPTS) throw new RateLimitStop(`upstream ${parsed.result_class}`);
      stats.api_calls += 1; // the caller counts only the final attempt
      await sleep(UPSTREAM_ERROR_BACKOFF_MS * attempt);
      continue;
    }
    return parsed;
  }
}

function holdReport(): void {
  const report = {
    generated_at: new Date().toISOString(),
    wave: PROVINCE.slug,
    region: PROVINCE.slug,
    production_write: false,
    cohort_terminal: false,
    gate: "BLOCKED",
    stopped: "HOLD_429",
    http_429: true,
    http_429_count: stats.http_429,
    http_5xx: stats.http_5xx,
    timeouts: stats.timeouts,
    api_calls: stats.api_calls,
    reused_ops: stats.reused_ops,
    retries: stats.retries,
    reuse_confirmation_api_calls: null,
    selected_sidos: [SIDO_CODE],
    complexes: cohortRef.length,
    no_published_month: null,
    periods: [] as string[],
    target_months: 0,
    mapping_mismatch: 0,
    duplicate_keys: 0,
    by_sido: [],
    samples: [],
    totals: { COMPLETE: 0, PARTIAL: 0, MISSING: 0, FAILED: 0, would_insert: 0, would_update: 0 },
  };
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
}

function observationsFor(complexId: string, period: string, calls: readonly LiveCall[]): OpObservation[] {
  return calls.map((call) => {
    const record = store.get(complexId, period, call.service, call.op);
    if (!record || record.status === "missing") return { op: call.op, state: "missing", amount: null };
    if (record.status === "failed") return { op: call.op, state: "failed", amount: null, error: record.error };
    return { op: call.op, state: "success", amount: record.amount };
  });
}

function catalogReady(complexId: string, period: string, calls: readonly LiveCall[]): boolean {
  return calls.every((call) => store.get(complexId, period, call.service, call.op) != null);
}

function probeOutcome(complex: CohortRow): { kind: "unprobed" } | { kind: "unpublished" } | { kind: "published"; period: string } {
  if (!probeRef) throw new Error("probe missing");
  const probes: { period: string; published: boolean }[] = [];
  for (const period of periodsRef) {
    const cached = store.get(complex.complex_id, period, probeRef.service, probeRef.op);
    if (!cached) return { kind: "unprobed" };
    probes.push({ period, published: cached.status === "success" && (cached.amount ?? 0) > 0 });
  }
  const period = choosePublishedPeriod(probes);
  if (!period) return { kind: "unpublished" };
  return { kind: "published", period };
}

function terminalStatus(complex: CohortRow): TerminalStatus | null {
  if (identityConflicts.has(complex.complex_id)) return "IDENTITY_CONFLICT";
  const outcome = probeOutcome(complex);
  if (outcome.kind === "unprobed") return null;
  if (outcome.kind === "unpublished") return "NO_PUBLISHED_MONTH";
  if (!catalogReady(complex.complex_id, outcome.period, callsRef)) return null;
  // A stored failed op is terminal for this wave. Do not refetch it.
  const classified = classifyFeeMonth({
    complex_id: complex.complex_id,
    period_yyyymm: outcome.period,
    expectedOps: callsRef.map((call) => call.op),
    observations: observationsFor(complex.complex_id, outcome.period, callsRef),
    source: CANONICAL_SOURCE,
    amount_basis: CANONICAL_AMOUNT_BASIS,
  });
  if (
    classified.checkpoint_status !== "COMPLETE" &&
    classified.checkpoint_status !== "PARTIAL" &&
    classified.checkpoint_status !== "MISSING" &&
    classified.checkpoint_status !== "FAILED"
  ) {
    return null;
  }
  return classified.checkpoint_status;
}

function snapshotClassifications(): { classifications: Record<string, TerminalStatus>; unfinished: string[] } {
  const classifications: Record<string, TerminalStatus> = {};
  const unfinished: string[] = [];
  for (const complex of cohortRef) {
    const status = terminalStatus(complex);
    if (status) classifications[complex.complex_id] = status;
    else unfinished.push(complex.complex_id);
  }
  return { classifications, unfinished };
}

async function loadPrioritySignals(readyIds: readonly string[]): Promise<Map<string, { tx_12m: number; tx_30d: number; supply_ready: boolean }>> {
  const db = openReadOnlyClient();
  const out = new Map(readyIds.map((id) => [id, { tx_12m: 0, tx_30d: 0, supply_ready: false }]));
  if (readyIds.length === 0) return out;
  const placeholders = readyIds.map(() => "?").join(", ");
  const txSql = `
    SELECT m.complex_id,
           COUNT(*) AS tx_12m,
           SUM(CASE WHEN t.deal_date >= date('now', '-30 day') THEN 1 ELSE 0 END) AS tx_30d
    FROM apt_complex_master m
    JOIN transactions t
      ON t.lawd_cd = m.lawd_cd AND t.apt_name_norm = m.apt_name_norm
    WHERE m.complex_id IN (${placeholders})
      AND t.deal_date >= date('now', '-365 day')
    GROUP BY m.complex_id
  `;
  assertReadOnlySql(txSql);
  const tx = await db.execute({ sql: txSql, args: [...readyIds] });
  for (const row of tx.rows) {
    const id = String(row.complex_id);
    const cur = out.get(id);
    if (!cur) continue;
    cur.tx_12m = Number(row.tx_12m);
    cur.tx_30d = Number(row.tx_30d);
  }
  const supplySql = `
    SELECT DISTINCT c.complex_id
    FROM apt_unit_types u
    JOIN apt_complex_classifications c ON c.complex_key = u.complex_key
    WHERE c.complex_id IN (${placeholders})
      AND u.supply_area_sqm IS NOT NULL
      AND u.supply_area_sqm > 0
  `;
  assertReadOnlySql(supplySql);
  const supply = await db.execute({ sql: supplySql, args: [...readyIds] });
  for (const row of supply.rows) {
    const cur = out.get(String(row.complex_id));
    if (cur) cur.supply_ready = true;
  }
  return out;
}

function bandOf(signal: { tx_12m: number; tx_30d: number; supply_ready: boolean }): "A" | "B" | "C" | "D" {
  if (signal.tx_12m > 0) return "A";
  if (signal.supply_ready) return "B";
  if (signal.tx_30d > 0) return "C";
  return "D";
}

async function feeBaseline(): Promise<{ rows: number; complexes: number }> {
  const db = openReadOnlyClient();
  const rowSql = "SELECT COUNT(*) AS n FROM apt_complex_mgmt_fee_monthly";
  const complexSql = "SELECT COUNT(DISTINCT complex_id) AS n FROM apt_complex_mgmt_fee_monthly";
  assertReadOnlySql(rowSql);
  assertReadOnlySql(complexSql);
  const rows = await db.execute(rowSql);
  const complexes = await db.execute(complexSql);
  return { rows: Number(rows.rows[0]?.n), complexes: Number(complexes.rows[0]?.n) };
}

const identityConflicts = new Map<string, { frozen_kapt: string; live_kapt: string | null; detail: string }>();

async function loadLiveKaptLinks(complexIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (complexIds.length === 0) return out;
  const db = openReadOnlyClient();
  const chunk = 400;
  for (let offset = 0; offset < complexIds.length; offset += chunk) {
    const batch = complexIds.slice(offset, offset + chunk);
    const sql = `SELECT complex_id, source_key FROM apt_complex_source_links WHERE source = 'KAPT' AND complex_id IN (${batch.map(() => "?").join(", ")})`;
    assertReadOnlySql(sql);
    const result = await db.execute({ sql, args: [...batch] });
    for (const row of result.rows) out.set(String(row.complex_id), String(row.source_key));
  }
  return out;
}

function persistIdentityGuard(checked: number): void {
  writeFileSync(
    IDENTITY_GUARD_PATH,
    `${JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        checked,
        pass: checked - identityConflicts.size,
        conflicts: identityConflicts.size,
        remapped: 0,
        unsafe_writes_prevented: identityConflicts.size,
        samples: [...identityConflicts.entries()].slice(0, 20).map(([complex_id, row]) => ({ complex_id, ...row })),
      },
      null,
      2,
    )}\n`,
  );
}

async function applyIdentityGuard(cohort: readonly CohortRow[]): Promise<void> {
  const live = await loadLiveKaptLinks(cohort.map((row) => row.complex_id));
  for (const row of cohort) {
    const liveKapt = live.get(row.complex_id) ?? null;
    if (liveKapt === row.kapt_code && KAPT_CODE_RE.test(row.kapt_code)) continue;
    identityConflicts.set(row.complex_id, {
      frozen_kapt: row.kapt_code,
      live_kapt: liveKapt,
      detail: liveKapt == null ? "missing live KAPT link" : "frozen KAPT != live KAPT",
    });
  }
  persistIdentityGuard(cohort.length);
}

async function selectAndFreezeCohort(): Promise<CohortRow[]> {
  if (existsSync(COHORT_PATH)) {
    const frozen = JSON.parse(readFileSync(COHORT_PATH, "utf8")) as {
      complexes: CohortRow[];
      selected: number;
      frozen: boolean;
    };
    if (!frozen.frozen || !Array.isArray(frozen.complexes) || frozen.complexes.length !== frozen.selected) {
      throw new Error(`frozen cohort size ${frozen.complexes?.length}`);
    }
    if (frozen.selected < 1 || frozen.selected > TOTAL_CAP) throw new Error(`frozen selected ${frozen.selected}`);
    const pinned = existsSync(COHORT_SHA_PATH) ? readFileSync(COHORT_SHA_PATH, "utf8").trim() : "";
    if (!pinned || pinned !== sha256Of(COHORT_PATH)) throw new Error("frozen cohort sha mismatch");
    return frozen.complexes;
  }
  const db = openReadOnlyClient();
  const masterSql = "SELECT COUNT(*) AS n FROM apt_complex_master WHERE sido_code = ?";
  assertReadOnlySql(masterSql);
  const masterResult = await db.execute({ sql: masterSql, args: [SIDO_CODE] });
  const provinceMaster = Number(masterResult.rows[0]?.n);
  const rows = await readNationalComplexes(db);
  const shared = sharedKaptCodes(rows);
  let confirmedExact = 0;
  let alreadyCovered = 0;
  let excludedUnsafe = 0;
  let multiCode = 0;
  const ready: Array<{ complex_id: string; kapt_code: string; sido: string; sido_code: string; profile_promoted: boolean }> = [];
  for (const row of rows) {
    if (row.sido_code !== SIDO_CODE) continue;
    const codes = [...new Set(row.kapt_codes)];
    if (codes.length > 1) multiCode += 1;
    const confirmed = codes.length === 1 && KAPT_CODE_RE.test(codes[0] ?? "") && !shared.has(codes[0] ?? "");
    if (!confirmed) {
      if (codes.length > 0) excludedUnsafe += 1;
      continue;
    }
    confirmedExact += 1;
    if (row.has_fee) {
      alreadyCovered += 1;
      continue;
    }
    const state = classifyComplex(row, shared);
    if (state !== "READY") {
      excludedUnsafe += 1;
      continue;
    }
    const kapt = codes[0];
    if (!kapt) continue;
    ready.push({
      complex_id: row.complex_id,
      kapt_code: kapt,
      sido: row.sido || SIDO_NAME,
      sido_code: SIDO_CODE,
      profile_promoted: false,
    });
  }
  if (multiCode !== 0) throw new Error(`province identity duplicates multi=${multiCode}`);
  const provinceShared = new Set<string>();
  for (const row of rows) {
    if (row.sido_code !== SIDO_CODE) continue;
    for (const code of row.kapt_codes) if (shared.has(code)) provinceShared.add(code);
  }
  if (provinceShared.size !== 0) throw new Error(`province shared kapt ${provinceShared.size}`);
  if (ready.length < 1) throw new Error("eligible remaining 0");
  const signals = await loadPrioritySignals(ready.map((row) => row.complex_id));
  const ranked = ready
    .map((row) => {
      const signal = signals.get(row.complex_id) ?? { tx_12m: 0, tx_30d: 0, supply_ready: false };
      return {
        ...row,
        band: bandOf(signal),
        tx_12m: signal.tx_12m,
        tx_30d: signal.tx_30d,
        supply_ready: signal.supply_ready,
      } satisfies CohortRow;
    })
    .sort((left, right) => {
      const order = { A: 0, B: 1, C: 2, D: 3 } as const;
      if (order[left.band] !== order[right.band]) return order[left.band] - order[right.band];
      if (right.tx_12m !== left.tx_12m) return right.tx_12m - left.tx_12m;
      if (right.tx_30d !== left.tx_30d) return right.tx_30d - left.tx_30d;
      return left.complex_id.localeCompare(right.complex_id);
    });
  if (ranked.length > TOTAL_CAP) throw new Error(`eligible ${ranked.length} exceeds sanity cap`);
  const selected = ranked;
  const other = confirmedExact - alreadyCovered - ready.length;
  if (other !== 0) throw new Error(`reconciliation other=${other}`);
  const baseline = await feeBaseline();
  const body = {
    generated_at: new Date().toISOString(),
    wave: PROVINCE.slug,
    region: PROVINCE.slug,
    selected: selected.length,
    frozen: true,
    selection_rule:
      `${SIDO_NAME} historical closeout. All confirmed exact KAPT identities (one complex, one A######## code, not shared) that are not already fee-covered. Rank band A (tx_12m desc), B (supply_area_sqm>0), C (tx_30d desc), D, then complex_id asc. No arbitrary Wave subsets. No membership cap.`,
    segment_size: SEGMENT_SIZE,
    province_master: provinceMaster,
    confirmed_exact: confirmedExact,
    already_fee_covered: alreadyCovered,
    known_no_published_month: 0,
    reconciliation_other: other,
    never_attempted: ready.length,
    remaining_eligible: ready.length,
    excluded_unsafe: excludedUnsafe,
    duplicate_multi_code: multiCode,
    baseline_fee_rows: baseline.rows,
    baseline_fee_complexes: baseline.complexes,
    ready_pool: ready.length,
    bands: {
      A: selected.filter((row) => row.band === "A").length,
      B: selected.filter((row) => row.band === "B").length,
      C: selected.filter((row) => row.band === "C").length,
      D: selected.filter((row) => row.band === "D").length,
    },
    complexes: selected,
  };
  writeFileSync(COHORT_PATH, `${JSON.stringify(body, null, 2)}\n`);
  writeFileSync(COHORT_SHA_PATH, `${sha256Of(COHORT_PATH)}\n`);
  writeSync(
    1,
    `cohort master=${provinceMaster} confirmed=${confirmedExact} covered=${alreadyCovered} never_attempted=${ready.length} selected=${selected.length} baseline=${baseline.rows}/${baseline.complexes}\n`,
  );
  return selected;
}

async function existingFeeKeys(complexIds: readonly string[]): Promise<Set<string>> {
  if (complexIds.length === 0) return new Set();
  const sql = `SELECT complex_id, period_yyyymm FROM apt_complex_mgmt_fee_monthly WHERE complex_id IN (${complexIds.map(() => "?").join(", ")})`;
  assertReadOnlySql(sql);
  const db = openReadOnlyClient();
  const result = await db.execute({ sql, args: [...complexIds] });
  return new Set(result.rows.map((row) => `${String(row.complex_id)}|${String(row.period_yyyymm)}`));
}

async function probeComplex(serviceKey: string, complex: CohortRow, probe: LiveCall): Promise<void> {
  for (const period of periodsRef) {
    if (!store.shouldFetch(complex.complex_id, period, probe.service, probe.op)) {
      stats.reused_ops += 1;
      continue;
    }
    await sleep(SLEEP_MS);
    let parsed: ParsedOp;
    try {
      parsed = await fetchOp(serviceKey, complex.kapt_code, period, probe);
    } catch (error) {
      if (error instanceof RateLimitStop) {
        stats.api_calls += 1;
        persist();
        holdReport();
        writeSync(1, `${JSON.stringify({ stopped: "HOLD_429", api_calls: stats.api_calls, http_429: stats.http_429 })}\n`);
        process.exit(2);
      }
      throw error;
    }
    stats.api_calls += 1;
    store.put({
      complex_id: complex.complex_id,
      period,
      op: probe.op,
      service: probe.service,
      status: parsed.state,
      http: parsed.http,
      result_class: parsed.result_class,
      amount: parsed.amount,
      numeric_fields: parsed.numeric_fields,
      explicit_zero_fields: parsed.explicit_zero_fields,
      error: parsed.error,
      completed_at: new Date().toISOString(),
    });
    if (stats.api_calls % 10 === 0) {
      persist();
      writeSync(
        1,
        `api ${stats.api_calls} retries ${stats.retries} 429 ${stats.http_429} 5xx ${stats.http_5xx} timeout ${stats.timeouts}\n`,
      );
    }
  }
}

async function acquireSegment(serviceKey: string, segment: readonly CohortRow[], calls: readonly LiveCall[]): Promise<void> {
  const probe = calls.find((call) => call.op === "getHsmpCleaningCostInfoV3" && call.service === "common");
  if (!probe) throw new Error("cleaning probe missing");
  const safeSegment = segment.filter((complex) => !identityConflicts.has(complex.complex_id));
  for (const complex of safeSegment) {
    await probeComplex(serviceKey, complex, probe);
  }
  const published: WaveTarget[] = [];
  for (const complex of safeSegment) {
    const outcome = probeOutcome(complex);
    if (outcome.kind !== "published") continue;
    if (catalogReady(complex.complex_id, outcome.period, calls)) continue;
    published.push({
      complex_id: complex.complex_id,
      sido: complex.sido,
      sido_code: complex.sido_code,
      kapt_code: complex.kapt_code,
      period: outcome.period,
    });
  }
  if (published.length === 0) return;
  const dry = await runExpansionDryRun({
    targets: published,
    calls,
    store,
    maxTargets: published.length,
    sleepMs: SLEEP_MS,
    workers: 1,
    now: new Date().toISOString(),
    fetchOp: async (args) => {
      try {
        const parsed = await fetchOp(serviceKey, args.kapt_code, args.period, {
          op: args.op,
          service: args.service,
          service_name: calls.find((call) => call.op === args.op && call.service === args.service)?.service_name ?? "",
        });
        stats.api_calls += 1;
        if (stats.api_calls % 10 === 0) {
          persist();
          writeSync(
            1,
            `api ${stats.api_calls} retries ${stats.retries} 429 ${stats.http_429} 5xx ${stats.http_5xx} timeout ${stats.timeouts}\n`,
          );
        }
        return parsed;
      } catch (error) {
        if (error instanceof RateLimitStop) stats.api_calls += 1;
        throw error;
      }
    },
    sleep: async () => sleep(SLEEP_MS),
  });
  store = dry.store;
  stats.reused_ops += dry.reused_ops;
  if (dry.stopped === "HOLD_429") {
    persist();
    holdReport();
    writeSync(1, `${JSON.stringify({ stopped: "HOLD_429", api_calls: stats.api_calls, http_429: stats.http_429 })}\n`);
    process.exit(2);
  }
}

async function writeFinalReport(cohort: readonly CohortRow[], calls: readonly LiveCall[]): Promise<void> {
  const published: WaveTarget[] = [];
  for (const complex of cohort) {
    if (identityConflicts.has(complex.complex_id)) continue;
    const outcome = probeOutcome(complex);
    if (outcome.kind !== "published") continue;
    if (!catalogReady(complex.complex_id, outcome.period, calls)) {
      throw new Error(`published catalog incomplete ${complex.complex_id}`);
    }
    published.push({
      complex_id: complex.complex_id,
      sido: complex.sido,
      sido_code: complex.sido_code,
      kapt_code: complex.kapt_code,
      period: outcome.period,
    });
  }
  const existingKeys = await existingFeeKeys(cohort.map((row) => row.complex_id));
  const records = published.map((target) => {
    const classified = classifyFeeMonth({
      complex_id: target.complex_id,
      period_yyyymm: target.period,
      expectedOps: calls.map((call) => call.op),
      observations: observationsFor(target.complex_id, target.period, calls),
      source: CANONICAL_SOURCE,
      amount_basis: CANONICAL_AMOUNT_BASIS,
    });
    const status = classified.checkpoint_status;
    if (status !== "COMPLETE" && status !== "PARTIAL" && status !== "MISSING" && status !== "FAILED") {
      throw new Error(`unexpected status ${target.complex_id} ${status}`);
    }
    const would = planWriteAction(status, existingKeys.has(`${target.complex_id}|${target.period}`));
    return {
      complex_id: target.complex_id,
      sido: target.sido,
      sido_code: target.sido_code,
      period: target.period,
      status,
      amount: status === "COMPLETE" ? classified.amount : null,
      would,
    };
  });
  let reuseConfirmation = 0;
  const confirmTargets = published.filter((target) => {
    const record = records.find((row) => row.complex_id === target.complex_id && row.period === target.period);
    return record?.status === "COMPLETE" || record?.status === "MISSING";
  });
  if (confirmTargets.length > 0) {
    const confirmCap = 200;
    for (let offset = 0; offset < confirmTargets.length; offset += confirmCap) {
    const batch = confirmTargets.slice(offset, offset + confirmCap);
    const confirm = await runExpansionDryRun({
      targets: batch,
      calls,
      store,
      prior: batch.map((target) => {
        const record = records.find((row) => row.complex_id === target.complex_id);
        if (!record || (record.status !== "COMPLETE" && record.status !== "MISSING")) {
          throw new Error(`confirm target missing ${target.complex_id}`);
        }
        return {
          complex_id: target.complex_id,
          sido: target.sido,
          sido_code: target.sido_code,
          period: target.period,
          status: record.status,
          amount: record.amount,
          would: record.would,
          updated_at: new Date().toISOString(),
        };
      }),
      maxTargets: batch.length,
      sleepMs: SLEEP_MS,
      workers: 1,
      fetchOp: async () => {
        reuseConfirmation += 1;
        throw new Error("checkpoint reuse fetched a terminal op");
      },
      sleep: async () => undefined,
    });
    if (confirm.api_calls !== 0 || reuseConfirmation !== 0) {
      throw new Error(`reuse confirmation failed api=${confirm.api_calls} extra=${reuseConfirmation}`);
    }
    }
  }
  const snapshot = snapshotClassifications();
  if (snapshot.unfinished.length !== 0) throw new Error(`unfinished at final ${snapshot.unfinished.length}`);
  const counts = { COMPLETE: 0, NO_PUBLISHED_MONTH: 0, PARTIAL: 0, MISSING: 0, FAILED: 0, IDENTITY_CONFLICT: 0 };
  for (const status of Object.values(snapshot.classifications)) counts[status] += 1;
  const sum =
    counts.COMPLETE +
    counts.NO_PUBLISHED_MONTH +
    counts.PARTIAL +
    counts.MISSING +
    counts.FAILED +
    counts.IDENTITY_CONFLICT;
  if (sum !== cohort.length) throw new Error(`classification sum ${sum}`);
  const totals = records.reduce(
    (acc, row) => ({
      COMPLETE: acc.COMPLETE + (row.status === "COMPLETE" ? 1 : 0),
      PARTIAL: acc.PARTIAL + (row.status === "PARTIAL" ? 1 : 0),
      MISSING: acc.MISSING + (row.status === "MISSING" ? 1 : 0),
      FAILED: acc.FAILED + (row.status === "FAILED" ? 1 : 0),
      would_insert: acc.would_insert + (row.would === "insert" ? 1 : 0),
      would_update: acc.would_update + (row.would === "update" ? 1 : 0),
    }),
    { COMPLETE: 0, PARTIAL: 0, MISSING: 0, FAILED: 0, would_insert: 0, would_update: 0 },
  );
  if (totals.COMPLETE !== counts.COMPLETE || totals.PARTIAL !== counts.PARTIAL || totals.MISSING !== counts.MISSING || totals.FAILED !== counts.FAILED) {
    throw new Error("dry-run classification diverges from checkpoint");
  }
  const invalidAmounts = records.filter((record) => record.status === "COMPLETE" && (record.amount == null || !Number.isSafeInteger(record.amount))).length;
  const mappingMismatch = cohort.filter((row) => !KAPT_CODE_RE.test(row.kapt_code) || row.sido_code !== SIDO_CODE).length;
  const identityMismatch = identityConflicts.size;
  const duplicateKeys =
    new Set(cohort.map((row) => row.complex_id)).size === cohort.length &&
    new Set(cohort.map((row) => row.kapt_code)).size === cohort.length
      ? 0
      : 1;
  const periodDistribution: Record<string, number> = {};
  let canonicalTotal = 0;
  for (const record of records) {
    if (record.status !== "COMPLETE") continue;
    periodDistribution[record.period] = (periodDistribution[record.period] ?? 0) + 1;
    canonicalTotal += record.amount ?? 0;
  }
  const bySido = [{
    sido_code: SIDO_CODE,
    sido: SIDO_NAME,
    targets: records.length,
    COMPLETE: totals.COMPLETE,
    PARTIAL: totals.PARTIAL,
    MISSING: totals.MISSING,
    FAILED: totals.FAILED,
    would_insert: totals.would_insert,
    would_update: totals.would_update,
  }];
  const samples = records.filter((row) => row.status === "COMPLETE").slice(0, 10).map((record) => ({
    complex_id: record.complex_id,
    sido_code: record.sido_code,
    period: record.period,
    status: record.status,
    amount: record.amount,
    would: record.would,
  }));
  const baseline = await feeBaseline();
  const gate =
    duplicateKeys === 0 &&
    mappingMismatch === 0 &&
    identityMismatch === counts.IDENTITY_CONFLICT &&
    totals.would_update === 0 &&
    totals.would_insert === totals.COMPLETE &&
    existingKeys.size === 0 &&
    invalidAmounts === 0 &&
    counts.NO_PUBLISHED_MONTH + counts.IDENTITY_CONFLICT === cohort.length - published.length
      ? "PASS"
      : "BLOCKED";
  const report = {
    generated_at: new Date().toISOString(),
    wave: PROVINCE.slug,
    region: PROVINCE.slug,
    production_write: false,
    cohort_terminal: true,
    gate,
    api_calls: stats.api_calls,
    reused_ops: stats.reused_ops,
    reuse_confirmation_api_calls: 0,
    http_429: false,
    http_429_count: stats.http_429,
    http_5xx: stats.http_5xx,
    timeouts: stats.timeouts,
    retries: stats.retries,
    segments_completed: stats.segments_completed,
    segment_size: SEGMENT_SIZE,
    runtime_ms: runtimeLoaded + (processStarted > 0 ? Date.now() - processStarted : 0),
    stopped: "ok",
    canonical_total: canonicalTotal,
    selected_sidos: [SIDO_CODE],
    complexes: cohort.length,
    complexes_by_sido: { [SIDO_CODE]: cohort.length },
    checkpoint_records: store.list().length,
    no_published_month: counts.NO_PUBLISHED_MONTH,
    no_published_month_by_sido: { [SIDO_CODE]: counts.NO_PUBLISHED_MONTH },
    identity_conflicts: identityMismatch,
    classification: counts,
    classification_sum: sum,
    periods: [...new Set(published.map((target) => target.period))].sort(),
    period_distribution: periodDistribution,
    target_months: published.length,
    mapping_mismatch: mappingMismatch,
    duplicate_keys: duplicateKeys,
    invalid_amounts: invalidAmounts,
    existing_fee_keys: existingKeys.size,
    would_delete: 0,
    baseline_fee_rows: baseline.rows,
    baseline_fee_complexes: baseline.complexes,
    by_sido: bySido,
    samples,
    totals,
  };
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  writeSync(
    1,
    `${JSON.stringify({ stopped: "ok", gate, api_calls: stats.api_calls, retries: stats.retries, http_429: stats.http_429, http_5xx: stats.http_5xx, timeouts: stats.timeouts, classification: counts, totals })}\n`,
  );
  writeSync(1, "PROVINCE_COHORT_TERMINAL\n");
}

async function main(): Promise<void> {
  if (process.argv.includes("--apply")) {
    console.error("refusing --apply");
    process.exit(2);
  }
  if (SEGMENT_SIZE < 1 || SEGMENT_SIZE > 50) throw new Error("segment size");
  mkdirSync(DIR, { recursive: true });
  const key = process.env.MOLIT_API_KEY?.trim();
  if (!key) throw new Error("MOLIT_API_KEY missing");
  const calls = referenceCalls();
  const probe = calls.find((call) => call.op === "getHsmpCleaningCostInfoV3" && call.service === "common");
  if (!probe) throw new Error("cleaning probe missing");
  callsRef = calls;
  probeRef = probe;

  const cohort = await selectAndFreezeCohort();
  cohortRef = cohort;
  const mappingMismatch = cohort.filter((row) => !KAPT_CODE_RE.test(row.kapt_code) || row.sido_code !== SIDO_CODE).length;
  const duplicateKeys =
    new Set(cohort.map((row) => row.complex_id)).size === cohort.length &&
    new Set(cohort.map((row) => row.kapt_code)).size === cohort.length
      ? 0
      : 1;
  if (cohort.length < 1 || cohort.length > TOTAL_CAP || mappingMismatch !== 0 || duplicateKeys !== 0) {
    throw new Error(`cohort guard size=${cohort.length} mismatch=${mappingMismatch} duplicate=${duplicateKeys}`);
  }
  await applyIdentityGuard(cohort);
  if (process.argv.includes("--freeze-only")) {
    writeSync(1, "PROVINCE_FROZEN\n");
    return;
  }

  if (existsSync(CHECKPOINT_PATH)) {
    store = OpCheckpointStore.parse(readFileSync(CHECKPOINT_PATH, "utf8"));
  }
  checkpointLoaded = true;
  loadState();
  if (!stats.started_at) stats.started_at = new Date().toISOString();
  processStarted = Date.now();
  const cohortIds = new Set(cohort.map((row) => row.complex_id));
  const checkpointIds = new Set(store.list().map((record) => record.complex_id));
  for (const id of checkpointIds) {
    if (!cohortIds.has(id)) throw new Error(`checkpoint complex outside final cohort ${id}`);
  }
  if (existsSync(REPORT_PATH)) {
    const existing = JSON.parse(readFileSync(REPORT_PATH, "utf8")) as { cohort_terminal?: boolean; gate?: string };
    if (existing.cohort_terminal === true) {
      writeSync(1, "PROVINCE_COHORT_TERMINAL\n");
      return;
    }
  }
  const initial = snapshotClassifications();
  writeSync(
    1,
    `resume records=${store.list().length} cohort=${cohort.length} terminal=${Object.keys(initial.classifications).length} unfinished=${initial.unfinished.length} api=${stats.api_calls} retries=${stats.retries} 429=${stats.http_429} 5xx=${stats.http_5xx} timeout=${stats.timeouts}\n`,
  );
  if (initial.unfinished.length === 0) {
    stats.segments_completed += 0;
    persist();
    await writeFinalReport(cohort, calls);
    persist();
    return;
  }

  while (snapshotClassifications().unfinished.length > 0) {
    if (Date.now() - processStarted > PROCESS_BUDGET_MS && stats.segments_completed > 0) {
      persist();
      const snap = snapshotClassifications();
      writeSync(
        1,
        `PROVINCE_SEGMENT_PAUSE segments=${stats.segments_completed} terminal=${Object.keys(snap.classifications).length} unfinished=${snap.unfinished.length} api=${stats.api_calls} retries=${stats.retries} 429=${stats.http_429} 5xx=${stats.http_5xx} timeout=${stats.timeouts}\n`,
      );
      return;
    }
    const unfinished = new Set(snapshotClassifications().unfinished);
    const segment = cohort.filter((row) => unfinished.has(row.complex_id)).slice(0, SEGMENT_SIZE);
    if (segment.length === 0 || segment.length > 50) throw new Error(`segment ${segment.length}`);
    writeSync(1, `segment_start size=${segment.length} api=${stats.api_calls}\n`);
    await acquireSegment(key, segment, calls);
    stats.segments_completed += 1;
    persist();
    const snap = snapshotClassifications();
    writeSync(
      1,
      `segment_done segments=${stats.segments_completed} terminal=${Object.keys(snap.classifications).length} unfinished=${snap.unfinished.length} api=${stats.api_calls} retries=${stats.retries} 429=${stats.http_429} 5xx=${stats.http_5xx} timeout=${stats.timeouts}\n`,
    );
  }
  await writeFinalReport(cohort, calls);
  persist();
}

main().catch((error: unknown) => {
  try {
    persist();
  } catch {
    // checkpoint may not exist yet
  }
  console.error(scrub(error instanceof Error ? error.message : "wave failed"));
  process.exit(1);
});

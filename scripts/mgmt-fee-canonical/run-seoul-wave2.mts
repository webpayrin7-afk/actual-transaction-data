/**
 * Seoul fee wave 2 dry-run.
 * Freezes the next 200 exact-safe READY Seoul complexes after wave 1.
 * No Production write. Resume reuses the frozen cohort and completed ops.
 *
 *   npx tsx scripts/mgmt-fee-canonical/run-seoul-wave2.mts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { classifyComplex, sharedKaptCodes, buildProbePeriods, choosePublishedPeriod } from "./national-inventory";
import { buildLiveCalls, type LiveCall } from "./live-calls";
import { RateLimitStop, parseFeeResponse, scrub, type ParsedOp } from "./live-parse";
import { OpCheckpointStore } from "./op-checkpoint";
import { runExpansionDryRun, type WaveTarget } from "./national-batch";
import { openReadOnlyClient, readNationalComplexes } from "./read-national-inventory";
import { assertReadOnlySql } from "./real-sample";

const DIR = resolve(import.meta.dirname, "../../data/poc/mgmt-fee-canonical");
const WAVE1_COHORT_PATH = resolve(DIR, "seoul-wave1-cohort.json");
const CHECKPOINT_PATH = resolve(DIR, "seoul-wave2-op-checkpoint.json");
const COHORT_PATH = resolve(DIR, "seoul-wave2-cohort.json");
const REPORT_PATH = resolve(DIR, "seoul-wave2-dryrun.json");
const SIDO_CODE = "11";
const SIDO_NAME = "서울특별시";
const TOTAL_CAP = 200;
const SLEEP_MS = 1000;
const PERIOD_CEILING = "202609";
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
};

let store = OpCheckpointStore.empty();
let checkpointLoaded = false;
let retryCount = 0;

function referenceCalls(): LiveCall[] {
  const calls = buildLiveCalls().filter((call) => call.in_reference);
  for (const call of calls) {
    if (OBSOLETE_OPS.has(call.op)) throw new Error(`obsolete op in reference plan: ${call.op}`);
  }
  return calls;
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

function persist(): void {
  if (!checkpointLoaded) return;
  writeFileSync(CHECKPOINT_PATH, store.serialize());
}

process.on("SIGINT", () => {
  try { persist(); } catch { /* checkpoint may not be loaded */ }
  process.exit(130);
});
process.on("SIGTERM", () => {
  try { persist(); } catch { /* checkpoint may not be loaded */ }
  process.exit(143);
});

async function fetchText(url: URL): Promise<{ status: number; body: string }> {
  let last: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(20000),
      });
      const body = await response.text();
      if (response.status === 429 || response.status >= 500) {
        last = new Error(`http ${response.status}`);
        if (attempt < 3) {
          retryCount += 1;
          await sleep(SLEEP_MS * (response.status === 429 ? 5 * attempt : attempt));
          continue;
        }
      }
      return { status: response.status, body };
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      if (name !== "AbortError" && name !== "TimeoutError") throw error;
      last = error;
      if (attempt < 3) {
        retryCount += 1;
        await sleep(SLEEP_MS);
      }
    }
  }
  throw last instanceof Error ? last : new Error("timeout");
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
  const response = await fetchText(url);
  try {
    return parseFeeResponse({ http: response.status, body: response.body, expectedKapt: kapt });
  } catch (error) {
    if (error instanceof RateLimitStop) throw error;
    throw new Error(scrub(error instanceof Error ? error.message : "fetch failed"));
  }
}

function holdReport(apiCalls: number, cohort: number): void {
  const report = {
    generated_at: new Date().toISOString(),
    wave: 2,
    region: "seoul",
    production_write: false,
    stopped: "HOLD_429",
    http_429: true,
    api_calls: apiCalls,
    reused_ops: 0,
    reuse_confirmation_api_calls: null,
    selected_sidos: [SIDO_CODE],
    complexes: cohort,
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

async function selectAndFreezeCohort(): Promise<CohortRow[]> {
  if (existsSync(COHORT_PATH)) {
    const frozen = JSON.parse(readFileSync(COHORT_PATH, "utf8")) as { complexes: CohortRow[]; selected: number };
    if (!Array.isArray(frozen.complexes) || frozen.complexes.length !== TOTAL_CAP) {
      throw new Error(`frozen cohort size ${frozen.complexes?.length}`);
    }
    return frozen.complexes;
  }
  const wave1 = JSON.parse(readFileSync(WAVE1_COHORT_PATH, "utf8")) as { complexes: Array<{ complex_id: string }> };
  const wave1Ids = new Set(wave1.complexes.map((row) => row.complex_id));
  if (wave1Ids.size !== 100) throw new Error(`wave 1 cohort ${wave1Ids.size}`);
  const db = openReadOnlyClient();
  const linkRows = await db.execute({
    sql: `SELECT complex_id, source_key, source_meta_json FROM apt_complex_source_links WHERE source = ?`,
    args: ["KAPT"],
  });
  const exactSafe = new Map<string, string>();
  for (const row of linkRows.rows) {
    const complexId = String(row.complex_id);
    const kapt = String(row.source_key);
    let tier = "";
    try {
      const meta = JSON.parse(String(row.source_meta_json ?? "{}")) as { match_tier?: string };
      tier = meta.match_tier ?? "";
    } catch {
      tier = "";
    }
    if (tier === "EXACT_SAFE" && /^A\d{8}$/.test(kapt)) exactSafe.set(complexId, kapt);
  }
  const rows = await readNationalComplexes(db);
  const shared = sharedKaptCodes(rows);
  let excludedWave1 = 0;
  let excludedCovered = 0;
  let excludedUnsafe = 0;
  const ready: Array<{ complex_id: string; kapt_code: string; sido: string; sido_code: string }> = [];
  for (const row of rows) {
    if (row.sido_code !== SIDO_CODE) continue;
    const state = classifyComplex(row, shared);
    if (row.has_fee) {
      excludedCovered += 1;
      continue;
    }
    if (state !== "READY") continue;
    const kapt = exactSafe.get(row.complex_id);
    if (!kapt || kapt !== row.kapt_codes[0]) {
      excludedUnsafe += 1;
      continue;
    }
    if (wave1Ids.has(row.complex_id)) {
      excludedWave1 += 1;
      continue;
    }
    ready.push({
      complex_id: row.complex_id,
      kapt_code: kapt,
      sido: row.sido || SIDO_NAME,
      sido_code: SIDO_CODE,
    });
  }
  if (ready.length < TOTAL_CAP) throw new Error(`eligible remaining ${ready.length}`);
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
  const selected = ranked.slice(0, TOTAL_CAP);
  if (selected.length !== TOTAL_CAP) throw new Error(`selected ${selected.length}`);
  if (selected.some((row) => wave1Ids.has(row.complex_id))) throw new Error("wave 2 overlaps wave 1");
  const body = {
    generated_at: new Date().toISOString(),
    wave: 2,
    region: "seoul",
    selected: selected.length,
    eligible_remaining: ready.length,
    excluded_wave1: excludedWave1,
    excluded_already_covered: excludedCovered,
    excluded_unsafe: excludedUnsafe,
    ready_pool: ready.length,
    bands: {
      A: selected.filter((row) => row.band === "A").length,
      B: selected.filter((row) => row.band === "B").length,
      C: selected.filter((row) => row.band === "C").length,
      D: selected.filter((row) => row.band === "D").length,
    },
    complexes: selected,
    frozen: true,
  };
  writeFileSync(COHORT_PATH, `${JSON.stringify(body, null, 2)}\n`);
  writeSync(1, `cohort eligible=${ready.length} selected=${selected.length} excluded_wave1=${excludedWave1} excluded_covered=${excludedCovered} excluded_unsafe=${excludedUnsafe}\n`);
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

async function main(): Promise<void> {
  if (process.argv.includes("--apply")) {
    console.error("refusing --apply");
    process.exit(2);
  }
  mkdirSync(DIR, { recursive: true });
  const key = process.env.MOLIT_API_KEY?.trim();
  if (!key) throw new Error("MOLIT_API_KEY missing");
  const calls = referenceCalls();
  const probe = calls.find((call) => call.op === "getHsmpCleaningCostInfoV3" && call.service === "common");
  if (!probe) throw new Error("cleaning probe missing");

  const cohort = await selectAndFreezeCohort();
  const mappingMismatch = cohort.filter((row) => !/^A\d{8}$/.test(row.kapt_code) || row.sido_code !== SIDO_CODE).length;
  const duplicateKeys =
    new Set(cohort.map((row) => row.complex_id)).size === cohort.length &&
    new Set(cohort.map((row) => row.kapt_code)).size === cohort.length
      ? 0
      : 1;
  if (cohort.length !== TOTAL_CAP || mappingMismatch !== 0 || duplicateKeys !== 0) {
    throw new Error(`cohort guard size=${cohort.length} mismatch=${mappingMismatch} duplicate=${duplicateKeys}`);
  }

  if (existsSync(CHECKPOINT_PATH)) {
    store = OpCheckpointStore.parse(readFileSync(CHECKPOINT_PATH, "utf8"));
  }
  checkpointLoaded = true;
  const checkpointIds = new Set(store.list().map((record) => record.complex_id));
  if (checkpointIds.size > 0) {
    if (
      checkpointIds.size !== cohort.length ||
      cohort.some((row) => !checkpointIds.has(row.complex_id))
    ) {
      throw new Error(`seoul wave2 resume cohort mismatch checkpoint=${checkpointIds.size} planned=${cohort.length}`);
    }
  }
  writeSync(1, `resume records=${store.list().length} cohort=${cohort.length} retries=${retryCount}\n`);

  const periods = buildProbePeriods(PERIOD_CEILING, 3);
  const targets: WaveTarget[] = [];
  let apiCalls = 0;
  for (const complex of cohort) {
    const probes: { period: string; published: boolean }[] = [];
    for (const period of periods) {
      if (!store.shouldFetch(complex.complex_id, period, probe.service, probe.op)) {
        const cached = store.get(complex.complex_id, period, probe.service, probe.op);
        probes.push({ period, published: cached?.status === "success" && (cached.amount ?? 0) > 0 });
        continue;
      }
      await sleep(SLEEP_MS);
      let parsed: ParsedOp;
      try {
        parsed = await fetchOp(key, complex.kapt_code, period, probe);
      } catch (error) {
        if (error instanceof RateLimitStop) {
          persist();
          holdReport(apiCalls, cohort.length);
          writeSync(1, `${JSON.stringify({ stopped: "HOLD_429", api_calls: apiCalls })}\n`);
          process.exit(2);
        }
        throw error;
      }
      apiCalls += 1;
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
      probes.push({ period, published: parsed.state === "success" && (parsed.amount ?? 0) > 0 });
      if (apiCalls % 10 === 0) {
        persist();
        writeSync(1, `api ${apiCalls} probe ${targets.length}\n`);
      }
    }
    const period = choosePublishedPeriod(probes);
    if (!period) continue;
    targets.push({
      complex_id: complex.complex_id,
      sido: complex.sido,
      sido_code: complex.sido_code,
      kapt_code: complex.kapt_code,
      period,
    });
    writeSync(1, `probe ${targets.length}/${cohort.length} ${complex.sido_code} ${period}\n`);
  }
  if (targets.length > TOTAL_CAP) throw new Error("target-month cap");
  const existingKeys = await existingFeeKeys(cohort.map((row) => row.complex_id));
  const dry = await runExpansionDryRun({
    targets,
    calls,
    store,
    existingKeys,
    maxTargets: TOTAL_CAP,
    sleepMs: SLEEP_MS,
    workers: 1,
    fetchOp: async (args) => {
      const parsed = await fetchOp(key, args.kapt_code, args.period, {
        op: args.op,
        service: args.service,
        service_name: calls.find((call) => call.op === args.op && call.service === args.service)?.service_name ?? "",
      });
      apiCalls += 1;
      if (apiCalls % 10 === 0) {
        persist();
        writeSync(1, `api ${apiCalls}\n`);
      }
      return parsed;
    },
    sleep: async () => sleep(SLEEP_MS),
  });
  store = dry.store;
  persist();
  let reuseConfirmation = 0;
  if (dry.stopped === "ok") {
    const terminal = dry.records.filter((record) => record.status === "COMPLETE" || record.status === "MISSING");
    const confirmTargets = targets.filter((target) =>
      terminal.some((record) => record.complex_id === target.complex_id && record.period === target.period),
    );
    const confirm = await runExpansionDryRun({
      targets: confirmTargets,
      calls,
      store,
      prior: terminal,
      maxTargets: TOTAL_CAP,
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
  const totals = dry.by_sido.reduce(
    (sum, row) => ({
      COMPLETE: sum.COMPLETE + row.COMPLETE,
      PARTIAL: sum.PARTIAL + row.PARTIAL,
      MISSING: sum.MISSING + row.MISSING,
      FAILED: sum.FAILED + row.FAILED,
      would_insert: sum.would_insert + row.would_insert,
      would_update: sum.would_update + row.would_update,
    }),
    { COMPLETE: 0, PARTIAL: 0, MISSING: 0, FAILED: 0, would_insert: 0, would_update: 0 },
  );
  const report = {
    generated_at: new Date().toISOString(),
    wave: 2,
    region: "seoul",
    production_write: false,
    api_calls: apiCalls,
    reused_ops: dry.reused_ops,
    reuse_confirmation_api_calls: dry.stopped === "ok" ? 0 : null,
    http_429: dry.stopped === "HOLD_429",
    stopped: dry.stopped,
    selected_sidos: [SIDO_CODE],
    complexes: cohort.length,
    complexes_by_sido: { "11": cohort.length },
    no_published_month: cohort.length - targets.length,
    no_published_month_by_sido: { "11": cohort.length - targets.length },
    periods: [...new Set(targets.map((target) => target.period))].sort(),
    target_months: targets.length,
    mapping_mismatch: mappingMismatch,
    duplicate_keys: duplicateKeys,
    by_sido: dry.by_sido,
    samples: dry.samples,
    totals,
    retries: retryCount,
  };
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  writeSync(1, `${JSON.stringify({ stopped: dry.stopped, api_calls: apiCalls, retries: retryCount, targets: targets.length, no_published_month: report.no_published_month, totals })}\n`);
  if (dry.stopped === "HOLD_429") process.exit(2);
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

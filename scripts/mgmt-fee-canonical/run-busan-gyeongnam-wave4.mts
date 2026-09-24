/**
 * Busan + Gyeongnam fee wave 4 dry-run.
 * Skips the wave 1, wave 2, and wave 3 cohorts. One published month. No Production write.
 *
 *   npx tsx scripts/mgmt-fee-canonical/run-busan-gyeongnam-wave4.mts
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { classifyComplex, sharedKaptCodes, buildProbePeriods, choosePublishedPeriod } from "./national-inventory";
import { buildLiveCalls, type LiveCall } from "./live-calls";
import { RateLimitStop, parseFeeResponse, scrub, type ParsedOp } from "./live-parse";
import { OpCheckpointStore } from "./op-checkpoint";
import { planNamedSidoCohort, runExpansionDryRun, type WaveTarget } from "./national-batch";
import { openReadOnlyClient, readNationalComplexes } from "./read-national-inventory";
import { assertReadOnlySql } from "./real-sample";

const DIR = resolve(import.meta.dirname, "../../data/poc/mgmt-fee-canonical");
const WAVE1_CHECKPOINT_PATH = resolve(DIR, "busan-gyeongnam-wave-op-checkpoint.json");
const WAVE1_CHECKPOINT_SHA256 = "24b446009549bf7a95aac5bf0e20f3923a5fc3dfa2b0bde638a574e697e609d8";
const WAVE2_CHECKPOINT_PATH = resolve(DIR, "busan-gyeongnam-wave2-op-checkpoint.json");
const WAVE2_CHECKPOINT_SHA256 = "7a149440cd4b3afa97fd19af93f4db6f9b6fe63d92061a88bdacec98b199c755";
const WAVE3_CHECKPOINT_PATH = resolve(DIR, "busan-gyeongnam-wave3-op-checkpoint.json");
const WAVE3_CHECKPOINT_SHA256 = "af35a9bdd84b22027aaba8dc8488b282c6469691f7a0418f25846224ea18af1f";
const CHECKPOINT_PATH = resolve(DIR, "busan-gyeongnam-wave4-op-checkpoint.json");
const REPORT_PATH = resolve(DIR, "busan-gyeongnam-wave4-dryrun.json");
const SIDO_CODES = ["26", "48"] as const;
const PER_SIDO = 100;
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

let store = OpCheckpointStore.empty();

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
  writeFileSync(CHECKPOINT_PATH, store.serialize());
}

function existsCheckpoint(): boolean {
  try {
    readFileSync(CHECKPOINT_PATH, "utf8");
    return true;
  } catch {
    return false;
  }
}

function pinnedComplexIds(path: string, hashExpected: string, label: string, expected: number): Set<string> {
  const bytes = readFileSync(path);
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== hashExpected) throw new Error(`${label} checkpoint hash mismatch`);
  const ids = new Set(OpCheckpointStore.parse(bytes.toString("utf8")).list().map((record) => record.complex_id));
  if (ids.size !== expected) throw new Error(`${label} cohort ${ids.size}`);
  return ids;
}

function priorComplexIds(): Set<string> {
  const prior = pinnedComplexIds(WAVE1_CHECKPOINT_PATH, WAVE1_CHECKPOINT_SHA256, "wave 1", 50);
  const wave2 = pinnedComplexIds(WAVE2_CHECKPOINT_PATH, WAVE2_CHECKPOINT_SHA256, "wave 2", 100);
  const wave3 = pinnedComplexIds(WAVE3_CHECKPOINT_PATH, WAVE3_CHECKPOINT_SHA256, "wave 3", 200);
  for (const [label, ids] of [["wave 2", wave2], ["wave 3", wave3]] as const) {
    for (const id of ids) {
      if (prior.has(id)) throw new Error(`${label} overlaps an earlier cohort`);
      prior.add(id);
    }
  }
  if (prior.size !== 350) throw new Error(`prior cohort ${prior.size}`);
  return prior;
}

async function fetchText(url: URL): Promise<{ status: number; body: string }> {
  let last: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(20000),
      });
      return { status: response.status, body: await response.text() };
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      if (name !== "AbortError" && name !== "TimeoutError") throw error;
      last = error;
      if (attempt < 3) await sleep(SLEEP_MS);
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
    wave: 4,
    production_write: false,
    stopped: "HOLD_429",
    http_429: true,
    api_calls: apiCalls,
    reused_ops: 0,
    reuse_confirmation_api_calls: null,
    selected_sidos: [...SIDO_CODES],
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
  const prior = priorComplexIds();
  const db = openReadOnlyClient();
  const rows = await readNationalComplexes(db);
  const shared = sharedKaptCodes(rows);
  const scoped = rows.filter((row) => (row.sido_code === "26" || row.sido_code === "48") && !prior.has(row.complex_id));
  const cohort = planNamedSidoCohort({
    complexes: scoped.map((row) => ({
      complex_id: row.complex_id,
      sido: row.sido,
      sido_code: row.sido_code,
      kapt_code: row.kapt_codes[0] ?? "",
      state: classifyComplex(row, shared),
    })),
    sidoCodes: SIDO_CODES,
    perSido: PER_SIDO,
    totalCap: TOTAL_CAP,
  });
  const bySidoCount = {
    "26": cohort.filter((row) => row.sido_code === "26").length,
    "48": cohort.filter((row) => row.sido_code === "48").length,
  };
  const mappingMismatch = cohort.filter(
    (row) => !/^A\d{8}$/.test(row.kapt_code) || shared.has(row.kapt_code) || row.state !== "READY" || prior.has(row.complex_id),
  ).length;
  const duplicateKeys = new Set(cohort.map((row) => row.complex_id)).size === cohort.length
    && new Set(cohort.map((row) => row.kapt_code)).size === cohort.length
    ? 0
    : 1;
  if (
    cohort.length > TOTAL_CAP ||
    bySidoCount["26"] > PER_SIDO ||
    bySidoCount["48"] > PER_SIDO ||
    mappingMismatch !== 0 ||
    duplicateKeys !== 0
  ) {
    throw new Error(`cohort guard complexes=${cohort.length} mismatch=${mappingMismatch} duplicate=${duplicateKeys}`);
  }
  mkdirSync(DIR, { recursive: true });
  const key = process.env.MOLIT_API_KEY?.trim();
  if (!key) throw new Error("MOLIT_API_KEY missing");
  const calls = referenceCalls();
  const probe = calls.find((call) => call.op === "getHsmpCleaningCostInfoV3" && call.service === "common");
  if (!probe) throw new Error("cleaning probe missing from reference catalog");
  store = existsCheckpoint() ? OpCheckpointStore.parse(readFileSync(CHECKPOINT_PATH, "utf8")) : OpCheckpointStore.empty();
  const resumedOverlap = store.list().filter((record) => prior.has(record.complex_id)).length;
  if (resumedOverlap !== 0) throw new Error("wave 4 checkpoint contains an earlier cohort");
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
  const byCode = new Map(dry.by_sido.map((row) => [row.sido_code, row]));
  const unpublished = {
    "26": bySidoCount["26"] - targets.filter((target) => target.sido_code === "26").length,
    "48": bySidoCount["48"] - targets.filter((target) => target.sido_code === "48").length,
  };
  const report = {
    generated_at: new Date().toISOString(),
    wave: 4,
    production_write: false,
    api_calls: apiCalls,
    reused_ops: dry.reused_ops,
    reuse_confirmation_api_calls: dry.stopped === "ok" ? 0 : null,
    http_429: dry.stopped === "HOLD_429",
    stopped: dry.stopped,
    selected_sidos: [...SIDO_CODES],
    excluded_prior: prior.size,
    complexes: cohort.length,
    complexes_by_sido: bySidoCount,
    no_published_month: cohort.length - targets.length,
    no_published_month_by_sido: unpublished,
    periods: [...new Set(targets.map((target) => target.period))].sort(),
    target_months: targets.length,
    mapping_mismatch: mappingMismatch,
    duplicate_keys: duplicateKeys,
    by_sido: ["26", "48"].map((code) => byCode.get(code) ?? {
      sido_code: code,
      sido: code === "26" ? "부산광역시" : "경상남도",
      targets: 0,
      COMPLETE: 0,
      PARTIAL: 0,
      MISSING: 0,
      FAILED: 0,
      would_insert: 0,
      would_update: 0,
    }),
    samples: dry.samples,
    totals,
  };
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  writeSync(1, `${JSON.stringify({ stopped: dry.stopped, api_calls: apiCalls, targets: targets.length, no_published_month: report.no_published_month, totals })}\n`);
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

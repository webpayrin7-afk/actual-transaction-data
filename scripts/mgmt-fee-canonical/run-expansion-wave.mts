/**
 * First expansion-wave dry-run.
 * Calls the fee API only for READY complexes in the selected non-capital sidos.
 * Does not write Production.
 *
 *   npx tsx scripts/mgmt-fee-canonical/run-expansion-wave.mts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { writeSync } from "node:fs";
import { classifyComplex, sharedKaptCodes } from "./national-inventory";
import { buildLiveCalls, type LiveCall } from "./live-calls";
import { RateLimitStop, parseFeeResponse, scrub } from "./live-parse";
import { OpCheckpointStore } from "./op-checkpoint";
import { planWaveCohort, runExpansionDryRun, type WaveTarget } from "./national-batch";
import { aggregateInventory, buildProbePeriods, choosePublishedPeriod, selectWaveSidos } from "./national-inventory";
import { openReadOnlyClient, readNationalComplexes } from "./read-national-inventory";

const DIR = resolve(import.meta.dirname, "../../data/poc/mgmt-fee-canonical");
const CHECKPOINT_PATH = resolve(DIR, "national-wave-op-checkpoint.json");
const REPORT_PATH = resolve(DIR, "national-wave-dryrun.json");
const SLEEP_MS = 1000;
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

async function main(): Promise<void> {
  if (process.argv.includes("--apply")) {
    console.error("refusing --apply");
    process.exit(2);
  }
  const db = openReadOnlyClient();
  const rows = await readNationalComplexes(db);
  const summary = aggregateInventory(rows);
  const selected = selectWaveSidos(summary.by_sido, 2);
  const shared = sharedKaptCodes(rows);
  const selectedCodes = new Set(selected.map((row) => row.sido_code));
  const cohort = planWaveCohort({
    complexes: rows
      .filter((row) => selectedCodes.has(row.sido_code))
      .map((row) => ({
        complex_id: row.complex_id,
        sido: row.sido,
        sido_code: row.sido_code,
        kapt_code: row.kapt_codes[0] ?? "",
        state: classifyComplex(row, shared),
      })),
    perSido: 25,
    totalCap: 50,
  });
  mkdirSync(DIR, { recursive: true });
  if (cohort.length === 0) {
    const report = {
      generated_at: new Date().toISOString(),
      production_write: false,
      api_calls: 0,
      reused_ops: 0,
      http_429: false,
      stopped: "no_eligible_wave",
      selected_sidos: selected.map((row) => row.sido_code),
      complexes: 0,
      periods: [] as string[],
      target_months: 0,
      by_sido: [],
      samples: [],
      totals: { COMPLETE: 0, PARTIAL: 0, MISSING: 0, FAILED: 0, would_insert: 0, would_update: 0 },
    };
    writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ stopped: report.stopped, api_calls: 0, targets: 0 }));
    return;
  }

  const key = process.env.MOLIT_API_KEY?.trim();
  if (!key) throw new Error("MOLIT_API_KEY missing");
  const calls = referenceCalls();
  const probe = calls.find((call) => call.op === "getHsmpCleaningCostInfoV3" && call.service === "common");
  if (!probe) throw new Error("cleaning probe missing from reference catalog");
  const store = existsCheckpoint()
    ? OpCheckpointStore.parse(readFileSync(CHECKPOINT_PATH, "utf8"))
    : OpCheckpointStore.empty();
  const periods = buildProbePeriods("202609", 3);
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
      const parsed = await fetchOp(key, complex.kapt_code, period, probe);
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
      writeFileSync(CHECKPOINT_PATH, store.serialize());
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
  }
  const dry = await runExpansionDryRun({
    targets,
    calls,
    store,
    sleepMs: SLEEP_MS,
    workers: 1,
    fetchOp: async (args) => {
      await sleep(SLEEP_MS);
      apiCalls += 1;
      const parsed = await fetchOp(key, args.kapt_code, args.period, {
        op: args.op,
        service: args.service,
        service_name: calls.find((call) => call.op === args.op && call.service === args.service)?.service_name ?? "",
      });
      if (apiCalls % 10 === 0) writeFileSync(CHECKPOINT_PATH, store.serialize());
      return parsed;
    },
    sleep: async () => undefined,
  });
  writeFileSync(CHECKPOINT_PATH, dry.store.serialize());
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
    production_write: false,
    api_calls: apiCalls,
    reused_ops: dry.reused_ops,
    http_429: dry.stopped === "HOLD_429",
    stopped: dry.stopped,
    selected_sidos: selected.map((row) => row.sido_code),
    complexes: cohort.length,
    periods: [...new Set(targets.map((target) => target.period))].sort(),
    target_months: targets.length,
    by_sido: dry.by_sido,
    samples: dry.samples,
    totals,
  };
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  writeSync(1, `${JSON.stringify({ stopped: dry.stopped, api_calls: apiCalls, targets: targets.length })}\n`);
  if (dry.stopped === "HOLD_429") process.exit(2);
}

function existsCheckpoint(): boolean {
  try {
    readFileSync(CHECKPOINT_PATH, "utf8");
    return true;
  } catch {
    return false;
  }
}

async function fetchOp(
  serviceKey: string,
  kapt: string,
  period: string,
  call: { op: string; service: string; service_name: string },
): Promise<ReturnType<typeof parseFeeResponse>> {
  const url = new URL(`https://apis.data.go.kr/1613000/${call.service_name}/${call.op}`);
  url.searchParams.set("serviceKey", serviceKey);
  url.searchParams.set("kaptCode", kapt);
  url.searchParams.set("searchDate", period);
  url.searchParams.set("_type", "json");
  const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20000) });
  const body = await response.text();
  try {
    return parseFeeResponse({ http: response.status, body, expectedKapt: kapt });
  } catch (error) {
    if (error instanceof RateLimitStop) throw error;
    throw new Error(scrub(error instanceof Error ? error.message : "fetch failed"));
  }
}

main().catch((error: unknown) => {
  console.error(scrub(error instanceof Error ? error.message : "wave failed"));
  process.exit(1);
});

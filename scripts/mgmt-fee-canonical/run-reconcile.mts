/**
 * Read-only reconciliation of existing apt_complex_mgmt_fee_monthly rows.
 * Calls only the reference ops confirmed in the prior sample.
 * workers=1, sleep>=1s, stop on 429. No Production writes.
 *
 *   npx tsx scripts/mgmt-fee-canonical/run-reconcile.mts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@libsql/client";
import { classifyFeeMonth } from "./classify";
import { buildLiveCalls, type LiveCall } from "./live-calls";
import {
  MappingStop,
  RateLimitStop,
  SchemaStop,
  parseFeeResponse,
  scrub,
} from "./live-parse";
import { OpCheckpointStore, type OpCheckpointRecord } from "./op-checkpoint";
import { REFERENCE_CATALOG, REFERENCE_OP_NAMES } from "./op-catalog";
import { CORRECTION_CLASSES, classifyStoredRow } from "./reconcile";
import { assertReadOnlySql } from "./real-sample";
import type { CatalogOp } from "./op-catalog";
import type { OpObservation } from "./types";

const ROOT = resolve(import.meta.dirname, "../..");
const OUT_DIR = resolve(ROOT, "data/poc/mgmt-fee-canonical");
const CHECKPOINT_PATH = resolve(OUT_DIR, "real-sample-op-checkpoint.json");
const REPORT_PATH = resolve(OUT_DIR, "reconciliation-report.json");
const SLEEP_MS = 1000;
const WORKERS = 1;

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

type StoredRow = {
  complex_id: string;
  period_yyyymm: string;
  total_fee: number | null;
  source: string | null;
  amount_basis: string | null;
};

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

function isTimeout(error: unknown): boolean {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  return name === "TimeoutError" || name === "AbortError" || /aborted due to timeout/i.test(message);
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
      if (!isTimeout(error)) throw error;
      last = error;
      log(`timeout attempt ${attempt}`);
      if (attempt < 3) await sleep(SLEEP_MS);
    }
  }
  throw last;
}

function log(line: string): void {
  writeSync(1, `${line}\n`);
}

function referenceCalls(): LiveCall[] {
  const calls = buildLiveCalls().filter((call) => call.in_reference);
  for (const call of calls) {
    if (OBSOLETE_OPS.has(call.op) && !call.in_reference) {
      throw new Error(`obsolete op in call plan: ${call.op}`);
    }
    if (OBSOLETE_OPS.has(call.op)) {
      throw new Error(`obsolete op in reference plan: ${call.op}`);
    }
  }
  return calls;
}

function observationsFor(
  catalog: readonly CatalogOp[],
  opNames: readonly string[],
  store: OpCheckpointStore,
  complex_id: string,
  period: string,
): OpObservation[] {
  return opNames.map((op) => {
    const entries = catalog.filter((entry) => entry.op === op);
    let chosen = entries[0];
    for (const entry of entries) {
      const record = store.get(complex_id, period, entry.service, entry.op);
      if (record?.status === "success") {
        chosen = entry;
        break;
      }
    }
    if (!chosen) return { op, state: "missing", amount: null };
    const record = store.get(complex_id, period, chosen.service, chosen.op);
    if (!record || record.status === "missing") return { op, state: "missing", amount: null };
    if (record.status === "failed") return { op, state: "failed", amount: null, error: record.error };
    return { op, state: "success", amount: record.amount };
  });
}

function monthReady(
  store: OpCheckpointStore,
  complex_id: string,
  period: string,
  calls: readonly LiveCall[],
): boolean {
  return calls.every((call) => store.get(complex_id, period, call.service, call.op) != null);
}

async function readSnapshot(): Promise<{ rows: StoredRow[]; links: Map<string, string> }> {
  const url = process.env.TURSO_DATABASE_URL?.trim();
  const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
  if (!url || !authToken) throw new Error("Turso env missing");
  const db = createClient({ url, authToken });
  const feeSql = `
    SELECT complex_id, period_yyyymm, total_fee, source, amount_basis
    FROM apt_complex_mgmt_fee_monthly
    ORDER BY complex_id, period_yyyymm
  `;
  assertReadOnlySql(feeSql);
  const fees = await db.execute(feeSql);
  const rows: StoredRow[] = fees.rows.map((row) => ({
    complex_id: String(row.complex_id),
    period_yyyymm: String(row.period_yyyymm),
    total_fee: row.total_fee == null ? null : Number(row.total_fee),
    source: row.source == null ? null : String(row.source),
    amount_basis: row.amount_basis == null ? null : String(row.amount_basis),
  }));
  const ids = [...new Set(rows.map((row) => row.complex_id))];
  const linkSql = `
    SELECT complex_id, source_key
    FROM apt_complex_source_links
    WHERE source = 'KAPT' AND complex_id IN (${ids.map(() => "?").join(",")})
  `;
  assertReadOnlySql(linkSql);
  const links = await db.execute({ sql: linkSql, args: ids });
  const map = new Map<string, string>();
  for (const row of links.rows) map.set(String(row.complex_id), String(row.source_key));
  return { rows, links: map };
}

async function main(): Promise<void> {
  if (process.argv.includes("--apply")) {
    console.error("refusing --apply");
    process.exit(2);
  }
  if (WORKERS !== 1 || SLEEP_MS < 1000) throw new Error("rate policy");
  const key = process.env.MOLIT_API_KEY?.trim();
  if (!key) throw new Error("MOLIT_API_KEY missing");

  const calls = referenceCalls();
  const { rows, links } = await readSnapshot();
  mkdirSync(OUT_DIR, { recursive: true });
  const store = existsSync(CHECKPOINT_PATH)
    ? OpCheckpointStore.parse(readFileSync(CHECKPOINT_PATH, "utf8"))
    : OpCheckpointStore.empty();

  let apiRequests = 0;
  let reused = 0;
  let stop: string | null = null;
  const blocked = new Set<string>();

  const persist = () => writeFileSync(CHECKPOINT_PATH, store.serialize());

  try {
    for (const row of rows) {
      const kapt = links.get(row.complex_id);
      if (!kapt || blocked.has(row.complex_id)) continue;
      for (const call of calls) {
        if (!store.shouldFetch(row.complex_id, row.period_yyyymm, call.service, call.op)) {
          reused += 1;
          continue;
        }
        await sleep(SLEEP_MS);
        const url = new URL(`https://apis.data.go.kr/1613000/${call.service_name}/${call.op}`);
        url.searchParams.set("serviceKey", key);
        url.searchParams.set("kaptCode", kapt);
        url.searchParams.set("searchDate", row.period_yyyymm);
        url.searchParams.set("_type", "json");
        const response = await fetchText(url);
        const body = response.body;
        apiRequests += 1;
        let parsed;
        try {
          parsed = parseFeeResponse({ http: response.status, body, expectedKapt: kapt });
        } catch (error) {
          if (error instanceof MappingStop) {
            blocked.add(row.complex_id);
            log(`mapping block ${row.complex_id}`);
            break;
          }
          throw error;
        }
        const record: OpCheckpointRecord = {
          complex_id: row.complex_id,
          period: row.period_yyyymm,
          op: call.op,
          service: call.service,
          status: parsed.state,
          http: parsed.http,
          result_class: parsed.result_class,
          amount: parsed.amount,
          numeric_fields: parsed.numeric_fields,
          explicit_zero_fields: parsed.explicit_zero_fields,
          error: parsed.error,
          completed_at: new Date().toISOString(),
        };
        store.put(record);
        if (apiRequests % 10 === 0) persist();
        if (apiRequests % 25 === 0) {
          log(`progress api=${apiRequests} reused=${reused} ${row.complex_id} ${row.period_yyyymm}`);
        }
      }
      if (stop) break;
    }
  } catch (error) {
    persist();
    if (error instanceof RateLimitStop) stop = scrub(error.message) || "429";
    else if (error instanceof SchemaStop) stop = `schema: ${scrub(error.message)}`;
    else throw error;
  }
  persist();

    const classified = rows.map((row) => {
    if (!links.has(row.complex_id) || blocked.has(row.complex_id)) {
      const result = classifyStoredRow({
        mapped: false,
        storedAmount: row.total_fee,
        completeness: null,
        canonicalAmount: null,
      });
      return {
        complex_id: row.complex_id,
        period_yyyymm: row.period_yyyymm,
        stored_amount: row.total_fee,
        canonical_amount: null,
        completeness: null,
        classification: blocked.has(row.complex_id) ? "ERROR" : result.classification,
        delta: null,
        failed_op_count: 0,
        missing_op_count: 0,
        source: row.source,
        amount_basis: row.amount_basis,
      };
    }
    if (!monthReady(store, row.complex_id, row.period_yyyymm, calls)) {
      return {
        complex_id: row.complex_id,
        period_yyyymm: row.period_yyyymm,
        stored_amount: row.total_fee,
        canonical_amount: null,
        completeness: null,
        classification: "ERROR" as const,
        delta: null,
        failed_op_count: 0,
        missing_op_count: 0,
        source: row.source,
        amount_basis: row.amount_basis,
      };
    }
    const month = classifyFeeMonth({
      complex_id: row.complex_id,
      period_yyyymm: row.period_yyyymm,
      expectedOps: REFERENCE_OP_NAMES,
      observations: observationsFor(
        REFERENCE_CATALOG,
        REFERENCE_OP_NAMES,
        store,
        row.complex_id,
        row.period_yyyymm,
      ),
    });
    const completeness = month.result?.completeness ?? (month.checkpoint_status === "FAILED" ? "FAILED" : null);
    const judged = classifyStoredRow({
      mapped: true,
      storedAmount: row.total_fee,
      completeness,
      canonicalAmount: month.amount,
    });
    return {
      complex_id: row.complex_id,
      period_yyyymm: row.period_yyyymm,
      stored_amount: row.total_fee,
      canonical_amount: month.amount,
      completeness: month.result?.completeness ?? null,
      classification: judged.classification,
      delta: judged.delta,
      failed_op_count: month.failed_ops.length,
      missing_op_count: month.missing_ops.length,
      source: row.source,
      amount_basis: row.amount_basis,
    };
  });

  const count = (name: string) => classified.filter((row) => row.classification === name).length;
  const storedTotal = classified.reduce((sum, row) => sum + (row.stored_amount ?? 0), 0);
  const canonicalTotal = classified.reduce((sum, row) => {
    if (row.completeness !== "COMPLETE" || row.canonical_amount == null) return sum;
    return sum + row.canonical_amount;
  }, 0);
  const report = {
    generated_at: new Date().toISOString(),
    workers: WORKERS,
    sleep_ms: SLEEP_MS,
    stop,
    http_429: stop != null && /429|quota/i.test(stop),
    api_requests: apiRequests,
    reused_ops: reused,
    reference_calls_per_month: calls.length,
    complexes: new Set(rows.map((row) => row.complex_id)).size,
    rows: rows.length,
    periods: [...new Set(rows.map((row) => row.period_yyyymm))].sort(),
    handoff_expected: { complexes: 11, rows: 126 },
    summary: {
      total_rows: classified.length,
      EXACT_MATCH: count("EXACT_MATCH"),
      UNDERCOUNT: count("UNDERCOUNT"),
      OVERCOUNT: count("OVERCOUNT"),
      STORED_ZERO_BUT_MISSING: count("STORED_ZERO_BUT_MISSING"),
      STORED_VALUE_BUT_MISSING: count("STORED_VALUE_BUT_MISSING"),
      PARTIAL_SOURCE: count("PARTIAL_SOURCE"),
      MAPPING_BLOCKED: count("MAPPING_BLOCKED"),
      ERROR: count("ERROR"),
      stored_total: storedTotal,
      canonical_complete_total: canonicalTotal,
      correction_candidate_rows: classified.filter((row) => CORRECTION_CLASSES.has(row.classification)).length,
    },
    production_write: false,
    rows_detail: classified,
  };
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  log(JSON.stringify({ stop, api_requests: apiRequests, reused_ops: reused, summary: report.summary }));
  if (stop && /429|quota/i.test(stop)) process.exit(2);
  if (stop) process.exit(3);
}

main().catch((error: unknown) => {
  console.error(scrub(error instanceof Error ? error.message : String(error)));
  process.exit(1);
});

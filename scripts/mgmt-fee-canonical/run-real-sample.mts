/**
 * Real-sample fee dry-run. One worker, sleep >= 1s, stop on 429.
 * Reads existing totals. Does not insert, update, or delete.
 *
 *   npx tsx scripts/mgmt-fee-canonical/run-real-sample.mts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@libsql/client";
import { classifyFeeMonth } from "./classify";
import { buildLiveCalls, type LiveCall } from "./live-calls";
import { parseFeeResponse, RateLimitStop, SchemaStop, MappingStop, scrub } from "./live-parse";
import { OpCheckpointStore, type OpCheckpointRecord } from "./op-checkpoint";
import { MAIN_CATALOG, MAIN_OP_NAMES, REFERENCE_CATALOG, REFERENCE_OP_NAMES } from "./op-catalog";
import { assertSampleScope, assertReadOnlySql, REAL_SAMPLE_TARGETS, type RealSampleTarget } from "./real-sample";
import type { CatalogOp } from "./op-catalog";
import type { OpObservation } from "./types";

const ROOT = resolve(import.meta.dirname, "../..");
const OUT_DIR = resolve(ROOT, "data/poc/mgmt-fee-canonical");
const SLEEP_MS = 1000;
const WORKERS = 1;

type ExistingFee = {
  complex_id: string;
  period_yyyymm: string;
  total_fee: number | null;
  source: string | null;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
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
    if (record.status === "failed") {
      return { op, state: "failed", amount: null, error: record.error };
    }
    return { op, state: "success", amount: record.amount };
  });
}

async function readExisting(targets: readonly RealSampleTarget[]): Promise<ExistingFee[]> {
  const url = process.env.TURSO_DATABASE_URL?.trim();
  const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
  if (!url || !authToken) throw new Error("Turso env missing");
  const ids = [...new Set(targets.map((target) => target.complex_id))];
  const periods = [...new Set(targets.map((target) => target.period_yyyymm))];
  const sql = `
    SELECT l.complex_id AS link_complex_id, l.source_key,
           f.complex_id AS fee_complex_id, f.period_yyyymm, f.total_fee, f.source
    FROM apt_complex_source_links l
    LEFT JOIN apt_complex_mgmt_fee_monthly f
      ON f.complex_id = l.complex_id
     AND f.period_yyyymm IN (${periods.map(() => "?").join(",")})
    WHERE l.source = 'KAPT' AND l.complex_id IN (${ids.map(() => "?").join(",")})
  `;
  assertReadOnlySql(sql);
  const db = createClient({ url, authToken });
  const result = await db.execute({ sql, args: [...periods, ...ids] });
  const links = new Map<string, string>();
  const fees: ExistingFee[] = [];
  for (const row of result.rows) {
    const complex_id = String(row.link_complex_id);
    links.set(complex_id, String(row.source_key));
    if (row.fee_complex_id != null && row.period_yyyymm != null) {
      fees.push({
        complex_id,
        period_yyyymm: String(row.period_yyyymm),
        total_fee: row.total_fee == null ? null : Number(row.total_fee),
        source: row.source == null ? null : String(row.source),
      });
    }
  }
  for (const target of targets) {
    const linked = links.get(target.complex_id);
    if (!linked || linked !== target.kapt_code) {
      throw new MappingStop(`source link mismatch for ${target.complex_id}`);
    }
  }
  return fees;
}

function usefulCalls(calls: LiveCall[], records: OpCheckpointRecord[], side: "main" | "reference"): string[] {
  const names = new Set<string>();
  for (const call of calls) {
    if (side === "main" ? !call.in_main || call.in_reference : !call.in_reference || call.in_main) {
      continue;
    }
    const hit = records.some(
      (record) =>
        record.service === call.service &&
        record.op === call.op &&
        record.status === "success" &&
        record.amount != null,
    );
    if (hit) names.add(`${call.service}:${call.op}`);
  }
  return [...names].sort();
}

function neverSucceeded(calls: LiveCall[], records: OpCheckpointRecord[]): string[] {
  const out: string[] = [];
  for (const call of calls) {
    const rows = records.filter((record) => record.service === call.service && record.op === call.op);
    if (rows.length === 0) continue;
    if (rows.every((record) => record.status !== "success")) {
      out.push(`${call.service}:${call.op}`);
    }
  }
  return out.sort();
}

async function main(): Promise<void> {
  if (process.argv.includes("--apply")) {
    console.error("refusing --apply");
    process.exit(2);
  }
  if (WORKERS !== 1) throw new Error("workers must be 1");
  if (SLEEP_MS < 1000) throw new Error("sleep must be >= 1000");

  const key = process.env.MOLIT_API_KEY?.trim();
  if (!key) throw new Error("MOLIT_API_KEY missing");

  const targets = REAL_SAMPLE_TARGETS;
  assertSampleScope(targets);
  const calls = buildLiveCalls();
  mkdirSync(OUT_DIR, { recursive: true });
  const checkpointPath = resolve(OUT_DIR, "real-sample-op-checkpoint.json");
  const reportPath = resolve(OUT_DIR, "real-sample-report.json");
  const store = existsSync(checkpointPath)
    ? OpCheckpointStore.parse(readFileSync(checkpointPath, "utf8"))
    : OpCheckpointStore.empty();

  const existing = await readExisting(targets);
  const existingKey = new Set(existing.map((row) => `${row.complex_id}|${row.period_yyyymm}`));

  let apiRequests = 0;
  let reused = 0;
  let stop: string | null = null;

  const persist = () => {
    writeFileSync(checkpointPath, store.serialize(), "utf8");
  };

  try {
    for (const target of targets) {
      for (const call of calls) {
        if (!store.shouldFetch(target.complex_id, target.period_yyyymm, call.service, call.op)) {
          reused += 1;
          continue;
        }
        await sleep(SLEEP_MS);
        const url = new URL(
          `https://apis.data.go.kr/1613000/${call.service_name}/${call.op}`,
        );
        url.searchParams.set("serviceKey", key);
        url.searchParams.set("kaptCode", target.kapt_code);
        url.searchParams.set("searchDate", target.period_yyyymm);
        url.searchParams.set("_type", "json");
        const response = await fetch(url, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(20000),
        });
        const body = await response.text();
        apiRequests += 1;
        const parsed = parseFeeResponse({
          http: response.status,
          body,
          expectedKapt: target.kapt_code,
        });
        const record: OpCheckpointRecord = {
          complex_id: target.complex_id,
          period: target.period_yyyymm,
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
        persist();
        console.log(
          `${target.complex_id} ${target.period_yyyymm} ${call.service}:${call.op} ${parsed.http} ${parsed.result_class}`,
        );
      }
    }
  } catch (error) {
    persist();
    if (error instanceof RateLimitStop) stop = "429";
    else if (error instanceof SchemaStop) stop = `schema: ${scrub(error.message)}`;
    else if (error instanceof MappingStop) stop = `mapping: ${scrub(error.message)}`;
    else throw error;
  }

  const months = targets.map((target) => {
    const ready = calls.every(
      (call) => store.get(target.complex_id, target.period_yyyymm, call.service, call.op) != null,
    );
    if (!ready) {
      return {
        complex_id: target.complex_id,
        period_yyyymm: target.period_yyyymm,
        region: target.region,
        ready: false,
        completeness: null,
        amount: null,
        main_completeness: null,
        presence: existingKey.has(`${target.complex_id}|${target.period_yyyymm}`)
          ? "EXISTING"
          : "NEW",
        action: "skip",
      };
    }
    const reference = classifyFeeMonth({
      complex_id: target.complex_id,
      period_yyyymm: target.period_yyyymm,
      expectedOps: REFERENCE_OP_NAMES,
      observations: observationsFor(
        REFERENCE_CATALOG,
        REFERENCE_OP_NAMES,
        store,
        target.complex_id,
        target.period_yyyymm,
      ),
    });
    const main = classifyFeeMonth({
      complex_id: target.complex_id,
      period_yyyymm: target.period_yyyymm,
      expectedOps: MAIN_OP_NAMES,
      observations: observationsFor(
        MAIN_CATALOG,
        MAIN_OP_NAMES,
        store,
        target.complex_id,
        target.period_yyyymm,
      ),
    });
    const presence = existingKey.has(`${target.complex_id}|${target.period_yyyymm}`)
      ? "EXISTING"
      : "NEW";
    const completeness = reference.result?.completeness ?? null;
    const action =
      reference.checkpoint_status === "COMPLETE"
        ? presence === "EXISTING"
          ? "update"
          : "insert"
        : "skip";
    return {
      complex_id: target.complex_id,
      period_yyyymm: target.period_yyyymm,
      region: target.region,
      ready: true,
      completeness,
      amount: reference.amount,
      checkpoint_status: reference.checkpoint_status,
      successful_ops: reference.successful_ops.length,
      failed_ops: reference.failed_ops,
      missing_ops: reference.missing_ops,
      main_completeness: main.result?.completeness ?? null,
      main_amount: main.amount,
      presence,
      action,
      explicit_zero_ops: store
        .list()
        .filter(
          (record) =>
            record.complex_id === target.complex_id &&
            record.period === target.period_yyyymm &&
            record.explicit_zero_fields.length > 0,
        )
        .map((record) => record.op),
    };
  });

  const comparisons = months.map((month) => {
    const oldRow = existing.find(
      (row) => row.complex_id === month.complex_id && row.period_yyyymm === month.period_yyyymm,
    );
    const old = oldRow ? oldRow.total_fee : null;
    const changed =
      oldRow != null && month.ready && (month.action === "update" ? old !== month.amount : old === 0 && month.completeness === "MISSING");
    return {
      complex_id: month.complex_id,
      period: month.period_yyyymm,
      presence: month.presence,
      old,
      new: month.amount,
      completeness: month.completeness,
      old_source: oldRow?.source ?? null,
      changed,
      overwrite_executed: false,
    };
  });

  const records = store.list();
  const report = {
    generated_at: new Date().toISOString(),
    workers: WORKERS,
    sleep_ms: SLEEP_MS,
    stop,
    api_requests: apiRequests,
    reused_ops: reused,
    http_429: stop === "429",
    complexes: [...new Set(targets.map((target) => target.complex_id))].length,
    periods: [...new Set(targets.map((target) => target.period_yyyymm))],
    target_months: targets.length,
    calls_per_month: calls.length,
    counts: {
      COMPLETE: months.filter((month) => month.completeness === "COMPLETE").length,
      PARTIAL: months.filter((month) => month.completeness === "PARTIAL").length,
      MISSING: months.filter((month) => month.completeness === "MISSING").length,
      ERROR: months.filter((month) => !month.ready || month.checkpoint_status === "FAILED").length,
    },
    would_insert: months.filter((month) => month.action === "insert").length,
    would_update: months.filter((month) => month.action === "update").length,
    would_skip: months.filter((month) => month.action === "skip").length,
    months,
    comparisons,
    catalog: {
      phase71c_only_useful: usefulCalls(calls, records, "main"),
      phase26_only_useful: usefulCalls(calls, records, "reference"),
      never_succeeded: neverSucceeded(calls, records),
    },
    production_write: false,
  };
  writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
  console.log(
    JSON.stringify(
      {
        stop: report.stop,
        api_requests: report.api_requests,
        reused_ops: report.reused_ops,
        counts: report.counts,
        would_insert: report.would_insert,
        would_update: report.would_update,
        would_skip: report.would_skip,
      },
      null,
      2,
    ),
  );
  if (stop === "429") process.exit(2);
  if (stop) process.exit(3);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(scrub(message));
  process.exit(1);
});

/**
 * Read-only progress summary for the province closeout driver.
 *
 *   npx tsx scripts/mgmt-fee-canonical/report-province-progress.mts [--driver-status=TEXT]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PROVINCES, provinceArtifactPrefix } from "./provinces";
import { openReadOnlyClient } from "./read-national-inventory";
import { assertReadOnlySql } from "./real-sample";

const DIR = resolve(import.meta.dirname, "../../data/poc/mgmt-fee-canonical");
const OUT_PATH = resolve(DIR, "provinces-progress.json");

function readJson(path: string): Record<string, any> | null {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, any>) : null;
}

async function main(): Promise<void> {
  const statusArg = process.argv.find((value) => value.startsWith("--driver-status="));
  const db = openReadOnlyClient();
  const totalsSql = "SELECT COUNT(*) AS n, COUNT(DISTINCT complex_id) AS c FROM apt_complex_mgmt_fee_monthly";
  assertReadOnlySql(totalsSql);
  const totals = await db.execute(totalsSql);
  const provinces = PROVINCES.map((province) => {
    const prefix = provinceArtifactPrefix(province);
    const cohort = readJson(resolve(DIR, `${prefix}-cohort.json`));
    const state = readJson(resolve(DIR, `${prefix}-segment-state.json`));
    const dry = readJson(resolve(DIR, `${prefix}-dryrun.json`));
    const apply = readJson(resolve(DIR, `${prefix}-apply-result.json`));
    const classifications = Object.values((state?.classifications ?? {}) as Record<string, string>);
    const count = (status: string) => classifications.filter((value) => value === status).length;
    const phase =
      apply?.status === "PASS" ? "APPLIED" :
      apply?.status ? `APPLY_${apply.status}` :
      dry?.cohort_terminal ? `DRYRUN_${dry.gate}` :
      state ? (dry?.stopped === "HOLD_429" ? "ACQUIRE_QUOTA_HOLD" : "ACQUIRING") :
      cohort ? "FROZEN" : "PENDING";
    return {
      province: province.slug,
      sido_code: province.sido_code,
      sido: province.sido,
      phase,
      cohort: cohort?.selected ?? null,
      terminal: classifications.length,
      unfinished: state?.unfinished_complex_ids?.length ?? null,
      COMPLETE: count("COMPLETE"),
      NO_PUBLISHED_MONTH: count("NO_PUBLISHED_MONTH"),
      PARTIAL: count("PARTIAL"),
      MISSING: count("MISSING"),
      FAILED: count("FAILED"),
      IDENTITY_CONFLICT: count("IDENTITY_CONFLICT"),
      api_calls: state?.api_calls ?? 0,
      http_429: state?.http_429 ?? 0,
      retries: state?.retries ?? 0,
      dryrun_gate: dry?.cohort_terminal ? dry.gate : null,
      applied_rows: apply?.status === "PASS" ? apply.inserted ?? 0 : 0,
    };
  });
  const body = {
    generated_at: new Date().toISOString(),
    driver_status: statusArg ? statusArg.slice("--driver-status=".length) : null,
    fee_table: { rows: Number(totals.rows[0]?.n), complexes: Number(totals.rows[0]?.c) },
    api_calls_total: provinces.reduce((sum, row) => sum + row.api_calls, 0),
    applied_rows_total: provinces.reduce((sum, row) => sum + row.applied_rows, 0),
    provinces,
  };
  writeFileSync(OUT_PATH, `${JSON.stringify(body, null, 2)}\n`);
  console.log(JSON.stringify({ fee_table: body.fee_table, api_calls_total: body.api_calls_total, applied_rows_total: body.applied_rows_total }));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "progress failed");
  process.exit(1);
});

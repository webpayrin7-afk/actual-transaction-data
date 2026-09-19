/**
 * Write correction and rollback manifests from the reconciliation artifact
 * and the read-only before snapshot. Does not call the fee API or open a database.
 *
 *   npx tsx scripts/mgmt-fee-canonical/build-correction-manifest.mts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildCorrectionPlan, type FeeRowSnapshot, type ReconciledRow } from "./correction-plan";

const ROOT = resolve(import.meta.dirname, "../..");
const DIR = resolve(ROOT, "data/poc/mgmt-fee-canonical");

function main(): void {
  if (process.argv.includes("--apply")) {
    console.error("refusing --apply");
    process.exit(2);
  }
  const report = JSON.parse(readFileSync(resolve(DIR, "reconciliation-report.json"), "utf8")) as {
    generated_at: string;
    rows_detail: ReconciledRow[];
  };
  const snapshot = JSON.parse(readFileSync(resolve(DIR, "correction-before-snapshot.json"), "utf8")) as {
    rows: FeeRowSnapshot[];
  };
  const built = buildCorrectionPlan({
    reconciled: report.rows_detail,
    snapshots: snapshot.rows,
    updatedAt: report.generated_at,
    expect: { exact: 72, update: 52, delete: 2 },
  });
  writeFileSync(resolve(DIR, "correction-manifest.json"), `${JSON.stringify(built.correction, null, 2)}\n`);
  writeFileSync(resolve(DIR, "rollback-manifest.json"), `${JSON.stringify(built.rollback, null, 2)}\n`);
  console.log(
    JSON.stringify({
      correction_hash: built.correction.hash,
      rollback_hash: built.rollback.hash,
      update: built.correction.summary.UPDATE,
      delete: built.correction.summary.DELETE,
      exact_untouched: built.correction.guards.exact_match_untouched,
    }),
  );
}

main();

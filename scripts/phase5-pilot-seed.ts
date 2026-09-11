/**
 * Phase 5 pilot seed — unit-type master tables only.
 *
 * Default: dry-run (no DB write).
 * Write:   npx tsx scripts/phase5-pilot-seed.ts --write
 */
import { PHASE5_PILOT_COMPLEXES } from "../src/lib/unit-type/pilot";
import {
  dryRunPilotRowCounts,
  loadPhase4Bundle,
} from "../src/lib/unit-type/from-phase4";
import {
  ensureUnitTypeSchema,
  replacePilotMasterBundles,
} from "../src/lib/unit-type/repository";
import { getDb } from "../src/lib/db/client";

async function main() {
  const write = process.argv.includes("--write");
  const counts = dryRunPilotRowCounts();
  console.log("=== Phase 5 pilot dry-run ===");
  console.log(
    JSON.stringify(
      {
        production_db_write: write,
        transactions_mutation: false,
        nationwide_backfill: false,
        expected_rows: {
          apt_complex_classifications: counts.classifications,
          apt_unit_types: counts.unitTypes,
          apt_pyeong_groups: counts.groups,
          apt_unit_type_group_links: counts.links,
        },
        byComplex: counts.byComplex,
      },
      null,
      2,
    ),
  );

  if (!write) {
    console.log(
      "\nDry-run only. Re-run with --write to insert pilot master rows.",
    );
    return;
  }

  const db = getDb();
  if (!db) throw new Error("TURSO_DATABASE_URL not configured");
  await ensureUnitTypeSchema(db);
  const bundles = PHASE5_PILOT_COMPLEXES.map((p) => loadPhase4Bundle(p));
  const written = await replacePilotMasterBundles(bundles, db);
  console.log("\n=== Phase 5 pilot write complete ===");
  console.log(JSON.stringify(written, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

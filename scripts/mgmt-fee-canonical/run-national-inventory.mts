/**
 * Read-only national KAPT coverage inventory. Counts by sido only.
 *
 *   npx tsx scripts/mgmt-fee-canonical/run-national-inventory.mts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { aggregateInventory, selectWaveSidos } from "./national-inventory";
import { openReadOnlyClient, readNationalComplexes } from "./read-national-inventory";

const OUT = resolve(import.meta.dirname, "../../data/poc/mgmt-fee-canonical/national-kapt-inventory.json");

async function main(): Promise<void> {
  const db = openReadOnlyClient();
  const rows = await readNationalComplexes(db);
  const summary = aggregateInventory(rows);
  const selected = selectWaveSidos(summary.by_sido, 2);
  const body = {
    generated_at: new Date().toISOString(),
    production_write: false,
    national: summary.national,
    by_sido: summary.by_sido,
    wave_candidates: selected.map((row) => ({
      sido: row.sido,
      sido_code: row.sido_code,
      kapt_mapped: row.kapt_mapped,
      coverage_pct: row.coverage_pct,
      ready_unloaded: row.ready_unloaded,
    })),
    wave_excluded_sido_codes: ["11", "41"],
  };
  mkdirSync(resolve(OUT, ".."), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(body, null, 2)}\n`);
  console.log(
    JSON.stringify({
      master: summary.national.master,
      kapt_mapped: summary.national.kapt_mapped,
      ready_unloaded: summary.national.ready_unloaded,
      sidos: summary.by_sido.map((row) => row.sido_code),
      wave: selected.map((row) => row.sido_code),
    }),
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "inventory failed");
  process.exit(1);
});

/**
 * READ-only: rent API page-1 metadata for historical backfill sizing. WRITE 0.
 * 1 API call per (code, month) cell.
 *
 *   npx tsx scripts/probe-rent-backfill.ts --codes=11710,11680 --months=201012,201101,201506
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { fetchMonthMeta } from "../src/lib/molit/client";

function argValue(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

async function main() {
  const codes = argValue("codes", "11710").split(",").filter(Boolean);
  const months = argValue("months", "201101,201506").split(",").filter(Boolean);
  let calls = 0;
  let pages = 0;
  for (const code of codes) {
    for (const ym of months) {
      calls += 1;
      try {
        const meta = await fetchMonthMeta("rent", code, ym);
        pages += meta.pagesNeeded;
        console.log(
          `[probe] rent ${code} ${ym} total=${meta.totalCount} page1=${meta.page1Count} pages=${meta.pagesNeeded} empty=${meta.empty ? 1 : 0}`,
        );
      } catch (err) {
        console.log(
          `[probe] rent ${code} ${ym} ERROR ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }
  console.log(`[probe] SUMMARY apiCalls=${calls} pagesNeededForFullSync=${pages}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

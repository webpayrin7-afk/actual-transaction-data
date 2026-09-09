/**
 * READ-ONLY latency: available months + month-scoped history.
 *   npx tsx scripts/bench-region-months.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { clearRegionDailyCaches, getRegionDaily } from "../src/lib/molit/service";

async function time(label: string, fn: () => Promise<unknown>) {
  const t0 = performance.now();
  await fn();
  const ms = Math.round(performance.now() - t0);
  console.log(JSON.stringify({ label, ms }));
}

async function main() {
  clearRegionDailyCaches();
  await time("gangnam-202003-cold", () =>
    getRegionDaily({ regionSlug: "seoul-gangnam", part: "history", yearMonth: "202003" }),
  );
  await time("gangnam-202003-warm", () =>
    getRegionDaily({ regionSlug: "seoul-gangnam", part: "history", yearMonth: "202003" }),
  );
  clearRegionDailyCaches();
  await time("seongnam-202609-cold", () =>
    getRegionDaily({
      regionSlug: "gyeonggi-seongnam",
      part: "history",
      yearMonth: "202609",
    }),
  );
  await time("seongnam-202608-warm-months", () =>
    getRegionDaily({
      regionSlug: "gyeonggi-seongnam",
      part: "history",
      yearMonth: "202608",
    }),
  );
  clearRegionDailyCaches();
  await time("suwon-202003-cold", () =>
    getRegionDaily({
      regionSlug: "gyeonggi-suwon",
      part: "history",
      yearMonth: "202003",
    }),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

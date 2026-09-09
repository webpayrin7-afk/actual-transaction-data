/**
 * Cold-cache region-daily timings. READ ONLY.
 *   npx tsx scripts/profile-region-daily-cold.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import {
  clearRegionDailyCaches,
  getRegionDaily,
  startRegionDailyProfile,
  takeRegionDailyProfile,
  type RegionDailyResponse,
} from "../src/lib/molit/service";

const SLUGS = [
  "seoul-yongsan",
  "seoul-gangnam",
  "seoul-songpa",
  "gyeonggi-seongnam",
  "gyeonggi-suwon",
];

function jsonBytes(payload: RegionDailyResponse): number {
  return Buffer.byteLength(JSON.stringify(payload));
}

async function coldPart(
  slug: string,
  part: "market" | "latest" | "history",
) {
  clearRegionDailyCaches();
  startRegionDailyProfile();
  const t0 = performance.now();
  const data = await getRegionDaily({ regionSlug: slug, part });
  const wall = Math.round(performance.now() - t0);
  const profile = takeRegionDailyProfile();
  return {
    part,
    wall,
    bytes: jsonBytes(data),
    monthTradeCount: data.monthTradeCount,
    tradeCount: data.tradeCount,
    selectedDate: data.selectedDate,
    historyTotalCount: data.historyTotalCount,
    profile,
  };
}

async function coldPage(slug: string) {
  clearRegionDailyCaches();
  const t0 = performance.now();
  const [market, latest, history] = await Promise.all([
    getRegionDaily({ regionSlug: slug, part: "market" }),
    getRegionDaily({ regionSlug: slug, part: "latest" }),
    getRegionDaily({ regionSlug: slug, part: "history" }),
  ]);
  const wall = Math.round(performance.now() - t0);
  return {
    wall,
    bytes: jsonBytes(market) + jsonBytes(latest) + jsonBytes(history),
    marketTrades: market.monthTradeCount,
    heroTrades: latest.tradeCount,
    historyTotal: history.historyTotalCount,
  };
}

async function warmPage(slug: string) {
  const t0 = performance.now();
  await Promise.all([
    getRegionDaily({ regionSlug: slug, part: "market" }),
    getRegionDaily({ regionSlug: slug, part: "latest" }),
    getRegionDaily({ regionSlug: slug, part: "history" }),
  ]);
  return Math.round(performance.now() - t0);
}

async function main() {
  console.log(`profile-region-daily-cold ${new Date().toISOString()}`);
  for (const slug of SLUGS) {
    console.log(`\n=== ${slug} ===`);
    const market = await coldPart(slug, "market");
    const latest = await coldPart(slug, "latest");
    const history = await coldPart(slug, "history");
    const page = await coldPage(slug);
    const warm = await warmPage(slug);
    console.log(
      JSON.stringify(
        { market, latest, history, pageCold: page, pageWarmMs: warm },
        null,
        2,
      ),
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

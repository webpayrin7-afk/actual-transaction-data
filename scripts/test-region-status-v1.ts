/**
 * Region Status IA reset + Price Position regional binding checks.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getDb } from "../src/lib/db/client";
import { publishedRegionRanking } from "../src/lib/region-ranking/query";
import { RANKING_V3_VERSION } from "../src/lib/region-ranking/ranking-v3";
import { readRegionalPricePosition } from "../src/lib/region-ranking/region-price-read";
import { PRICE_POSITION_PUBLIC_VERSION } from "../src/lib/region-ranking/price-position-read";
import { formatWonPerPyeong } from "../src/lib/region-ranking/public";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const daily = readFileSync(
  resolve(import.meta.dirname, "../src/components/RegionDailyStatus.tsx"),
  "utf8",
);
assert(daily.includes("RegionStatusHero"), "hero");
assert(daily.includes("RegionMarketSummary"), "market");
assert(daily.includes("RegionPriceTrendSection"), "trend");
assert(daily.includes("RegionLeaderboard"), "ranking");
assert(daily.includes("RegionRecentTransactions"), "tx");
assert(daily.includes("RegionSupplySection"), "supply");
assert(daily.includes("parentLabel"), "hierarchy parent nav");
assert(daily.includes("hideScopeToggle"), "no primary GU/DONG buttons");
assert(!daily.includes("RegionDecadeSelector"), "no primary decade stack");
assert(!daily.includes("onDecadeSelect"), "price/ranking cohorts separated");
assert(!daily.includes("지역 평균 평당가"), "forbidden avg label");
const mainReturn = daily.slice(daily.lastIndexOf("  return (\n    <div className=\"flex min-h-"));
assert(mainReturn.includes("RegionMarketSummary"), "main has market");
assert(!mainReturn.includes("<MonthNav"), "no MonthNav in status return");
assert(!mainReturn.includes("RegionDecadeSelector"), "no decade stack in return");
assert(mainReturn.indexOf("RegionMarketSummary") < mainReturn.indexOf("RegionPriceTrendSection"), "price before trend");
assert(mainReturn.indexOf("RegionPriceTrendSection") < mainReturn.indexOf("RegionLeaderboard"), "trend before ranking");
assert(mainReturn.indexOf("RegionLeaderboard") < mainReturn.indexOf("RegionRecentTransactions"), "ranking before tx");
assert(mainReturn.indexOf("RegionRecentTransactions") < mainReturn.indexOf("RegionSupplySection"), "tx before supply");

const sections = readFileSync(
  resolve(import.meta.dirname, "../src/components/region/RegionStatusSections.tsx"),
  "utf8",
);
assert(sections.includes("지역 대표 평당가"), "rep price label");
assert(sections.includes("최근 실거래 기준"), "basis");
assert(sections.includes("RegionPriceCohortSelector"), "compact cohort");
assert(sections.includes("variant=\"compact\""), "compact lab tabs");
assert(sections.includes("comparisons"), "parent price context");
assert(sections.includes("이번 달"), "volume on recent tx");
assert(!sections.includes("role=\"tablist\"\n          aria-label=\"지역 범위\""), "no GU/DONG primary tabs");

const read = readFileSync(
  resolve(import.meta.dirname, "../src/lib/region-ranking/region-price-read.ts"),
  "utf8",
);
assert(read.includes("MEDIAN_OF_COMPLEX_MEANS"), "median methodology note");
assert(read.includes("extractComplexMean"), "complex-mean read");
assert(!read.includes("pickCell(hit.body, scope)"), "no host SAME_MONTH cell");

const db = getDb();
if (!db) {
  console.log("ok: region-status-ia (structural; no db)");
  process.exit(0);
}

async function main() {
  const complexId = "cx_4c63d9a100973c60";
  const gu = "11710";
  const dong = "1171010100";
  const COMPLEX_GOLDEN = 10075.7576;
  const DONG_GOLDEN = 9006.3025;
  const GU_GOLDEN = 4154.8387;
  const SEOUL_GOLDEN = 2838.2353;

  for (const [code, band, expected] of [
    [gu, "ALL", 10],
    [dong, "ALL", 2],
    [gu, "30", 5],
    [dong, "30", 4],
  ] as const) {
    const board = await publishedRegionRanking(db!, {
      regionCode: code,
      areaBand: band,
      limit: 20,
    });
    assert("published" in board && board.published, `rank published ${code} ${band}`);
    assert(board.rankingVersion === RANKING_V3_VERSION, `rank version ${code} ${band}`);
    const hit = board.rows.find((r) => r.complexId === complexId);
    assert(hit?.rank === expected, `els ${code} ${band} = ${expected} got ${hit?.rank}`);
  }

  const dongPrice = await readRegionalPricePosition(db!, {
    regionCode: dong,
    areaBand: "30",
    preferredComplexId: complexId,
  });
  assert(dongPrice.status === "ok", "dong price ok");
  if (dongPrice.status === "ok") {
    assert(dongPrice.version === PRICE_POSITION_PUBLIC_VERSION, "public version");
    assert(dongPrice.scope === "DONG", "dong scope");
    assert(dongPrice.price.scope === "DONG", "cell DONG");
    assert(dongPrice.referenceMonth === null, "referenceMonth null");
    const mean = dongPrice.price.meanPricePerSupplyPyeong!;
    assert(
      Math.abs(mean - DONG_GOLDEN) < 0.001,
      `jamsil 30p main ${mean} ≈ ${DONG_GOLDEN}`,
    );
    assert(
      Math.abs(mean - COMPLEX_GOLDEN) > 1,
      "complex price must not leak as dong main",
    );
    assert(
      formatWonPerPyeong(mean) === "9,006만원/평",
      `display ${formatWonPerPyeong(mean)}`,
    );
    const guCmp = dongPrice.comparisons.find((c) => c.scope === "GU");
    const seoulCmp = dongPrice.comparisons.find((c) => c.scope === "SEOUL");
    assert(
      guCmp && Math.abs((guCmp.meanPricePerSupplyPyeong ?? 0) - GU_GOLDEN) < 0.001,
      `gu compare ${guCmp?.meanPricePerSupplyPyeong}`,
    );
    assert(
      seoulCmp &&
        Math.abs((seoulCmp.meanPricePerSupplyPyeong ?? 0) - SEOUL_GOLDEN) < 1,
      `seoul compare ${seoulCmp?.meanPricePerSupplyPyeong}`,
    );
  }

  const guPrice = await readRegionalPricePosition(db!, {
    regionCode: gu,
    areaBand: "30",
    preferredComplexId: complexId,
  });
  assert(guPrice.status === "ok", "gu price ok");
  if (guPrice.status === "ok") {
    assert(guPrice.price.scope === "GU", "gu cell");
    assert(
      Math.abs((guPrice.price.meanPricePerSupplyPyeong ?? 0) - GU_GOLDEN) < 0.001,
      `songpa main ${guPrice.price.meanPricePerSupplyPyeong}`,
    );
    assert(
      Math.abs((guPrice.price.meanPricePerSupplyPyeong ?? 0) - COMPLEX_GOLDEN) > 1,
      "complex must not leak as gu",
    );
  }

  const noComposite = await readRegionalPricePosition(db!, {
    regionCode: gu,
    areaBand: "ALL",
  });
  assert(noComposite.status === "unavailable", "no invented composite price");

  console.log("ok: region-status-ia");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

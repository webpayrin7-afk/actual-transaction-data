/**
 * Region Status V1 smoke + Ranking/Price read checks. No methodology writes.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getDb } from "../src/lib/db/client";
import { publishedRegionRanking } from "../src/lib/region-ranking/query";
import { RANKING_V3_VERSION } from "../src/lib/region-ranking/ranking-v3";
import { readRegionalPricePosition } from "../src/lib/region-ranking/region-price-read";
import { PRICE_POSITION_PUBLIC_VERSION } from "../src/lib/region-ranking/price-position-read";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const daily = readFileSync(
  resolve(import.meta.dirname, "../src/components/RegionDailyStatus.tsx"),
  "utf8",
);
assert(daily.includes("RegionStatusHero"), "hero section");
assert(daily.includes("RegionMarketSummary"), "market summary");
assert(daily.includes("RegionPriceTrendSection"), "price trend");
assert(daily.includes("RegionLeaderboard"), "ranking preserved");
assert(daily.includes("RegionRecentTransactions"), "recent tx");
assert(daily.includes("RegionAnalysisSection"), "analysis");
assert(daily.includes("RegionSupplySection"), "supply");
assert(daily.includes("hideScopeToggle"), "scope lifted to hero");
assert(daily.includes("decade"), "shared decade URL state");
assert(!daily.includes("지역 평균 평당가"), "forbidden avg label");

const sections = readFileSync(
  resolve(import.meta.dirname, "../src/components/region/RegionStatusSections.tsx"),
  "utf8",
);
assert(sections.includes("지역 대표 평당가"), "rep price label");
assert(sections.includes("최근 실거래 기준"), "rep price basis");
assert(sections.includes("같은 시·군·구의 청약"), "supply tip");
assert(sections.includes("주변 공급 정보를 불러오지 못했습니다."), "supply error");

const api = readFileSync(
  resolve(import.meta.dirname, "../src/app/api/region-price-position/route.ts"),
  "utf8",
);
assert(api.includes("readRegionalPricePosition"), "region price API");
assert(api.includes("DECADE_KEYS_V3"), "decade bands only");

const leaderboard = readFileSync(
  resolve(import.meta.dirname, "../src/components/region/RegionLeaderboard.tsx"),
  "utf8",
);
assert(leaderboard.includes("REGION_RANK_V3_TABS"), "ranking V3 intact");
assert(leaderboard.includes("onDecadeSelect"), "decade handoff to price");

const db = getDb();
if (!db) {
  console.log("ok: region-status-v1 (structural; no db)");
  process.exit(0);
}

async function main() {
  const complexId = "cx_4c63d9a100973c60";
  const gu = "11710";
  const dong = "1171010100";

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

  const guPrice = await readRegionalPricePosition(db!, {
    regionCode: gu,
    areaBand: "30",
    preferredComplexId: complexId,
  });
  assert(guPrice.status === "ok", "gu price ok");
  if (guPrice.status === "ok") {
    assert(guPrice.version === PRICE_POSITION_PUBLIC_VERSION, "price public version");
    assert(guPrice.scope === "GU", "gu scope");
    assert(guPrice.referenceMonth === null, "regional referenceMonth null");
    assert(guPrice.price.scope === "GU", "cell is GU not COMPLEX");
    assert(
      guPrice.price.meanPricePerSupplyPyeong != null &&
        guPrice.price.meanPricePerSupplyPyeong > 0,
      "gu mean present",
    );
  }

  const dongPrice = await readRegionalPricePosition(db!, {
    regionCode: dong,
    areaBand: "30",
    preferredComplexId: complexId,
  });
  assert(dongPrice.status === "ok", "dong price ok");
  if (dongPrice.status === "ok") {
    assert(dongPrice.scope === "DONG", "dong scope");
    assert(dongPrice.price.scope === "DONG", "cell is DONG not COMPLEX");
    assert(
      dongPrice.hostComplexId === complexId,
      "preferred host complex used for read",
    );
  }

  const noComposite = await readRegionalPricePosition(db!, {
    regionCode: gu,
    areaBand: "ALL",
  });
  assert(noComposite.status === "unavailable", "no invented composite price");

  console.log("ok: region-status-v1");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

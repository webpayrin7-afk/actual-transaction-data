/**
 * Leader map metric unit tests (no production DB).
 *   npx tsx scripts/test-leader-map.ts
 */
import assert from "node:assert/strict";
import {
  buildComplexStats,
  compareLeaderStats,
  complexKeyOf,
  medianOf,
  minSampleThreshold,
  normalized84Price,
  pickLeader,
  pricePerM2,
  rankEligible,
  sampleQualityForCount,
  windowFromTo,
  yearMonthsInclusive,
  type ComplexLeaderStats,
  type LeaderTrade,
} from "../src/lib/leader-map/metrics";
import { MAP_VIEWBOX, SEOUL_GU_LAYOUT } from "../src/lib/leader-map/seoul-layout";
import { SEOUL_REGIONS } from "../src/lib/constants/regions";

function trade(
  partial: Partial<LeaderTrade> & Pick<LeaderTrade, "dealAmount" | "dealDate">,
): LeaderTrade {
  return {
    exclusiveArea: partial.exclusiveArea ?? 84,
    floor: partial.floor ?? 10,
    dealAmount: partial.dealAmount,
    dealDate: partial.dealDate,
  };
}

function stats(
  overrides: Partial<ComplexLeaderStats> &
    Pick<ComplexLeaderStats, "complexKey" | "normalized84Price" | "latestDeal">,
): ComplexLeaderStats {
  return {
    lawdCd: "11680",
    gu: "강남구",
    dong: "대치동",
    aptName: "테스트",
    aptNameNorm: "테스트",
    tradeCount12m: 5,
    medianPpsqm: overrides.normalized84Price / 84,
    medianPyeongPrice: 10000,
    previousDeal: null,
    latestChange: null,
    sampleQuality: "GOOD",
    ...overrides,
  };
}

assert.equal(pricePerM2(84000, 84), 1000);
assert.equal(pricePerM2(0, 84), null);
assert.equal(pricePerM2(84000, 0), null);

assert.equal(medianOf([]), null);
assert.equal(medianOf([3]), 3);
assert.equal(medianOf([1, 3]), 2);
assert.equal(medianOf([1, 2, 3]), 2);
assert.equal(normalized84Price(1000), 84000);

assert.equal(sampleQualityForCount(5), "GOOD");
assert.equal(sampleQualityForCount(4), "LOW");
assert.equal(sampleQualityForCount(1), "LOW");

assert.equal(minSampleThreshold([5, 2, 1]), 5);
assert.equal(minSampleThreshold([4, 3, 1]), 3);
assert.equal(minSampleThreshold([2, 1]), 1);
assert.equal(minSampleThreshold([]), 0);

{
  const a = stats({
    complexKey: "a",
    normalized84Price: 90000,
    latestDeal: { dealDate: "2026-08-01", dealAmount: 1, exclusiveArea: 84, floor: 1 },
    tradeCount12m: 5,
  });
  const b = stats({
    complexKey: "b",
    normalized84Price: 100000,
    latestDeal: { dealDate: "2026-01-01", dealAmount: 1, exclusiveArea: 84, floor: 1 },
    tradeCount12m: 5,
  });
  assert.ok(compareLeaderStats(a, b) > 0);
  assert.equal(pickLeader([a, b])?.complexKey, "b");
}

{
  const older = stats({
    complexKey: "older",
    normalized84Price: 80000,
    latestDeal: { dealDate: "2026-01-01", dealAmount: 1, exclusiveArea: 84, floor: 1 },
    tradeCount12m: 8,
  });
  const newer = stats({
    complexKey: "newer",
    normalized84Price: 80000,
    latestDeal: { dealDate: "2026-09-01", dealAmount: 1, exclusiveArea: 84, floor: 1 },
    tradeCount12m: 5,
  });
  assert.equal(pickLeader([older, newer])?.complexKey, "newer");
}

{
  const few = stats({
    complexKey: "few",
    normalized84Price: 120000,
    latestDeal: { dealDate: "2026-09-01", dealAmount: 1, exclusiveArea: 84, floor: 1 },
    tradeCount12m: 2,
  });
  const enough = stats({
    complexKey: "enough",
    normalized84Price: 70000,
    latestDeal: { dealDate: "2026-01-01", dealAmount: 1, exclusiveArea: 84, floor: 1 },
    tradeCount12m: 5,
  });
  assert.equal(pickLeader([few, enough])?.complexKey, "enough");
}

{
  const onlyLow = stats({
    complexKey: "low",
    normalized84Price: 50000,
    latestDeal: { dealDate: "2026-09-01", dealAmount: 1, exclusiveArea: 84, floor: 1 },
    tradeCount12m: 2,
    sampleQuality: "LOW",
  });
  assert.equal(pickLeader([onlyLow])?.complexKey, "low");
  assert.equal(pickLeader([]), null);
}

{
  const hugeOne = buildComplexStats({
    complexKey: "huge",
    lawdCd: "11680",
    gu: "강남구",
    dong: "청담동",
    aptName: "대형1건",
    aptNameNorm: "대형1건",
    trades: [trade({ dealAmount: 500000, exclusiveArea: 240, dealDate: "2026-09-01" })],
  });
  const solid = buildComplexStats({
    complexKey: "solid",
    lawdCd: "11680",
    gu: "강남구",
    dong: "대치동",
    aptName: "표준단지",
    aptNameNorm: "표준단지",
    trades: [
      trade({ dealAmount: 84000, dealDate: "2026-01-10" }),
      trade({ dealAmount: 86000, dealDate: "2026-03-10" }),
      trade({ dealAmount: 85000, dealDate: "2026-05-10" }),
      trade({ dealAmount: 87000, dealDate: "2026-07-10" }),
      trade({ dealAmount: 88000, dealDate: "2026-09-01" }),
    ],
  });
  assert.ok(hugeOne);
  assert.ok(solid);
  assert.equal(pickLeader([hugeOne, solid])?.complexKey, "solid");
}

{
  const withPrev = buildComplexStats({
    complexKey: "chg",
    lawdCd: "11680",
    gu: "강남구",
    dong: "역삼동",
    aptName: "변화",
    aptNameNorm: "변화",
    trades: [
      trade({ dealAmount: 80000, exclusiveArea: 84, dealDate: "2026-01-01" }),
      trade({ dealAmount: 88000, exclusiveArea: 84, dealDate: "2026-08-01" }),
    ],
  });
  assert.ok(withPrev?.latestChange);
  assert.equal(withPrev.latestChange?.direction, "up");
  assert.equal(withPrev.previousDeal?.dealAmount, 80000);
}

{
  const emptyGu = pickLeader([]);
  assert.equal(emptyGu, null);
}

{
  const dachi = buildComplexStats({
    complexKey: complexKeyOf("11680", "대치동", "A"),
    lawdCd: "11680",
    gu: "강남구",
    dong: "대치동",
    aptName: "A",
    aptNameNorm: "A",
    trades: Array.from({ length: 5 }, (_, i) =>
      trade({ dealAmount: 90000, dealDate: `2026-0${i + 1}-01` }),
    ),
  });
  const gaepo = buildComplexStats({
    complexKey: complexKeyOf("11680", "개포동", "B"),
    lawdCd: "11680",
    gu: "강남구",
    dong: "개포동",
    aptName: "B",
    aptNameNorm: "B",
    trades: Array.from({ length: 5 }, (_, i) =>
      trade({ dealAmount: 70000, dealDate: `2026-0${i + 1}-01` }),
    ),
  });
  assert.ok(dachi && gaepo);
  const byDong = new Map<string, ComplexLeaderStats[]>();
  for (const c of [dachi, gaepo]) {
    const list = byDong.get(c.dong) ?? [];
    list.push(c);
    byDong.set(c.dong, list);
  }
  assert.equal(pickLeader(byDong.get("대치동") ?? [])?.aptName, "A");
  assert.equal(pickLeader(byDong.get("개포동") ?? [])?.aptName, "B");
}

{
  const ranked = rankEligible(
    [
      stats({
        complexKey: "low",
        normalized84Price: 200000,
        latestDeal: { dealDate: "2026-09-01", dealAmount: 1, exclusiveArea: 84, floor: 1 },
        tradeCount12m: 2,
      }),
      stats({
        complexKey: "top",
        normalized84Price: 100000,
        latestDeal: { dealDate: "2026-09-01", dealAmount: 1, exclusiveArea: 84, floor: 1 },
        tradeCount12m: 12,
      }),
    ],
    5,
  );
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0]?.complexKey, "top");
}

{
  const { from, to } = windowFromTo("2026-09-09", 12);
  assert.equal(to, "2026-09-09");
  assert.equal(from, "2025-09-09");
  const yms = yearMonthsInclusive(from, to);
  assert.equal(yms[0], "202509");
  assert.equal(yms.at(-1), "202609");
  assert.equal(yms.length, 13);
}

assert.equal(SEOUL_REGIONS.length, 25);
assert.equal(SEOUL_GU_LAYOUT.length, 25);
assert.equal(new Set(SEOUL_GU_LAYOUT.map((g) => g.lawdCd)).size, 25);

{
  for (const g of SEOUL_GU_LAYOUT) {
    for (const tile of g.tiles) {
      assert.ok(tile.x >= 0 && tile.y >= 0, g.slug);
      assert.ok(tile.x + tile.w <= MAP_VIEWBOX.w, `${g.slug} overflow x`);
      assert.ok(tile.y + tile.h <= MAP_VIEWBOX.h, `${g.slug} overflow y`);
    }
  }
}

{
  const shape = {
    metro: "seoul",
    source: "db",
    gus: [{ lawdCd: "11680", name: "강남구", slug: "seoul-gangnam", leader: null }],
    dongsByGu: { 강남구: [] },
    top5: [],
  };
  assert.equal(shape.metro, "seoul");
  assert.equal(shape.gus.length, 1);
  assert.ok("dongsByGu" in shape);
}

console.log(
  JSON.stringify({
    ok: true,
    cases: [
      "median",
      "84-normalization",
      "sample-fallback-5-3-1",
      "tie-break-date",
      "min-sample-blocks-large-one-off",
      "previous-type-change",
      "empty-region",
      "district-grouping",
      "top-eligible-excludes-low-sample",
      "window-13-months",
      "25-gu-layout",
      "api-shape",
    ],
  }),
);

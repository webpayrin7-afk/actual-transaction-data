/**
 * 지역 시장 insight / grouping — LLM 없이 결정적 문구.
 *   npx tsx scripts/test-region-market-insight.ts
 */
import assert from "node:assert/strict";
import {
  countTradesInYearMonth,
  compactSingogaDeals,
  featuredSingogaGroup,
  groupDealsByDate,
  increaseRatePct,
  latestRecordDate,
  pickFeaturedSingogaDeal,
  priorPeakAmount,
  recentSingogaDeals,
  recordDateDomId,
  regionMarketInsight,
  latestRecordSectionCue,
  shiftYearMonth,
  typePriceTrend,
  volumeChangePct,
  yearMonthFromDealDate,
} from "../src/lib/region/market-insight";
import { formatSqmApproxPyeong } from "../src/lib/utils/format";

assert.equal(yearMonthFromDealDate("2026-09-05"), "202609");
assert.equal(shiftYearMonth("202609", -1), "202608");
assert.equal(shiftYearMonth("202601", -1), "202512");

assert.equal(
  countTradesInYearMonth(
    ["2026-09-01", "2026-09-09", "2026-08-31", "2026-09-15"],
    "202609",
    "09",
  ),
  2,
);

assert.equal(volumeChangePct(112, 100), 12);
assert.equal(volumeChangePct(88, 100), -12);
assert.equal(volumeChangePct(10, 0), null);

assert.equal(
  regionMarketInsight({
    monthTradeCount: 112,
    prevMonthTradeCount: 100,
    singogaCount: 8,
    comparePartial: true,
  }),
  "전월 같은 기간 대비 거래량이 12% 늘었습니다.",
);

assert.equal(
  regionMarketInsight({
    monthTradeCount: 80,
    prevMonthTradeCount: 100,
    singogaCount: 3,
    comparePartial: false,
  }),
  "전월 대비 거래량이 20% 줄었습니다.",
);

assert.equal(
  regionMarketInsight({
    monthTradeCount: 10,
    prevMonthTradeCount: 10,
    singogaCount: 8,
    comparePartial: false,
  }),
  "이번 달 신고가 8건",
);

assert.equal(
  regionMarketInsight({
    monthTradeCount: 4,
    prevMonthTradeCount: 0,
    singogaCount: 0,
    comparePartial: true,
  }),
  "이번 달 매매 4건 · 신고가 없음",
);

assert.equal(
  regionMarketInsight({
    monthTradeCount: 0,
    prevMonthTradeCount: 0,
    singogaCount: 0,
    comparePartial: true,
  }),
  "이번 달 매매 실거래 없음",
);

const grouped = groupDealsByDate([
  {
    dealDate: "2026-09-05",
    dealAmount: 100,
    aptName: "가",
  },
  {
    dealDate: "2026-09-01",
    dealAmount: 90,
    aptName: "나",
  },
  {
    dealDate: "2026-09-05",
    dealAmount: 200,
    aptName: "다",
  },
]);
assert.deepEqual(
  grouped.map((g) => [g.date, g.deals.map((d) => d.aptName)]),
  [
    ["2026-09-05", ["다", "가"]],
    ["2026-09-01", ["나"]],
  ],
);

const recent = recentSingogaDeals(
  [
    { dealDate: "2026-09-01", dealAmount: 1, aptName: "old" },
    { dealDate: "2026-09-09", dealAmount: 2, aptName: "new-a" },
    { dealDate: "2026-09-09", dealAmount: 9, aptName: "new-b" },
  ],
  2,
);
assert.deepEqual(
  recent.map((d) => d.aptName),
  ["new-b", "new-a"],
);

assert.equal(recordDateDomId("2026-09-05"), "record-date-2026-09-05");

assert.equal(priorPeakAmount({ dealAmount: 106000, increaseAmount: 18000 }), 88000);
assert.equal(increaseRatePct({ dealAmount: 106000, increaseAmount: 18000 }), 20.5);
assert.equal(increaseRatePct({ dealAmount: 100, increaseAmount: 0 }), null);
assert.equal(increaseRatePct({ dealAmount: 100, increaseAmount: 100 }), null);

const featured = pickFeaturedSingogaDeal([
  {
    dealDate: "2026-09-05",
    increaseAmount: 1700,
    dealAmount: 115000,
    aptName: "매화마을공무원1",
  },
  {
    dealDate: "2026-09-05",
    increaseAmount: 18000,
    dealAmount: 106000,
    aptName: "신세계쉐덴",
  },
  {
    dealDate: "2026-09-01",
    increaseAmount: 11000,
    dealAmount: 429000,
    aptName: "판교푸르지오그랑블",
  },
]);
assert.equal(featured?.aptName, "신세계쉐덴");

const sample = [
  {
    dealDate: "2026-09-05",
    increaseAmount: 1700,
    dealAmount: 115000,
    aptName: "매화마을공무원1",
  },
  {
    dealDate: "2026-09-05",
    increaseAmount: 18000,
    dealAmount: 106000,
    aptName: "신세계쉐덴",
  },
  {
    dealDate: "2026-09-04",
    increaseAmount: 7500,
    dealAmount: 153000,
    aptName: "탑마을(벽산)",
  },
  {
    dealDate: "2026-09-01",
    increaseAmount: 11000,
    dealAmount: 429000,
    aptName: "판교푸르지오그랑블",
  },
];
assert.equal(latestRecordDate(sample), "2026-09-05");
assert.deepEqual(
  featuredSingogaGroup(sample).map((d) => d.aptName),
  ["신세계쉐덴", "매화마을공무원1"],
);
assert.deepEqual(
  compactSingogaDeals(sample, "2026-09-05", 3).map((d) => d.aptName),
  ["탑마을(벽산)", "판교푸르지오그랑블"],
);
assert.equal(
  latestRecordSectionCue("2026-09-05", 2),
  "9월 5일 · 2건",
);

const trend = typePriceTrend({
  exclusiveArea: 84.3,
  throughDate: "2026-09-05",
  months: 24,
  trades: [
    { dealDate: "2025-01-01", exclusiveArea: 84.3, dealAmount: 100000 },
    { dealDate: "2025-06-01", exclusiveArea: 59.9, dealAmount: 50000 },
    { dealDate: "2026-03-10", exclusiveArea: 84.3, dealAmount: 110000 },
    { dealDate: "2026-03-20", exclusiveArea: 84.3, dealAmount: 108000 },
    { dealDate: "2026-09-05", exclusiveArea: 84.3, dealAmount: 149000 },
    { dealDate: "2026-09-20", exclusiveArea: 84.3, dealAmount: 200000 },
  ],
});
assert.deepEqual(
  trend.map((p) => [p.date, p.amount]),
  [
    ["2025-01-01", 100000],
    ["2026-03-10", 110000],
    ["2026-03-20", 108000],
    ["2026-09-05", 149000],
  ],
);

assert.equal(formatSqmApproxPyeong(59.98), "59.98㎡ (18평)");
assert.equal(formatSqmApproxPyeong(84.97), "84.97㎡ (26평)");
assert.equal(formatSqmApproxPyeong(114.8), "114.80㎡ (35평)");

console.log("test-region-market-insight: ok");

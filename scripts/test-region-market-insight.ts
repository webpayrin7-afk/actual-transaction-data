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
  groupDealsBySeenDate,
  CALENDAR_HELPER,
  EMPTY_MONTH_HISTORY,
  EMPTY_NEWLY_SEEN,
  hiddenNewlySeenCount,
  increaseRatePct,
  koreanYearMonthLabel,
  latestRecordDate,
  medianDealAmount,
  newlySeenSectionTitle,
  pickFeaturedSingogaDeal,
  pickHeroSeenDate,
  previousTypeDealAmount,
  priorPeakAmount,
  priorTypeMaxAmount,
  recentSingogaDeals,
  recordDateDomId,
  regionMarketInsight,
  latestRecordSectionCue,
  shiftYearMonth,
  sortNewlySeenDeals,
  typePriceTrend,
  typeRecordHigh,
  visibleNewlySeenDeals,
  volumeChangePct,
  vsPreviousTypeDeal,
  yearMonthFromDealDate,
} from "../src/lib/region/market-insight";
import { formatSqmApproxPyeong } from "../src/lib/utils/format";
import { seoulDateOf } from "../src/lib/market/time";

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
    monthTradeCount: 4,
    prevMonthTradeCount: 4,
    singogaCount: null,
    comparePartial: true,
  }),
  "이번 달 매매 4건",
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

assert.equal(formatSqmApproxPyeong(59.98), "59.98㎡ (약 18평)");
assert.equal(formatSqmApproxPyeong(84.97), "84.97㎡ (약 26평)");
assert.equal(formatSqmApproxPyeong(114.8), "114.80㎡ (약 35평)");

assert.equal(seoulDateOf("2026-09-08T21:04:44.000Z"), "2026-09-09");
assert.equal(seoulDateOf("2026-09-09T00:00:00+09:00"), "2026-09-09");

assert.deepEqual(typeRecordHigh(185000, 171000), {
  isSingoga: true,
  increaseAmount: 14000,
});
assert.deepEqual(typeRecordHigh(185000, 0), {
  isSingoga: false,
  increaseAmount: 0,
});
assert.deepEqual(typeRecordHigh(171000, 171000), {
  isSingoga: false,
  increaseAmount: 0,
});

assert.equal(
  priorTypeMaxAmount({
    exclusiveArea: 59.47,
    dealDate: "2026-08-28",
    history: [
      { exclusiveArea: 59.47, dealDate: "2025-09-16", dealAmount: 171000 },
      { exclusiveArea: 59.47, dealDate: "2026-08-28", dealAmount: 185000 },
      { exclusiveArea: 84.9, dealDate: "2024-01-01", dealAmount: 999999 },
    ],
  }),
  171000,
);

const sorted = sortNewlySeenDeals([
  {
    id: "b",
    singogaKind: null,
    increaseAmount: 0,
    dealAmount: 100,
    aptName: "가아파트",
    exclusiveArea: 80,
  },
  {
    id: "a",
    singogaKind: "type",
    increaseAmount: 10,
    dealAmount: 200,
    aptName: "나아파트",
    exclusiveArea: 50,
  },
  {
    id: "c",
    singogaKind: null,
    increaseAmount: 0,
    dealAmount: 300,
    aptName: "다아파트",
    exclusiveArea: 60,
  },
  {
    id: "d",
    singogaKind: "type",
    increaseAmount: 50,
    dealAmount: 150,
    aptName: "라아파트",
    exclusiveArea: 40,
  },
]);
assert.deepEqual(
  sorted.map((d) => d.id),
  ["d", "a", "c", "b"],
);

const many = [
  ...Array.from({ length: 3 }, (_, i) => ({
    id: `s${i}`,
    singogaKind: "type" as const,
  })),
  ...Array.from({ length: 20 }, (_, i) => ({
    id: `n${i}`,
    singogaKind: null,
  })),
];
const vis = visibleNewlySeenDeals(many, false, 16);
assert.equal(vis.length, 16);
assert.equal(vis.filter((d) => d.singogaKind).length, 3);
assert.equal(hiddenNewlySeenCount(many, false, 16), 7);
assert.equal(visibleNewlySeenDeals(many, false, 2).filter((d) => d.singogaKind).length, 3);

assert.equal(koreanYearMonthLabel("202609"), "2026년 9월");
assert.equal(newlySeenSectionTitle(true), "오늘 새로 확인된 거래");
assert.equal(newlySeenSectionTitle(false), "최근 새로 확인된 거래");
assert.equal(EMPTY_NEWLY_SEEN, "아직 새로 확인된 거래가 없습니다.");
assert.equal(EMPTY_MONTH_HISTORY, "이 달에 새로 확인된 거래가 없습니다.");
assert.equal(
  CALENDAR_HELPER,
  "날짜를 누르면 해당 날짜의 거래로 이동합니다.",
);

assert.deepEqual(pickHeroSeenDate(["2026-09-08", "2026-09-09"], "2026-09-09"), {
  date: "2026-09-09",
  isToday: true,
});
assert.deepEqual(pickHeroSeenDate(["2026-09-08", "2026-09-07"], "2026-09-09"), {
  date: "2026-09-08",
  isToday: false,
});
assert.deepEqual(pickHeroSeenDate([], "2026-09-09"), {
  date: null,
  isToday: false,
});

assert.equal(medianDealAmount([]), null);
assert.equal(medianDealAmount([10]), 10);
assert.equal(medianDealAmount([10, 30, 20]), 20);
assert.equal(medianDealAmount([10, 20]), 15);

const seenGrouped = groupDealsBySeenDate([
  {
    firstSeenDate: "2026-09-09",
    dealAmount: 100,
    aptName: "가",
  },
  {
    firstSeenDate: "2026-09-08",
    dealAmount: 300,
    aptName: "나",
  },
  {
    firstSeenDate: "2026-09-09",
    dealAmount: 200,
    aptName: "다",
  },
]);
assert.deepEqual(
  seenGrouped.map((g) => [g.date, g.deals.map((d) => d.aptName)]),
  [
    ["2026-09-09", ["다", "가"]],
    ["2026-09-08", ["나"]],
  ],
);

assert.equal(
  previousTypeDealAmount({
    exclusiveArea: 84.97,
    dealDate: "2026-09-01",
    history: [
      { exclusiveArea: 84.97, dealDate: "2026-05-10", dealAmount: 100000 },
      { exclusiveArea: 84.97, dealDate: "2026-08-20", dealAmount: 110000 },
      { exclusiveArea: 59.9, dealDate: "2026-08-28", dealAmount: 90000 },
      { exclusiveArea: 84.97, dealDate: "2026-09-01", dealAmount: 120000 },
    ],
  }),
  110000,
);

assert.equal(
  previousTypeDealAmount({
    exclusiveArea: 84.97,
    dealDate: "2026-09-01",
    history: [{ exclusiveArea: 84.97, dealDate: "2026-09-01", dealAmount: 120000 }],
  }),
  null,
);

assert.deepEqual(vsPreviousTypeDeal(185000, 180000), {
  kind: "up",
  amount: 5000,
});
assert.deepEqual(vsPreviousTypeDeal(170000, 180000), {
  kind: "down",
  amount: 10000,
});
assert.deepEqual(vsPreviousTypeDeal(180000, 180000), { kind: "same" });
assert.equal(vsPreviousTypeDeal(180000, null), null);

console.log("test-region-market-insight: ok");

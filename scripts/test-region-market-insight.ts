/**
 * 지역 시장 insight / grouping — LLM 없이 결정적 문구.
 *   npx tsx scripts/test-region-market-insight.ts
 */
import assert from "node:assert/strict";
import {
  countTradesInYearMonth,
  groupDealsByDate,
  recentSingogaDeals,
  recordDateDomId,
  regionMarketInsight,
  shiftYearMonth,
  volumeChangePct,
  yearMonthFromDealDate,
} from "../src/lib/region/market-insight";

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
  "이번 달 현재까지 거래량이 전월 같은 기간보다 12% 증가했습니다.",
);

assert.equal(
  regionMarketInsight({
    monthTradeCount: 80,
    prevMonthTradeCount: 100,
    singogaCount: 3,
    comparePartial: false,
  }),
  "이번 달 거래량이 전월보다 20% 감소했습니다.",
);

assert.equal(
  regionMarketInsight({
    monthTradeCount: 10,
    prevMonthTradeCount: 10,
    singogaCount: 8,
    comparePartial: false,
  }),
  "이번 달 현재 신고가 거래가 8건 확인됐습니다.",
);

assert.equal(
  regionMarketInsight({
    monthTradeCount: 4,
    prevMonthTradeCount: 0,
    singogaCount: 0,
    comparePartial: true,
  }),
  "이번 달 매매 4건이 확인됐고, 신고가는 없습니다.",
);

assert.equal(
  regionMarketInsight({
    monthTradeCount: 0,
    prevMonthTradeCount: 0,
    singogaCount: 0,
    comparePartial: true,
  }),
  "이번 달 매매 실거래가 아직 없습니다.",
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

console.log("test-region-market-insight: ok");

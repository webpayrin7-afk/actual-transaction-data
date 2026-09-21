import assert from "node:assert/strict";
import {
  baselineMonthForHorizon,
  buildComplexMonthValues,
  compositionSensitivity,
  regionPriceCandidate,
  regionTrendCandidate,
  resolveComplexMonth,
  stabilityStats,
  type DealPoint,
} from "../src/lib/region-ranking/price-position-v21-audit";

assert.equal(baselineMonthForHorizon("2026-09", "6M"), "2026-03");
assert.equal(baselineMonthForHorizon("2026-09", "1Y"), "2025-09");
assert.equal(baselineMonthForHorizon("2026-09", "2Y"), "2024-09");
assert.equal(baselineMonthForHorizon("2026-09", "5Y"), "2021-09");

const points: DealPoint[] = [
  { complexId: "a", lawdCd: "11710", bjdongCd: "10800", yearMonth: "2026-09", pricePerMarketPyeong: 100, dealAmount: 33000 },
  { complexId: "a", lawdCd: "11710", bjdongCd: "10800", yearMonth: "2026-09", pricePerMarketPyeong: 120, dealAmount: 39600 },
  { complexId: "b", lawdCd: "11710", bjdongCd: "10800", yearMonth: "2026-09", pricePerMarketPyeong: 200, dealAmount: 66000 },
  { complexId: "a", lawdCd: "11710", bjdongCd: "10800", yearMonth: "2026-03", pricePerMarketPyeong: 90, dealAmount: 29700 },
  { complexId: "b", lawdCd: "11710", bjdongCd: "10800", yearMonth: "2026-03", pricePerMarketPyeong: 160, dealAmount: 52800 },
  { complexId: "a", lawdCd: "11710", bjdongCd: "10800", yearMonth: "2026-08", pricePerMarketPyeong: 105, dealAmount: 34650 },
];
const tables = buildComplexMonthValues(points);
const aSep = tables.get("a")!.get("2026-09")!;
assert.equal(aSep.meanPrice, 110);
assert.equal(aSep.medianPrice, 110);
assert.equal(aSep.tradeCount, 2);

const sparse = resolveComplexMonth({
  cells: tables.get("a")!,
  targetMonth: "2026-09",
  asOfMonth: "2026-09",
  sparse: "S1",
  minTrades: 1,
});
assert.equal(sparse?.month, "2026-09");

// S1 tie-break: when ±1 both available, prefer PREVIOUS month.
const tieCells = buildComplexMonthValues([
  { complexId: "t", lawdCd: "11710", bjdongCd: "10800", yearMonth: "2026-08", pricePerMarketPyeong: 90, dealAmount: 1 },
  { complexId: "t", lawdCd: "11710", bjdongCd: "10800", yearMonth: "2026-10", pricePerMarketPyeong: 110, dealAmount: 1 },
]);
const tie = resolveComplexMonth({
  cells: tieCells.get("t")!,
  targetMonth: "2026-09",
  asOfMonth: "2026-10",
  sparse: "S1",
  minTrades: 1,
});
assert.equal(tie?.month, "2026-08");
assert.equal(tie?.cell.meanPrice, 90);

const p0 = regionPriceCandidate({
  candidate: "P0",
  complexIds: ["a", "b"],
  tables,
  referenceMonth: "2026-09",
  asOfMonth: "2026-09",
  sparse: "S0",
  minComplexTrades: 1,
  kind: "C1_MEAN",
  pooledTradePrices: [100, 120, 200],
});
assert.equal(p0.value, 140);

const p1 = regionPriceCandidate({
  candidate: "P1",
  complexIds: ["a", "b"],
  tables,
  referenceMonth: "2026-09",
  asOfMonth: "2026-09",
  sparse: "S0",
  minComplexTrades: 1,
  kind: "C1_MEAN",
});
assert.equal(p1.complexCount, 2);
assert.equal(p1.value, 155); // mean(110, 200)

const p2 = regionPriceCandidate({
  candidate: "P2",
  complexIds: ["a", "b"],
  tables,
  referenceMonth: "2026-09",
  asOfMonth: "2026-09",
  sparse: "S0",
  minComplexTrades: 1,
  kind: "C1_MEAN",
});
assert.equal(p2.value, 155);

const t0 = regionTrendCandidate({
  candidate: "T0",
  complexIds: ["a", "b"],
  tables,
  referenceMonth: "2026-09",
  horizon: "6M",
  asOfMonth: "2026-09",
  sparse: "S0",
  minComplexTrades: 1,
  kind: "C1_MEAN",
});
assert.equal(t0.matchedComplexes, 2);
assert.ok(t0.changePercent != null);

assert.equal(compositionSensitivity({ withAll: 100, withoutTopComplex: 90 }), 10);
assert.ok(Math.abs((stabilityStats([
  { month: "2026-07", value: 100, sample: 10 },
  { month: "2026-08", value: 110, sample: 12 },
  { month: "2026-09", value: 121, sample: 8 },
]).maxAbsMomPct ?? 0) - 10) < 1e-9);

console.log("region metric audit tests ok");

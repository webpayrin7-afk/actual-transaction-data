import assert from "node:assert/strict";
import { buildComplexMonthValues } from "../src/lib/region-ranking/price-position-v21-audit";
import {
  buildPricePositionV23,
  buildPricePositionV231,
  buildPricePositionV232,
  METHODOLOGY_FINGERPRINT_V23,
  METHODOLOGY_FINGERPRINT_V231,
  METHODOLOGY_FINGERPRINT_V232,
  pricePositionV23SnapshotId,
  pricePositionV231SnapshotId,
  pricePositionV232SnapshotId,
} from "../src/lib/region-ranking/price-position-v23";
import { PRICE_POSITION_PUBLIC_VERSION } from "../src/lib/region-ranking/price-position-read";
import { decadeKeyFromLegacyAreaBand } from "../src/lib/region-ranking/price-position-v22";
import type { ComplexIdentityV2, SupplySalePoint } from "../src/lib/region-ranking/price-position-v2";
import {
  equalMonthWindowMean,
  pooledWindowMean,
  resolveRegionWindowV23,
  sampleStatusV23,
  windowsOverlap,
} from "../src/lib/region-ranking/region-trend-window";

assert.equal(pricePositionV23SnapshotId(), "price-position-v2.3|2026-09-17");
assert.equal(pricePositionV231SnapshotId(), "price-position-v2.3.1|2026-09-17");
assert.equal(pricePositionV232SnapshotId(), "price-position-v2.3.2|2026-09-17");
assert.equal(PRICE_POSITION_PUBLIC_VERSION, "price-position-v2.3.2");
assert.match(METHODOLOGY_FINGERPRINT_V231, /canonical-cohort-contributors/);
assert.match(METHODOLOGY_FINGERPRINT_V232, /canonical-cohort-contributors/);
assert.match(METHODOLOGY_FINGERPRINT_V232, /freshness-patch/);
assert.equal(decadeKeyFromLegacyAreaBand("84"), "30");
assert.match(METHODOLOGY_FINGERPRINT_V23, /complex-exact-endpoint-s1/);
assert.match(METHODOLOGY_FINGERPRINT_V23, /region-trailing-6m-pooled-mean/);
assert.match(METHODOLOGY_FINGERPRINT_V23, /horizons-6M-1Y-2Y-5Y/);

const six = resolveRegionWindowV23({ referenceMonth: "2026-09", horizonShift: 6, historyFloor: "2021-07" });
assert.ok(six);
assert.equal(six.status, "FULL_WINDOW");
assert.equal(six.length, 6);
assert.equal(`${six.currentStart}..${six.currentEnd}`, "2026-04..2026-09");
assert.equal(`${six.baselineStart}..${six.baselineEnd}`, "2025-10..2026-03");
assert.equal(windowsOverlap(six), false);

const five = resolveRegionWindowV23({ referenceMonth: "2026-09", horizonShift: 60, historyFloor: "2021-07" });
assert.ok(five);
assert.equal(five.status, "PARTIAL_HISTORY_WINDOW");
assert.equal(five.length, 3);
assert.equal(`${five.currentStart}..${five.currentEnd}`, "2026-07..2026-09");
assert.equal(`${five.baselineStart}..${five.baselineEnd}`, "2021-07..2021-09");
assert.ok(five.baselineStart >= "2021-07");

assert.equal(sampleStatusV23(4, 100), "VERY_THIN");
assert.equal(sampleStatusV23(8, 13), "THIN");
assert.equal(sampleStatusV23(76, 235), "ADEQUATE");
assert.equal(sampleStatusV23(1619, 4734), "ADEQUATE");

const cells = buildComplexMonthValues([
  { complexId: "a", lawdCd: "11710", bjdongCd: "1", yearMonth: "2026-08", pricePerMarketPyeong: 100, dealAmount: 1 },
  ...Array.from({ length: 10 }, () => ({
    complexId: "a",
    lawdCd: "11710",
    bjdongCd: "1",
    yearMonth: "2026-09",
    pricePerMarketPyeong: 200,
    dealAmount: 1,
  })),
]);
const pooled = pooledWindowMean(cells.get("a")!, "2026-08", "2026-09", "2026-09");
const equal = equalMonthWindowMean(cells.get("a")!, "2026-08", "2026-09", "2026-09");
assert.ok(pooled && equal);
assert.ok(Math.abs(pooled.mean - 190.909) < 0.01);
assert.equal(equal.mean, 150);

function point(complexId: string, yearMonth: string, price: number, label = 33): SupplySalePoint {
  return {
    complexId,
    lawdCd: "11710",
    bjdongCd: "10100",
    yearMonth,
    pricePerSupplyPyeong: price,
    pricePerMarketPyeong: price,
    marketPyeongLabel: label,
    dealAmount: price * label,
    exclusiveArea: 84,
    supplyArea: 109,
    supplyPyeong: label,
  };
}

const identities = new Map<string, ComplexIdentityV2>([
  ["cx_aaaaaaaaaaaaaaaa", { complexId: "cx_aaaaaaaaaaaaaaaa", lawdCd: "11710", bjdongCd: "10100", aptName: "A", legalDongName: "잠실동" }],
  ["cx_bbbbbbbbbbbbbbbb", { complexId: "cx_bbbbbbbbbbbbbbbb", lawdCd: "11710", bjdongCd: "10100", aptName: "B", legalDongName: "잠실동" }],
  ["cx_cccccccccccccccc", { complexId: "cx_cccccccccccccccc", lawdCd: "11710", bjdongCd: "10100", aptName: "C", legalDongName: "잠실동" }],
]);
const cohort = { key: "30" as const, min: 30, max: 40, label: "30평대" };
const points = [
  point("cx_aaaaaaaaaaaaaaaa", "2026-09", 10000),
  point("cx_aaaaaaaaaaaaaaaa", "2026-08", 1000, 33),
  point("cx_aaaaaaaaaaaaaaaa", "2025-09", 9900),
  point("cx_bbbbbbbbbbbbbbbb", "2026-09", 5000),
  point("cx_bbbbbbbbbbbbbbbb", "2026-04", 4000),
  point("cx_bbbbbbbbbbbbbbbb", "2025-09", 4500),
  point("cx_bbbbbbbbbbbbbbbb", "2025-04", 3000),
];
const built = buildPricePositionV23({
  cohort,
  points,
  identities,
  cohortUniverse: new Set(["cx_aaaaaaaaaaaaaaaa", "cx_bbbbbbbbbbbbbbbb", "cx_cccccccccccccccc"]),
  transactionAsOf: "2026-09-17",
});
const body = built.bodies.find((row) => row.complexId === "cx_aaaaaaaaaaaaaaaa");
assert.ok(body);
const exact = body.complexExactByMarketLabel["33"];
assert.equal(exact?.trends["1Y"].changePercent, 1.01);
assert.equal(exact?.trends["1Y"].actualCurrentMonth, "2026-09");
assert.equal(exact?.trends["1Y"].currentMean, 10000);
const dong = body.trends["1Y"].find((cell) => cell.scope === "DONG");
assert.equal(dong?.windowStatistic, "pooled_trade_mean");
assert.equal(dong?.currentWindow, "2026-04..2026-09");
assert.equal(dong?.baselineWindow, "2025-04..2025-09");
assert.equal(dong?.windowStatus, "FULL_WINDOW");
assert.equal(dong?.cohortUniverseCount, 3);
assert.equal(dong?.matchedComplexCount, 2);
assert.equal(dong?.canonicalHistoryAvailableCount, 2);
assert.equal(dong?.sampleCoverageRatio, 1);
assert.equal(dong?.sampleStatus, "SAMPLE_SEVERELY_LIMITED");
assert.equal(body.sampleConfidenceVersion, "sample-confidence-v2");
assert.notEqual(dong?.changePercent, exact?.trends["1Y"].changePercent);

const fiveYear = body.trends["5Y"].find((cell) => cell.scope === "SEOUL");
assert.equal(fiveYear?.windowStatus, "PARTIAL_HISTORY_WINDOW");
assert.equal(fiveYear?.currentWindow, "2026-07..2026-09");
assert.equal(fiveYear?.baselineWindow, "2021-07..2021-09");
assert.ok(!String(fiveYear?.baselineWindow).startsWith("2021-04"));

const outside = "cx_dddddddddddddddd";
identities.set(outside, { complexId: outside, lawdCd: "11710", bjdongCd: "10100", aptName: "D", legalDongName: "잠실동" });
const parityPoints = [
  point("cx_aaaaaaaaaaaaaaaa", "2026-09", 100),
  point("cx_aaaaaaaaaaaaaaaa", "2025-09", 100),
  point("cx_bbbbbbbbbbbbbbbb", "2026-09", 200),
  point("cx_bbbbbbbbbbbbbbbb", "2025-09", 100),
  point(outside, "2026-09", 1000),
  point(outside, "2025-09", 100),
];
const parityArgs = {
  cohort,
  points: parityPoints,
  identities,
  cohortUniverse: new Set(["cx_aaaaaaaaaaaaaaaa", "cx_bbbbbbbbbbbbbbbb"]),
  transactionAsOf: "2026-09-17",
};
const legacyBody = buildPricePositionV23(parityArgs).bodies.find((row) => row.complexId === "cx_aaaaaaaaaaaaaaaa");
const canonicalBody = buildPricePositionV231(parityArgs).bodies.find((row) => row.complexId === "cx_aaaaaaaaaaaaaaaa");
const freshBody = buildPricePositionV232(parityArgs).bodies.find((row) => row.complexId === "cx_aaaaaaaaaaaaaaaa");
const legacyDong = legacyBody?.trends["1Y"].find((cell) => cell.scope === "DONG");
const canonicalDong = canonicalBody?.trends["1Y"].find((cell) => cell.scope === "DONG");
const freshDong = freshBody?.trends["1Y"].find((cell) => cell.scope === "DONG");
assert.equal(legacyDong?.changePercent, 100);
assert.equal(canonicalDong?.changePercent, 50);
assert.equal(freshDong?.changePercent, canonicalDong?.changePercent);
assert.equal(legacyDong?.matchedComplexCount, 2);
assert.equal(canonicalDong?.matchedComplexCount, 2);
assert.equal(canonicalDong?.canonicalHistoryAvailableCount, 2);
assert.equal(canonicalBody?.methodologyFingerprint, METHODOLOGY_FINGERPRINT_V231);
assert.equal(freshBody?.methodologyFingerprint, METHODOLOGY_FINGERPRINT_V232);
assert.equal(freshBody?.version, "price-position-v2.3.2");
assert.equal(
  freshBody?.priceLevel.find((cell) => cell.scope === "DONG")?.meanPricePerSupplyPyeong,
  canonicalBody?.priceLevel.find((cell) => cell.scope === "DONG")?.meanPricePerSupplyPyeong,
);
assert.equal(canonicalBody?.sampleConfidenceVersion, "sample-confidence-v2");
assert.equal(canonicalBody?.regionTrendDefinition, "median_of_canonical_matched_complex_changes_trailing_6m_pooled_mean");
assert.equal(legacyBody?.priceLevel.find((cell) => cell.scope === "COMPLEX")?.meanPricePerSupplyPyeong, canonicalBody?.priceLevel.find((cell) => cell.scope === "COMPLEX")?.meanPricePerSupplyPyeong);

console.log("price-position-v23 tests ok");

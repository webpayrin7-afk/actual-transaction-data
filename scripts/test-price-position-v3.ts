import assert from "node:assert/strict";
import {
  buildPricePositionV3,
  classifySoftStaleV3,
  METHODOLOGY_FINGERPRINT_V3,
  PRICE_COPY_V3,
  PRICE_POSITION_V3_VERSION,
  pricePositionV3SnapshotId,
  REGION_PRICE_DEFINITION_V3,
} from "../src/lib/region-ranking/price-position-v3";
import { buildPricePositionV232 } from "../src/lib/region-ranking/price-position-v23";
import { PRICE_POSITION_PUBLIC_VERSION } from "../src/lib/region-ranking/price-position-read";
import type { ComplexIdentityV2, SupplySalePoint } from "../src/lib/region-ranking/price-position-v2";

assert.equal(pricePositionV3SnapshotId(), "price-position-v3|2026-09-17");
assert.equal(PRICE_POSITION_PUBLIC_VERSION, "price-position-v3");
assert.match(METHODOLOGY_FINGERPRINT_V3, /latest-active/);
assert.match(METHODOLOGY_FINGERPRINT_V3, /equal-complex-weight/);
assert.match(METHODOLOGY_FINGERPRINT_V3, /median-of-complex-means/);
assert.match(METHODOLOGY_FINGERPRINT_V3, /soft-stale/);
assert.equal(REGION_PRICE_DEFINITION_V3, "median_of_canonical_complex_latest_active_month_means_equal_weight");
assert.match(PRICE_COPY_V3, /최근 실거래/);

assert.equal(classifySoftStaleV3({ shareOver12Months: 0.1, shareOver24Months: 0.05, medianAgeMonths: 2 }), "FRESH");
assert.equal(classifySoftStaleV3({ shareOver12Months: 0.3, shareOver24Months: 0.05, medianAgeMonths: 3 }), "STALE_MIXED");
assert.equal(classifySoftStaleV3({ shareOver12Months: 0.3, shareOver24Months: 0.05, medianAgeMonths: 6 }), "STALE_HEAVY");
assert.equal(classifySoftStaleV3({ shareOver12Months: 0.1, shareOver24Months: 0.2, medianAgeMonths: 1 }), "STALE_HEAVY");

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

// A traded Sep, B traded Jun only, C never — latest-active should include A+B
const points = [
  point("cx_aaaaaaaaaaaaaaaa", "2026-09", 10000),
  point("cx_aaaaaaaaaaaaaaaa", "2025-09", 9000),
  point("cx_bbbbbbbbbbbbbbbb", "2026-06", 8000),
  point("cx_bbbbbbbbbbbbbbbb", "2025-06", 7000),
];
const universe = new Set(["cx_aaaaaaaaaaaaaaaa", "cx_bbbbbbbbbbbbbbbb", "cx_cccccccccccccccc"]);
const v3 = buildPricePositionV3({
  cohort,
  points,
  identities,
  cohortUniverse: universe,
  transactionAsOf: "2026-09-17",
}).bodies.find((row) => row.complexId === "cx_aaaaaaaaaaaaaaaa");
assert.ok(v3);
assert.equal(v3.version, PRICE_POSITION_V3_VERSION);
assert.equal(v3.methodologyFingerprint, METHODOLOGY_FINGERPRINT_V3);
const dong = v3.priceLevel.find((cell) => cell.scope === "DONG");
assert.ok(dong);
assert.equal(dong.contributingComplexCount, 2);
assert.equal(dong.canonicalCount, 3);
assert.equal(dong.historyUsableCount, 2);
assert.equal(dong.referenceMonth, null);
assert.equal(dong.asOfMonth, "2026-09");
assert.equal(dong.status, "INSUFFICIENT_SAMPLE"); // DONG min = 3
assert.equal(dong.meanPricePerSupplyPyeong, null);

// SAME_MONTH V2.3.2 would only count Sep traders (A only) → insufficient for DONG min 3,
// latest-active reaches C=2 still insufficient — add third trader in older month
identities.set("cx_dddddddddddddddd", {
  complexId: "cx_dddddddddddddddd",
  lawdCd: "11710",
  bjdongCd: "10100",
  aptName: "D",
  legalDongName: "잠실동",
});
universe.add("cx_dddddddddddddddd");
points.push(point("cx_dddddddddddddddd", "2026-03", 6000));
const v3b = buildPricePositionV3({
  cohort,
  points,
  identities,
  cohortUniverse: universe,
  transactionAsOf: "2026-09-17",
}).bodies.find((row) => row.complexId === "cx_aaaaaaaaaaaaaaaa");
const dongB = v3b?.priceLevel.find((cell) => cell.scope === "DONG");
assert.equal(dongB?.status, "ok");
assert.equal(dongB?.contributingComplexCount, 3);
assert.equal(dongB?.meanPricePerSupplyPyeong, 8000); // median 6000,8000,10000

// Trend methodology parity vs V2.3.2 on matched windows (same points that have Sept for A)
const trendPoints = [
  point("cx_aaaaaaaaaaaaaaaa", "2026-09", 10000),
  point("cx_aaaaaaaaaaaaaaaa", "2026-04", 9500),
  point("cx_aaaaaaaaaaaaaaaa", "2025-09", 9000),
  point("cx_aaaaaaaaaaaaaaaa", "2025-04", 8500),
  point("cx_bbbbbbbbbbbbbbbb", "2026-09", 5000),
  point("cx_bbbbbbbbbbbbbbbb", "2026-04", 4500),
  point("cx_bbbbbbbbbbbbbbbb", "2025-09", 4000),
  point("cx_bbbbbbbbbbbbbbbb", "2025-04", 3500),
];
const trendUniverse = new Set(["cx_aaaaaaaaaaaaaaaa", "cx_bbbbbbbbbbbbbbbb"]);
const args = {
  cohort,
  points: trendPoints,
  identities,
  cohortUniverse: trendUniverse,
  transactionAsOf: "2026-09-17",
};
const body232 = buildPricePositionV232(args).bodies.find((row) => row.complexId === "cx_aaaaaaaaaaaaaaaa");
const body3 = buildPricePositionV3(args).bodies.find((row) => row.complexId === "cx_aaaaaaaaaaaaaaaa");
assert.ok(body232 && body3);
for (const horizon of ["6M", "1Y", "2Y", "5Y"] as const) {
  const t232 = body232.trends[horizon].find((c) => c.scope === "DONG");
  const t3 = body3.trends[horizon].find((c) => c.scope === "DONG");
  assert.equal(t3?.changePercent, t232?.changePercent, horizon);
  assert.equal(t3?.matchedComplexCount, t232?.matchedComplexCount, horizon);
  assert.equal(t3?.sampleStatus, t232?.sampleStatus, horizon);
}

console.log("price-position-v3 tests ok");

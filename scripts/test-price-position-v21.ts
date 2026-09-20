import assert from "node:assert/strict";
import {
  buildPricePositionV21,
  METHODOLOGY_FINGERPRINT_V21,
  PRICE_MIN_COMPLEXES_V21,
  PRICE_POSITION_V21_VERSION,
  TREND_HORIZONS_V21,
  TREND_MIN_COMPLEXES_V21,
  pricePositionV21SnapshotId,
} from "../src/lib/region-ranking/price-position-v21";
import type { ComplexIdentityV2, SupplySalePoint } from "../src/lib/region-ranking/price-position-v2";

assert.equal(pricePositionV21SnapshotId("2026-09-17"), "price-position-v2.1|2026-09-17");
assert.equal(PRICE_POSITION_V21_VERSION, "price-position-v2.1");
assert.deepEqual([...TREND_HORIZONS_V21], ["6M", "1Y", "2Y", "5Y"]);
assert.equal(PRICE_MIN_COMPLEXES_V21.DONG, 3);
assert.equal(PRICE_MIN_COMPLEXES_V21.GU, 5);
assert.equal(PRICE_MIN_COMPLEXES_V21.SEOUL, 10);
assert.equal(TREND_MIN_COMPLEXES_V21.SEOUL, 10);
assert.ok(METHODOLOGY_FINGERPRINT_V21.includes("P2"));

const identities = new Map<string, ComplexIdentityV2>([
  ["cx_aaaaaaaaaaaaaaaa", { complexId: "cx_aaaaaaaaaaaaaaaa", lawdCd: "11710", bjdongCd: "10800", aptName: "A", legalDongName: "잠실동" }],
  ["cx_bbbbbbbbbbbbbbbb", { complexId: "cx_bbbbbbbbbbbbbbbb", lawdCd: "11710", bjdongCd: "10800", aptName: "B", legalDongName: "잠실동" }],
  ["cx_cccccccccccccccc", { complexId: "cx_cccccccccccccccc", lawdCd: "11710", bjdongCd: "10800", aptName: "C", legalDongName: "잠실동" }],
  ["cx_dddddddddddddddd", { complexId: "cx_dddddddddddddddd", lawdCd: "11710", bjdongCd: "10100", aptName: "D", legalDongName: "풍납동" }],
  ["cx_eeeeeeeeeeeeeeee", { complexId: "cx_eeeeeeeeeeeeeeee", lawdCd: "11680", bjdongCd: "10300", aptName: "E", legalDongName: "대치동" }],
]);

function pt(complexId: string, lawdCd: string, bjdongCd: string, ym: string, price: number): SupplySalePoint {
  return {
    complexId,
    lawdCd,
    bjdongCd,
    yearMonth: ym,
    pricePerSupplyPyeong: price,
    pricePerMarketPyeong: price,
    marketPyeongLabel: 33,
    dealAmount: price * 33,
    exclusiveArea: 84.88,
    supplyArea: 109.29,
    supplyPyeong: 33.06,
  };
}

const points: SupplySalePoint[] = [
  pt("cx_aaaaaaaaaaaaaaaa", "11710", "10800", "2026-09", 10000),
  pt("cx_aaaaaaaaaaaaaaaa", "11710", "10800", "2026-03", 9000),
  pt("cx_bbbbbbbbbbbbbbbb", "11710", "10800", "2026-09", 11000),
  pt("cx_bbbbbbbbbbbbbbbb", "11710", "10800", "2026-03", 10000),
  pt("cx_cccccccccccccccc", "11710", "10800", "2026-09", 12000),
  pt("cx_cccccccccccccccc", "11710", "10800", "2026-03", 11000),
  pt("cx_dddddddddddddddd", "11710", "10100", "2026-09", 5000),
  pt("cx_dddddddddddddddd", "11710", "10100", "2026-03", 4000),
  pt("cx_eeeeeeeeeeeeeeee", "11680", "10300", "2026-09", 8000),
  pt("cx_eeeeeeeeeeeeeeee", "11680", "10300", "2026-03", 7000),
];

const built = buildPricePositionV21({
  areaBand: "84",
  points,
  identities,
  transactionAsOf: "2026-09-17",
});
assert.equal(built.bodies.length, 5);
const a = built.bodies.find((body) => body.complexId === "cx_aaaaaaaaaaaaaaaa")!;
assert.equal(a.version, "price-position-v2.1");
assert.equal(a.supplyPyeongCohort, "30평대");
assert.ok(!("3M" in a.trends));
assert.ok(!("3Y" in a.trends));
assert.equal(a.priceLevel.find((c) => c.scope === "COMPLEX")?.meanPricePerSupplyPyeong, 10000);
const dong = a.priceLevel.find((c) => c.scope === "DONG")!;
assert.equal(dong.status, "ok");
assert.equal(dong.contributingComplexCount, 3);
assert.equal(dong.meanPricePerSupplyPyeong, 11000); // median(10000,11000,12000)
const trend6 = a.trends["6M"].find((c) => c.scope === "DONG")!;
assert.equal(trend6.status, "ok");
assert.equal(trend6.matchedComplexCount, 3);
assert.ok(trend6.changePercent != null);

console.log("price-position-v21 tests ok");

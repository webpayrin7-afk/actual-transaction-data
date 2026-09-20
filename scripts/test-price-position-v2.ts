import assert from "node:assert/strict";
import {
  BAND_TO_SUPPLY_COHORT,
  buildPricePositionV2,
  changePercentV2,
  exactSupplyPyeong,
  inSupplyCohort,
  pricePerSupplyPyeong,
  pricePositionV2SnapshotId,
  PRICE_POSITION_V2_VERSION,
  supplyPyeongCohortLabel,
} from "../src/lib/region-ranking/price-position-v2";

assert.equal(PRICE_POSITION_V2_VERSION, "price-position-v2");
assert.equal(pricePositionV2SnapshotId("2026-09-17"), "price-position-v2|2026-09-17");
assert.equal(supplyPyeongCohortLabel(33.06), "30평대");
assert.equal(inSupplyCohort(33.06, "84"), true);
assert.equal(inSupplyCohort(25, "84"), false);
assert.equal(BAND_TO_SUPPLY_COHORT["84"].label, "30평대");

const py = exactSupplyPyeong(109.29);
assert.ok(Math.abs(py - 109.29 / 3.305785) < 1e-9);
const price = pricePerSupplyPyeong(332500, 109.29);
assert.ok(price != null);
assert.ok(Math.abs(price! - 332500 / py) < 1e-6);
// ~1.0억/평 supply, not ~1.295억 exclusive-pyeong
assert.ok(price! > 9000 && price! < 12000);

assert.equal(changePercentV2(100, 101.36), -1.34);
assert.equal(changePercentV2(102.12, 100), 2.12);

const built = buildPricePositionV2({
  areaBand: "84",
  identities: new Map([
    ["cx_a", { complexId: "cx_a", lawdCd: "11710", bjdongCd: "10800", aptName: "A", legalDongName: "잠실동" }],
    ["cx_b", { complexId: "cx_b", lawdCd: "11710", bjdongCd: "10800", aptName: "B", legalDongName: "잠실동" }],
  ]),
  points: [
    { complexId: "cx_a", lawdCd: "11710", bjdongCd: "10800", yearMonth: "2026-09", pricePerSupplyPyeong: 10000, dealAmount: 330000, exclusiveArea: 84.88, supplyArea: 109.29, supplyPyeong: 33.06 },
    { complexId: "cx_a", lawdCd: "11710", bjdongCd: "10800", yearMonth: "2026-06", pricePerSupplyPyeong: 10100, dealAmount: 334400, exclusiveArea: 84.88, supplyArea: 109.29, supplyPyeong: 33.06 },
    { complexId: "cx_b", lawdCd: "11710", bjdongCd: "10800", yearMonth: "2026-09", pricePerSupplyPyeong: 9900, dealAmount: 320000, exclusiveArea: 84.9, supplyArea: 110, supplyPyeong: 33.27 },
    { complexId: "cx_b", lawdCd: "11710", bjdongCd: "10800", yearMonth: "2026-06", pricePerSupplyPyeong: 9800, dealAmount: 318000, exclusiveArea: 84.9, supplyArea: 110, supplyPyeong: 33.27 },
  ],
});
assert.ok(built.bodies.length >= 1);
const a = built.bodies.find((b) => b.complexId === "cx_a");
assert.ok(a);
assert.equal(a!.referenceMonth, "2026-09");
assert.equal(a!.priceLevelDefinition, "reference_month_mean_price_per_supply_pyeong");
const t3 = a!.trends["3M"].find((c) => c.scope === "DONG");
assert.ok(t3?.matchedComplexCount === 2);

console.log("price-position-v2 tests passed", { supplyPyeongPrice: Math.round(price! * 100) / 100 });

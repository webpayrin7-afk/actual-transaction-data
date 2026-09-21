import assert from "node:assert/strict";
import { buildPricePositionV21 } from "../src/lib/region-ranking/price-position-v21";
import type { ComplexIdentityV2, SupplySalePoint } from "../src/lib/region-ranking/price-position-v2";
import {
  DECADE_COHORTS_V22,
  METHODOLOGY_FINGERPRINT_V22,
  PRICE_POSITION_V22_VERSION,
  buildPricePositionV22,
  decadeCohortForLabel,
  pricePositionV22SnapshotId,
  resolveV22PricePositionRequest,
} from "../src/lib/region-ranking/price-position-v22";

assert.equal(pricePositionV22SnapshotId("2026-09-17"), "price-position-v2.2|2026-09-17");
assert.equal(PRICE_POSITION_V22_VERSION, "price-position-v2.2");
assert.ok(METHODOLOGY_FINGERPRINT_V22.includes("region-all-decade-cohorts"));
assert.ok(METHODOLOGY_FINGERPRINT_V22.includes("complex-exact-market-label"));
assert.equal(DECADE_COHORTS_V22.length, 10);

assert.equal(decadeCohortForLabel(18)?.label, "10평대");
assert.equal(decadeCohortForLabel(10)?.key, "10");
assert.equal(decadeCohortForLabel(19)?.key, "10");
assert.equal(decadeCohortForLabel(24)?.label, "20평대");
assert.equal(decadeCohortForLabel(33)?.label, "30평대");
assert.equal(decadeCohortForLabel(33)?.key, "30");
assert.equal(decadeCohortForLabel(43)?.label, "40평대");
assert.equal(decadeCohortForLabel(52)?.label, "50평대");
assert.equal(decadeCohortForLabel(99)?.label, "90평대");
assert.equal(decadeCohortForLabel(100)?.label, "100평+");
assert.equal(decadeCohortForLabel(140)?.key, "100");
assert.equal(decadeCohortForLabel(9), null);

assert.deepEqual(
  resolveV22PricePositionRequest({
    areaBandRaw: "",
    exclusiveArea: 49.5,
    label: { kind: "exact", marketPyeongLabel: 18 },
  }),
  { ok: true, decadeKey: "10", regionPyeongDecade: "10평대", exclusiveArea: 49.5 },
);
assert.deepEqual(
  resolveV22PricePositionRequest({
    areaBandRaw: "84",
    exclusiveArea: 99.2,
    label: { kind: "exact", marketPyeongLabel: 33 },
  }),
  { ok: true, decadeKey: "30", regionPyeongDecade: "30평대", exclusiveArea: 99.2 },
);
assert.deepEqual(
  resolveV22PricePositionRequest({
    areaBandRaw: "",
    exclusiveArea: 84.88,
    label: { kind: "exact", marketPyeongLabel: 33 },
  }),
  { ok: true, decadeKey: "30", regionPyeongDecade: "30평대", exclusiveArea: 84.88 },
);
assert.equal(
  resolveV22PricePositionRequest({
    areaBandRaw: "59",
    exclusiveArea: 84.88,
    label: { kind: "exact", marketPyeongLabel: 33 },
  }).ok,
  false,
);
assert.equal(
  resolveV22PricePositionRequest({
    areaBandRaw: "",
    exclusiveArea: 49.5,
    label: { kind: "missing" },
  }).ok,
  false,
);
assert.deepEqual(
  resolveV22PricePositionRequest({ areaBandRaw: "114", exclusiveArea: null, label: null }),
  { ok: true, decadeKey: "40", regionPyeongDecade: "40평대", exclusiveArea: null },
);
assert.deepEqual(
  resolveV22PricePositionRequest({ areaBandRaw: "100", exclusiveArea: null, label: null }),
  { ok: true, decadeKey: "100", regionPyeongDecade: "100평+", exclusiveArea: null },
);

const identities = new Map<string, ComplexIdentityV2>([
  ["cx_aaaaaaaaaaaaaaaa", { complexId: "cx_aaaaaaaaaaaaaaaa", lawdCd: "11710", bjdongCd: "10800", aptName: "A", legalDongName: "잠실동" }],
  ["cx_bbbbbbbbbbbbbbbb", { complexId: "cx_bbbbbbbbbbbbbbbb", lawdCd: "11710", bjdongCd: "10800", aptName: "B", legalDongName: "잠실동" }],
  ["cx_cccccccccccccccc", { complexId: "cx_cccccccccccccccc", lawdCd: "11710", bjdongCd: "10800", aptName: "C", legalDongName: "잠실동" }],
]);

function pt(complexId: string, price: number, label: number): SupplySalePoint {
  return {
    complexId,
    lawdCd: "11710",
    bjdongCd: "10800",
    yearMonth: "2026-09",
    pricePerSupplyPyeong: price,
    pricePerMarketPyeong: price,
    marketPyeongLabel: label,
    dealAmount: price * label,
    exclusiveArea: 84.8,
    supplyArea: label * 3.3,
    supplyPyeong: label,
  };
}

const points = [
  pt("cx_aaaaaaaaaaaaaaaa", 10000, 33),
  pt("cx_bbbbbbbbbbbbbbbb", 11000, 33),
  pt("cx_cccccccccccccccc", 12000, 33),
];
const v21 = buildPricePositionV21({ areaBand: "84", points, identities, transactionAsOf: "2026-09-17" });
const cohort = DECADE_COHORTS_V22.find((row) => row.key === "30")!;
const v22 = buildPricePositionV22({ cohort, points, identities, transactionAsOf: "2026-09-17" });
assert.equal(v22.bodies.length, 3);
const left = v21.bodies.find((body) => body.complexId === "cx_aaaaaaaaaaaaaaaa")!;
const right = v22.bodies.find((body) => body.complexId === "cx_aaaaaaaaaaaaaaaa")!;
assert.equal(right.version, "price-position-v2.2");
assert.equal(right.areaBand, "30");
assert.equal(right.regionPyeongDecade, "30평대");
assert.equal(right.cohortKey, "30");
assert.equal(right.methodologyFingerprint, METHODOLOGY_FINGERPRINT_V22);
assert.equal(left.priceLevel.find((cell) => cell.scope === "DONG")?.meanPricePerSupplyPyeong, right.priceLevel.find((cell) => cell.scope === "DONG")?.meanPricePerSupplyPyeong);
assert.equal(left.complexExactByMarketLabel["33"]?.priceLevel.meanPricePerSupplyPyeong, 10000);
assert.equal(right.complexExactByMarketLabel["33"]?.priceLevel.meanPricePerSupplyPyeong, 10000);

console.log("price-position-v22 tests ok");

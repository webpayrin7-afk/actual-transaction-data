import assert from "node:assert/strict";
import { buildPricePositionV23 } from "../src/lib/region-ranking/price-position-v23";
import {
  dataCoverageStatusV2,
  SAMPLE_CONFIDENCE_VERSION,
  SAMPLE_STATUS_COPY_V2,
  sampleStatusV2,
} from "../src/lib/region-ranking/sample-confidence-v2";
import type { ComplexIdentityV2, SupplySalePoint } from "../src/lib/region-ranking/price-position-v2";

assert.equal(sampleStatusV2({ windowAvailable: true, matched: 8, canonicalHistory: 8 }), "SAMPLE_ADEQUATE");
assert.equal(sampleStatusV2({ windowAvailable: true, matched: 8, canonicalHistory: 10 }), "SAMPLE_ADEQUATE");
assert.equal(sampleStatusV2({ windowAvailable: true, matched: 10, canonicalHistory: 10 }), "SAMPLE_ADEQUATE");
assert.equal(sampleStatusV2({ windowAvailable: true, matched: 15, canonicalHistory: 15 }), "SAMPLE_ADEQUATE");
assert.equal(sampleStatusV2({ windowAvailable: true, matched: 5, canonicalHistory: 5 }), "SAMPLE_LIMITED");
assert.equal(sampleStatusV2({ windowAvailable: true, matched: 6, canonicalHistory: 10 }), "SAMPLE_LIMITED");
assert.equal(sampleStatusV2({ windowAvailable: true, matched: 3, canonicalHistory: 100 }), "SAMPLE_SEVERELY_LIMITED");
assert.equal(sampleStatusV2({ windowAvailable: true, matched: 800, canonicalHistory: 3000 }), "SAMPLE_ADEQUATE");
assert.equal(sampleStatusV2({ windowAvailable: true, matched: 12, canonicalHistory: 80 }), "SAMPLE_LIMITED");
assert.equal(sampleStatusV2({ windowAvailable: true, matched: 20, canonicalHistory: 400 }), "SAMPLE_SEVERELY_LIMITED");
assert.equal(sampleStatusV2({ windowAvailable: false, matched: 0, canonicalHistory: 10 }), "HORIZON_UNAVAILABLE");
assert.equal(sampleStatusV2({ windowAvailable: true, matched: 773, canonicalHistory: 3374 }), "SAMPLE_ADEQUATE");
assert.equal(dataCoverageStatusV2(18, 100), "DATA_COVERAGE_LIMITED");
assert.equal(sampleStatusV2({ windowAvailable: true, matched: 18, canonicalHistory: 20 }), "SAMPLE_ADEQUATE");
assert.equal(dataCoverageStatusV2(10, 100), "DATA_COVERAGE_LOW");
assert.equal(dataCoverageStatusV2(40, 100), "DATA_COVERAGE_ADEQUATE");
assert.equal(SAMPLE_STATUS_COPY_V2.SAMPLE_ADEQUATE, null);
assert.equal(SAMPLE_STATUS_COPY_V2.SAMPLE_LIMITED, "표본 제한");
assert.equal(SAMPLE_STATUS_COPY_V2.SAMPLE_SEVERELY_LIMITED, "참고용");
assert.equal(SAMPLE_STATUS_COPY_V2.HORIZON_UNAVAILABLE, null);
assert.equal(JSON.stringify(SAMPLE_STATUS_COPY_V2).includes("표본 적음"), false);

function point(complexId: string, yearMonth: string, price: number): SupplySalePoint {
  return {
    complexId,
    lawdCd: "11710",
    bjdongCd: "10100",
    yearMonth,
    pricePerSupplyPyeong: price,
    pricePerMarketPyeong: price,
    marketPyeongLabel: 33,
    dealAmount: price * 33,
    exclusiveArea: 84,
    supplyArea: 109,
    supplyPyeong: 33,
  };
}

const identities = new Map<string, ComplexIdentityV2>();
const universe = new Set<string>();
for (let i = 0; i < 10; i += 1) {
  const complexId = `cx_${String(i).padStart(16, "0")}`;
  universe.add(complexId);
  identities.set(complexId, {
    complexId,
    lawdCd: "11710",
    bjdongCd: "10100",
    aptName: `C${i}`,
    legalDongName: "잠실동",
  });
}
const points: SupplySalePoint[] = [];
for (const complexId of universe) {
  points.push(point(complexId, "2026-09", 10000));
  points.push(point(complexId, "2021-08", 8000));
}
const partial = buildPricePositionV23({
  cohort: { key: "30", min: 30, max: 40, label: "30평대" },
  points,
  identities,
  cohortUniverse: universe,
  transactionAsOf: "2026-09-17",
});
const partialCell = partial.bodies[0]!.trends["5Y"].find((cell) => cell.scope === "DONG");
assert.equal(partialCell?.windowStatus, "PARTIAL_HISTORY_WINDOW");
assert.equal(partialCell?.sampleStatus, "SAMPLE_ADEQUATE");
assert.equal(partialCell?.sampleConfidenceVersion, SAMPLE_CONFIDENCE_VERSION);
assert.equal(partial.bodies[0]!.sampleConfidenceVersion, SAMPLE_CONFIDENCE_VERSION);

const earlyId = "cx_ffffffffffffffff";
const early = buildPricePositionV23({
  cohort: { key: "30", min: 30, max: 40, label: "30평대" },
  points: [point(earlyId, "2024-06", 10000), point(earlyId, "2024-01", 9000)],
  identities: new Map([
    [earlyId, { complexId: earlyId, lawdCd: "11710", bjdongCd: "10100", aptName: "E", legalDongName: "잠실동" }],
  ]),
  cohortUniverse: new Set([earlyId]),
  transactionAsOf: "2026-09-17",
});
const missing = early.bodies[0]!.trends["5Y"].find((cell) => cell.scope === "SEOUL");
assert.equal(missing?.windowStatus ?? null, null);
assert.equal(missing?.sampleStatus, "HORIZON_UNAVAILABLE");
assert.notEqual(missing?.sampleStatus, "SAMPLE_SEVERELY_LIMITED");
assert.notEqual(missing?.sampleStatus, "SAMPLE_LIMITED");

console.log("sample-confidence-v2 tests ok");

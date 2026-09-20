import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { precheckAdditiveCreateSql } from "../src/lib/region-ranking/migration-precheck";
import { resolveSelectedAreaBand } from "../src/lib/region-ranking/area-band";
import {
  canonicalSupplyPyeong,
  canonicalUnitTypeId,
  exactSupplyPyeong,
  exclusiveCents,
  pricePerExclusiveSqm,
  pricePerSupplyPyeong,
  resolutionStatus,
  supplyPyeongCohort,
  SUPPLY_PYEONG_FACTOR,
} from "../src/lib/unit-type/canonical";
import {
  complexHasCanonicalSupplyLabel,
  selectorSupplyOption,
  supplyPyeongDisplayLabel,
} from "../src/lib/unit-type/supply-label";

assert.equal(SUPPLY_PYEONG_FACTOR, 3.305785);
assert.equal(exclusiveCents(84.88), 8488);
assert.equal(exclusiveCents(84.8), 8480);
assert.equal(exclusiveCents(84.97), 8497);
assert.equal(canonicalSupplyPyeong(109.29), 33.06);
assert.equal(supplyPyeongDisplayLabel(109.29), "33평");
assert.notEqual(supplyPyeongDisplayLabel(109.29), `${Math.round(84.88 / SUPPLY_PYEONG_FACTOR)}평`);
assert.equal(Math.round(exactSupplyPyeong(111.52) * 100) / 100, 33.73);
assert.equal(supplyPyeongDisplayLabel(111.52), "34평");

const jamsil = [
  [8480, 11152],
  [8488, 10929],
  [8497, 10947],
] as const;
const ids = jamsil.map(([ex, su]) => canonicalUnitTypeId("cx_4c63d9a100973c60", ex, su));
assert.equal(new Set(ids).size, 3);
for (const [ex, su] of jamsil) {
  assert.equal(resolutionStatus(1, false), "EXACT_SINGLE");
  assert.equal(canonicalUnitTypeId("cx_4c63d9a100973c60", ex, su), canonicalUnitTypeId("cx_4c63d9a100973c60", ex, su));
}

const banpoA = canonicalUnitTypeId("cx_1c244e7305d12c44", 8498, 11612);
const banpoB = canonicalUnitTypeId("cx_1c244e7305d12c44", 8498, 11671);
assert.notEqual(banpoA, banpoB);
assert.equal(resolutionStatus(2, false), "AMBIGUOUS_MULTI");
assert.equal(resolutionStatus(2, true), "EXACT_MULTI_RESOLVABLE");
assert.equal(resolutionStatus(0, false), "NO_SOURCE");

assert.equal(supplyPyeongCohort(33.06), "30평대");
assert.equal(supplyPyeongCohort(30), "30평대");
assert.equal(supplyPyeongCohort(39.99), "30평대");
assert.equal(supplyPyeongCohort(40), "40평대");
assert.equal(resolveSelectedAreaBand(84.88), "84");

const deal = 332500;
const supplyPrice = pricePerSupplyPyeong(deal, 109.29);
assert.ok(supplyPrice != null);
assert.ok(Math.abs(supplyPrice - deal / exactSupplyPyeong(109.29)) < 1e-6);
const exclusiveMetric = pricePerExclusiveSqm(deal, 84.88);
assert.ok(exclusiveMetric != null);
assert.ok(Math.abs((exclusiveMetric * SUPPLY_PYEONG_FACTOR) - supplyPrice) > 1000);

const exact = selectorSupplyOption({
  unitTypeId: ids[1]!,
  exclusiveArea: 84.88,
  supplyArea: 109.29,
  status: "EXACT_SINGLE",
});
assert.equal(exact?.displayLabel, "33평");
assert.equal(exact?.detailLabel, "33평 · 전용 84.88㎡");
assert.equal(exact?.usableForUnscopedTrade, true);
assert.equal(exact?.supplyPyeong, 33.06);

const ambiguous = selectorSupplyOption({
  unitTypeId: banpoA,
  exclusiveArea: 84.98,
  supplyArea: 116.12,
  status: "AMBIGUOUS_MULTI",
});
assert.equal(ambiguous?.usableForUnscopedTrade, false);
assert.equal(
  selectorSupplyOption({
    unitTypeId: "ut_none",
    exclusiveArea: 84.88,
    supplyArea: null,
    status: "NO_SOURCE",
  }),
  null,
);
assert.equal(
  complexHasCanonicalSupplyLabel([
    { unitTypeId: ids[1]!, exclusiveArea: 84.88, supplyArea: 109.29, status: "EXACT_SINGLE" },
  ]),
  true,
);
assert.equal(
  complexHasCanonicalSupplyLabel([
    { unitTypeId: banpoA, exclusiveArea: 84.98, supplyArea: 116.12, status: "AMBIGUOUS_MULTI" },
  ]),
  false,
);

const migration = readFileSync("src/lib/db/migrations/20260923_canonical_unit_types.sql", "utf8");
const precheck = precheckAdditiveCreateSql(migration);
assert.equal(precheck.ok, true);

console.log("canonical unit supply tests passed");

/**
 * Phase 1.4B targeted checks (UNIT_EXACT public-price pilot + holding tax wiring).
 *   npx tsx scripts/test-holding-public-price.ts
 */
import assert from "node:assert/strict";
import {
  calculateHoldingTax,
  getComplexPublicPrices,
} from "../src/lib/calculator";

const exact = getComplexPublicPrices({
  complexId: "cx_4c63d9a100973c60",
  complexName: "잠실엘스",
  areaKey: "84.8-84.97",
  exclusiveAreaMinSqm: 84.8,
  exclusiveAreaMaxSqm: 84.97,
  year: 2025,
  dong: "131",
  ho: "101",
});
assert.equal(exact.autoLink, "PASS");
assert.equal(exact.status, "linked");
assert.equal(exact.matchType, "UNIT_EXACT");
assert.equal(exact.priceMan, 171_600);
assert.equal(exact.officialPriceWon, 1_716_000_000);
assert.equal(exact.exclusiveArea, 84.97);
assert.equal(exact.dong, "131");
assert.equal(exact.ho, "101");
assert.equal(exact.unitLinkage, true);
assert.equal(exact.priceBaseYear, 2025);
assert.equal(exact.officialPriceDate, "2025-01-01");
assert.equal(exact.buildingRegisterPk, "10251100214253");

const for2026 = getComplexPublicPrices({
  complexId: "cx_4c63d9a100973c60",
  exclusiveAreaMinSqm: 84.8,
  exclusiveAreaMaxSqm: 84.97,
  year: 2026,
});
assert.equal(for2026.matchType, "UNIT_EXACT");
assert.equal(for2026.usedPriorBulkYear, true);
assert.equal(for2026.priceBaseYear, 2025);
assert.equal(for2026.priceMan, 171_600);

const missing = getComplexPublicPrices({
  complexName: "다른단지",
  exclusiveAreaSqm: 84.97,
  year: 2025,
});
assert.equal(missing.matchType, "SOURCE_LINK_MISSING");
assert.equal(missing.autoLink, "HOLD");

const holding = calculateHoldingTax({
  officialPriceMan: exact.priceMan!,
  singleHomeHousehold: true,
  includeUrbanShare: true,
});
assert.ok(holding.years[0]!.totalMan > 0);
assert.ok(holding.estimateDisclaimer.includes("예상"));

console.log("test-holding-public-price: ok", {
  matchType: exact.matchType,
  priceMan: exact.priceMan,
  holdingTotalMan: Math.round(holding.years[0]!.totalMan),
  usedPriorBulkYear: for2026.usedPriorBulkYear,
});

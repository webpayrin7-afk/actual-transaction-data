/**
 * Phase 1.4 targeted checks only (public-price HOLD + holding settings inputs).
 *   npx tsx scripts/test-holding-public-price.ts
 */
import assert from "node:assert/strict";
import {
  calculateHoldingTax,
  getComplexPublicPrices,
} from "../src/lib/calculator";

const publicPrice = getComplexPublicPrices({
  complexId: "cx_4c63d9a100973c60",
  complexName: "잠실엘스",
  areaKey: "84.8-84.97",
  exclusiveAreaMinSqm: 84.8,
  exclusiveAreaMaxSqm: 84.97,
  year: 2026,
});
assert.equal(publicPrice.autoLink, "HOLD");
assert.equal(publicPrice.status, "unavailable");
assert.equal(publicPrice.priceMan, null);
assert.equal(publicPrice.unitLinkage, false);
assert.ok((publicPrice.blocker ?? "").length > 0);

const oneHome = calculateHoldingTax({
  officialPriceMan: 168_000,
  singleHomeHousehold: true,
  includeUrbanShare: true,
  projectionYears: 1,
  officialPriceGrowthRate: 0.03,
});
assert.equal(oneHome.years.length, 2);
assert.ok(oneHome.years[0]!.totalMan > 0);
assert.ok(oneHome.estimateDisclaimer.includes("예상"));

const multi = calculateHoldingTax({
  officialPriceMan: 168_000,
  singleHomeHousehold: false,
  includeUrbanShare: true,
});
assert.ok(multi.years[0]!.totalMan !== oneHome.years[0]!.totalMan);

console.log("test-holding-public-price: ok", {
  autoLink: publicPrice.autoLink,
  oneHomeTotalMan: Math.round(oneHome.years[0]!.totalMan),
  multiTotalMan: Math.round(multi.years[0]!.totalMan),
});

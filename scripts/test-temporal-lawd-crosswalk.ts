/**
 * Temporal lawd crosswalk unit tests.
 *   npx tsx scripts/test-temporal-lawd-crosswalk.ts
 */
import assert from "node:assert/strict";
import {
  APTTRADE_ADMIN_EFFECTIVE_DATE,
  APTTRADE_ADMIN_EFFECTIVE_YM,
  aptTradeRequestLawdForMonth,
  aptTradeRequestLawdsForCatalog,
  canonicalLawdFromHistoricalAdmin,
  classifyIncheonNodataCode,
  gwangjuJeonnamMappingCoverage,
  historicalAdminLawdFromCanonical,
  isYmBeforeAdminChange,
  planAptTradeRequestLawd,
  validateTemporalRollingPlan,
} from "../src/lib/molit/temporal-lawd";
import {
  aptTradeMappingStatus,
  toAptTradeRequestLawd,
  toAptTradeRequestLawds,
} from "../src/lib/molit/aptrade-lawd-mapping";
import { metroFromLawdNationwide } from "../src/lib/constants/nationwide-lawd";

assert.equal(APTTRADE_ADMIN_EFFECTIVE_DATE, "2026-07-01");
assert.equal(APTTRADE_ADMIN_EFFECTIVE_YM, "202607");
assert.equal(isYmBeforeAdminChange("202606"), true);
assert.equal(isYmBeforeAdminChange("202607"), false);
assert.equal(isYmBeforeAdminChange("202608"), false);

// Official pairs
assert.equal(historicalAdminLawdFromCanonical("12210"), "29110");
assert.equal(historicalAdminLawdFromCanonical("12330"), "29200");
assert.equal(historicalAdminLawdFromCanonical("12110"), "46110");
assert.equal(historicalAdminLawdFromCanonical("12870"), "46910");
assert.equal(canonicalLawdFromHistoricalAdmin("29110"), "12210");
assert.equal(canonicalLawdFromHistoricalAdmin("46110"), "12110");

const cov = gwangjuJeonnamMappingCoverage();
assert.equal(cov.exact, 27);
assert.equal(cov.ambiguous, 0);
assert.equal(cov.unmapped, 0);

// MOLIT request = canonical for all months (probe-backed)
assert.equal(
  aptTradeRequestLawdForMonth({
    canonicalOrCatalogLawd: "29110",
    yearMonth: "202405",
  }),
  "12210",
);
assert.equal(
  aptTradeRequestLawdForMonth({
    canonicalOrCatalogLawd: "29110",
    yearMonth: "202608",
  }),
  "12210",
);
assert.equal(
  aptTradeRequestLawdForMonth({
    canonicalOrCatalogLawd: "12210",
    yearMonth: "202301",
  }),
  "12210",
);

// Incheon classifications
assert.equal(classifyIncheonNodataCode("28110").classification, "TEMPORAL_CODE_ISSUE");
assert.deepEqual(classifyIncheonNodataCode("28110").successors.sort(), [
  "28125",
  "28155",
].sort());
assert.equal(classifyIncheonNodataCode("28140").classification, "TEMPORAL_CODE_ISSUE");
assert.deepEqual(classifyIncheonNodataCode("28140").successors, ["28125"]);
assert.equal(classifyIncheonNodataCode("28260").classification, "TEMPORAL_CODE_ISSUE");
assert.deepEqual(classifyIncheonNodataCode("28260").successors.sort(), [
  "28275",
  "28290",
].sort());
assert.equal(classifyIncheonNodataCode("28720").classification, "TRUE_NODATA");

assert.ok(aptTradeRequestLawdsForCatalog("28260").includes("28275"));
assert.ok(aptTradeRequestLawdsForCatalog("28260").includes("28290"));

const status = aptTradeMappingStatus();
assert.equal(status.gwangju, "TEMPORAL_CROSSWALK_PASS");
assert.equal(status.jeonnam, "TEMPORAL_CROSSWALK_PASS");
assert.equal(toAptTradeRequestLawd("29140"), "12240");
assert.ok(toAptTradeRequestLawds("28110").includes("28125"));

// 12xxx metro split (전남광주통합특별시)
assert.equal(metroFromLawdNationwide("12210"), "gwangju");
assert.equal(metroFromLawdNationwide("12330"), "gwangju");
assert.equal(metroFromLawdNationwide("12110"), "jeonnam");
assert.equal(metroFromLawdNationwide("12870"), "jeonnam");
assert.equal(metroFromLawdNationwide("29110"), "gwangju");
assert.equal(metroFromLawdNationwide("46110"), "jeonnam");

// Rolling refresh temporal planner (pre/post 2026-07)
assert.equal(planAptTradeRequestLawd("29110", "202606"), "12210");
assert.equal(planAptTradeRequestLawd("29110", "202607"), "12210");
assert.equal(planAptTradeRequestLawd("46110", "202606"), "12110");
assert.equal(planAptTradeRequestLawd("12210", "202608"), "12210");
assert.equal(planAptTradeRequestLawd("28110", "202606"), "28125");
assert.equal(planAptTradeRequestLawd("28110", "202608"), "28125");
const rolling = validateTemporalRollingPlan([
  { lawdCd: "12210", yearMonth: "202606" },
  { lawdCd: "12210", yearMonth: "202607" },
  { lawdCd: "29110", yearMonth: "202606" },
]);
assert.equal(rolling.temporalAware, true);
assert.ok(rolling.boundarySamples.length >= 2);
assert.ok(
  rolling.mismatched.some(
    (m) => m.catalogOrSyncLawd === "29110" && m.expected === "12210",
  ),
);

console.log(
  JSON.stringify({
    ok: true,
    cases: [
      "effective-date-boundary",
      "gwangju-jeonnam-27-exact",
      "request-planner-canonical",
      "incheon-4-classification",
      "mapping-status-pass",
      "metro-12xxx-split",
      "rolling-refresh-temporal-plan",
    ],
  }),
);

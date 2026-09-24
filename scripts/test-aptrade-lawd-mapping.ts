/**
 * Mapping hold / request façade tests (post temporal lift).
 *   npx tsx scripts/test-aptrade-lawd-mapping.ts
 */
import assert from "node:assert/strict";
import {
  aptTradeMappingStatus,
  isAptTradeMappingHoldLawd,
  mappingHoldLawds,
  toAptTradeRequestLawd,
  toAptTradeRequestLawds,
} from "../src/lib/molit/aptrade-lawd-mapping";

const status = aptTradeMappingStatus();
assert.equal(status.gwangju, "TEMPORAL_CROSSWALK_PASS");
assert.equal(status.jeonnam, "TEMPORAL_CROSSWALK_PASS");
assert.equal(status.sourceSpecificLawdMapping, true);
assert.equal(status.temporalEffectiveDate, "2026-07-01");
assert.equal(isAptTradeMappingHoldLawd("29110"), false);
assert.equal(isAptTradeMappingHoldLawd("46110"), false);
assert.equal(mappingHoldLawds().length, 0);
assert.equal(toAptTradeRequestLawd("42110"), "51110");
assert.equal(toAptTradeRequestLawd("45111"), "52111");
assert.equal(toAptTradeRequestLawd("29110"), "12210");
assert.equal(toAptTradeRequestLawd("46110"), "12110");
assert.ok(toAptTradeRequestLawds("28260").includes("28275"));
assert.ok(toAptTradeRequestLawds("28260").includes("28290"));

console.log(
  JSON.stringify({
    ok: true,
    hold: 0,
    remap: {
      "42110": toAptTradeRequestLawd("42110"),
      "29110": toAptTradeRequestLawd("29110"),
      "28260": toAptTradeRequestLawds("28260"),
    },
  }),
);

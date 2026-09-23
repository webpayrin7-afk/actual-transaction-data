/**
 * Mapping hold unit checks for AptTrade lawd separation.
 *   npx tsx scripts/test-aptrade-lawd-mapping.ts
 */
import assert from "node:assert/strict";
import {
  aptTradeMappingStatus,
  isAptTradeMappingHoldLawd,
  mappingHoldLawds,
  runnableAptTradeLawds,
  toAptTradeRequestLawd,
} from "../src/lib/molit/aptrade-lawd-mapping";

const status = aptTradeMappingStatus();
assert.equal(status.gwangju, "MAPPING_HOLD");
assert.equal(status.jeonnam, "MAPPING_HOLD");
assert.equal(status.sourceSpecificLawdMapping, true);
assert.equal(isAptTradeMappingHoldLawd("29110"), true);
assert.equal(isAptTradeMappingHoldLawd("29200"), true);
assert.equal(isAptTradeMappingHoldLawd("46110"), true);
assert.equal(isAptTradeMappingHoldLawd("46910"), true);
assert.equal(isAptTradeMappingHoldLawd("28110"), false);
assert.equal(isAptTradeMappingHoldLawd("26350"), false);
assert.equal(isAptTradeMappingHoldLawd("11110"), false);
assert.equal(toAptTradeRequestLawd("42110"), "51110");
assert.equal(toAptTradeRequestLawd("45111"), "52111");
assert.equal(toAptTradeRequestLawd("51110"), "51110");
assert.equal(toAptTradeRequestLawd("28177"), "28177");
assert.equal(mappingHoldLawds().length, 27);
assert.equal(runnableAptTradeLawds().length, 227);
assert.ok(!runnableAptTradeLawds().some((c) => c.startsWith("29") || c.startsWith("46")));

console.log(
  JSON.stringify({
    ok: true,
    hold: mappingHoldLawds().length,
    runnable: runnableAptTradeLawds().length,
    remap: { "42110": toAptTradeRequestLawd("42110"), "45111": toAptTradeRequestLawd("45111") },
  }),
);

import assert from "node:assert/strict";
import { median, rankPricePerSqm, rankTradeVolume, PRICE_PER_SQM_MIN_TRADES } from "../src/lib/region-ranking/objective-rank";
import { assessRegionBoard, REGION_BOARD_MIN_ELIGIBLE } from "../src/lib/region-ranking/region-board";

assert.equal(median([3, 1, 2]), 2);
assert.equal(median([1, 2, 3, 4]), 2.5);
assert.equal(median([]), null);

const volume = rankTradeVolume([
  { complexId: "cx_b", tradeCount3m: 4, latestDealDate: "2026-09-01", medianPricePerSqm3m: 1 },
  { complexId: "cx_a", tradeCount3m: 4, latestDealDate: "2026-09-01", medianPricePerSqm3m: 9 },
  { complexId: "cx_c", tradeCount3m: 9, latestDealDate: "2026-08-01", medianPricePerSqm3m: 1 },
  { complexId: "cx_d", tradeCount3m: 4, latestDealDate: "2026-09-10", medianPricePerSqm3m: 1 },
  { complexId: "cx_z", tradeCount3m: 0, latestDealDate: "2026-09-17", medianPricePerSqm3m: 99 },
]);
assert.deepEqual(volume.map((row) => row.complexId), ["cx_c", "cx_d", "cx_a", "cx_b"]);
assert.deepEqual(volume.map((row) => row.rank), [1, 2, 3, 4]);
assert.equal(JSON.stringify(rankTradeVolume(volume)), JSON.stringify(rankTradeVolume(volume)));

const price = rankPricePerSqm([
  { complexId: "cx_low", tradeCount3m: 10, latestDealDate: "2026-09-01", medianPricePerSqm3m: 100 },
  { complexId: "cx_high_thin", tradeCount3m: PRICE_PER_SQM_MIN_TRADES - 1, latestDealDate: "2026-09-17", medianPricePerSqm3m: 9999 },
  { complexId: "cx_high", tradeCount3m: 3, latestDealDate: "2026-09-02", medianPricePerSqm3m: 500 },
  { complexId: "cx_tie_b", tradeCount3m: 3, latestDealDate: "2026-09-02", medianPricePerSqm3m: 500 },
  { complexId: "cx_tie_a", tradeCount3m: 8, latestDealDate: "2026-09-02", medianPricePerSqm3m: 500 },
]);
assert.deepEqual(price.map((row) => row.complexId), ["cx_tie_a", "cx_high", "cx_tie_b", "cx_low"]);
assert.equal(price.some((row) => row.complexId === "cx_high_thin"), false);

const partialDoesNotHold = assessRegionBoard({
  eligibleCount: 8,
  ranks: [1, 2, 3, 4, 5, 6, 7, 8],
  deterministic: true,
});
assert.equal(partialDoesNotHold, "PASS");
assert.equal(
  assessRegionBoard({ eligibleCount: REGION_BOARD_MIN_ELIGIBLE - 1, ranks: [1, 2, 3, 4], deterministic: true }),
  "REGION_INSUFFICIENT_COHORT",
);
assert.equal(
  assessRegionBoard({ eligibleCount: 5, ranks: [1, 2, 3, 5, 6], deterministic: true }),
  "HOLD_RANK_INTEGRITY",
);

console.log(JSON.stringify({ ok: true }));

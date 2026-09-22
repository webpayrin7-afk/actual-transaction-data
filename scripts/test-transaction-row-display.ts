/**
 * Unit checks for archive contract-type / column semantics.
 *   npx tsx scripts/test-transaction-row-display.ts
 */
import assert from "node:assert/strict";
import { archiveContractTypeLabel } from "../src/lib/apt/transaction-row-display";

assert.equal(archiveContractTypeLabel("trade", "중개거래"), null);
assert.equal(archiveContractTypeLabel("trade", "신규"), null);
assert.equal(archiveContractTypeLabel("jeonse", "신규"), "신규");
assert.equal(archiveContractTypeLabel("jeonse", "신규계약"), "신규");
assert.equal(archiveContractTypeLabel("monthly", "갱신"), "갱신");
assert.equal(archiveContractTypeLabel("monthly", "갱신계약"), "갱신");
assert.equal(archiveContractTypeLabel("jeonse", "전월세"), null);
assert.equal(archiveContractTypeLabel("jeonse", ""), null);
assert.equal(archiveContractTypeLabel("jeonse", null), null);
assert.equal(archiveContractTypeLabel("jeonse", undefined), null);

console.log(
  JSON.stringify({
    ok: true,
    cases: [
      "trade-always-null",
      "jeonse-newbie",
      "monthly-renew",
      "other-null-no-invent",
    ],
  }),
);

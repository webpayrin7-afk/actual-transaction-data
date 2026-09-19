/**
 * Fixture tests for stored-row reconciliation classes.
 * Does not call the fee API.
 */
import assert from "node:assert/strict";
import { classifyStoredRow, sameWon } from "./mgmt-fee-canonical/reconcile";
import { buildLiveCalls } from "./mgmt-fee-canonical/live-calls";

function main(): void {
  assert.equal(sameWon(10, 10.2), true);
  assert.deepEqual(
    classifyStoredRow({ mapped: true, storedAmount: 100, completeness: "COMPLETE", canonicalAmount: 100 }),
    { classification: "EXACT_MATCH", delta: 0 },
  );
  assert.equal(
    classifyStoredRow({ mapped: true, storedAmount: 0, completeness: "COMPLETE", canonicalAmount: 0 }).classification,
    "EXACT_MATCH",
  );
  assert.equal(
    classifyStoredRow({ mapped: true, storedAmount: 10, completeness: "COMPLETE", canonicalAmount: 15 }).classification,
    "UNDERCOUNT",
  );
  assert.equal(
    classifyStoredRow({ mapped: true, storedAmount: 15, completeness: "COMPLETE", canonicalAmount: 10 }).classification,
    "OVERCOUNT",
  );
  assert.equal(
    classifyStoredRow({ mapped: true, storedAmount: 0, completeness: "MISSING", canonicalAmount: null }).classification,
    "STORED_ZERO_BUT_MISSING",
  );
  assert.equal(
    classifyStoredRow({ mapped: true, storedAmount: 20, completeness: "MISSING", canonicalAmount: null }).classification,
    "STORED_VALUE_BUT_MISSING",
  );
  assert.equal(
    classifyStoredRow({ mapped: true, storedAmount: 20, completeness: "PARTIAL", canonicalAmount: 5 }).classification,
    "PARTIAL_SOURCE",
  );
  assert.equal(
    classifyStoredRow({ mapped: false, storedAmount: 20, completeness: null, canonicalAmount: null }).classification,
    "MAPPING_BLOCKED",
  );
  assert.equal(
    classifyStoredRow({ mapped: true, storedAmount: 20, completeness: "FAILED", canonicalAmount: null }).classification,
    "ERROR",
  );

  const calls = buildLiveCalls().filter((call) => call.in_reference);
  const obsolete = "getHsmpDisinfectCostInfoV3";
  assert.equal(calls.some((call) => call.op === obsolete), false);
  assert.ok(calls.length >= 20);
  assert.ok(calls.every((call) => call.in_reference));

  console.log(JSON.stringify({ ok: true, reference_calls: calls.length }));
}

main();

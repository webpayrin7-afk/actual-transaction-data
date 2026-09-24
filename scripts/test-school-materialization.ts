/**
 * Offline tests for school materialization helpers + 잠실엘스 regression fixture.
 * Run: npx tsx scripts/test-school-materialization.ts
 */
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { haversineMeters } from "../src/lib/complex-detail/geo";
import {
  isElementaryWriteEligible,
  isMiddleWriteEligible,
  SCHOOL_MAT_NEARBY_MAX_M,
  SCHOOL_MAT_NEARBY_STORE_CAP,
} from "../src/lib/school-materialization/types";
import { JAMSIL_ELS_CANONICAL_CENTER } from "../src/lib/nearby-map/jamsil-els-canonical-center";

function testHaversineStable() {
  const d = haversineMeters(37.5133051, 127.0815962, 37.514, 127.082);
  assert.ok(d > 0 && d < 200);
}

function testWriteGates() {
  assert.equal(isElementaryWriteEligible("CONFIRMED_SINGLE"), true);
  assert.equal(isElementaryWriteEligible("BOUNDARY_AMBIGUOUS"), false);
  assert.equal(isElementaryWriteEligible("INVALID_COMPLEX_COORD"), false);
  assert.equal(
    isMiddleWriteEligible({
      resolutionStatus: "CONFIRMED_SINGLE",
      membershipStatus: "MEMBERSHIP_COMPLETE",
    }),
    true,
  );
  assert.equal(
    isMiddleWriteEligible({
      resolutionStatus: "CONFIRMED_SINGLE",
      membershipStatus: "RESOLVED_DISTRICT_ONLY",
    }),
    false,
  );
}

function testNearbyPolicy() {
  assert.equal(SCHOOL_MAT_NEARBY_MAX_M, 1500);
  assert.equal(SCHOOL_MAT_NEARBY_STORE_CAP, 24);
}

function testDryRunSummaryIfPresent() {
  const p = "data/poc/school-materialization/school-materialization-summary.json";
  if (!existsSync(p)) {
    console.log("skip summary fixture (not generated yet)");
    return;
  }
  const summary = JSON.parse(readFileSync(p, "utf8"));
  assert.equal(summary.mode, "dry-run");
  assert.equal(summary.production_rows_written, 0);
  assert.equal(summary.jamsil_els_regression.result, "PASS");
  assert.equal(
    summary.jamsil_els_regression.elementary_zone_id,
    "Z000100307",
  );
  assert.equal(summary.jamsil_els_regression.middle_members, 11);
  assert.equal(summary.jamsil_els_regression.high_members, 26);
  assert.equal(JAMSIL_ELS_CANONICAL_CENTER.complexId, "cx_4c63d9a100973c60");
}

function testWriteGuardScriptMentions() {
  const wf = readFileSync(
    ".github/workflows/school-materialization-dry-run.yml",
    "utf8",
  );
  assert.match(wf, /WRITE GUARD/);
  assert.match(wf, /dry-run/);
}

testHaversineStable();
testWriteGates();
testNearbyPolicy();
testDryRunSummaryIfPresent();
testWriteGuardScriptMentions();
console.log("test-school-materialization: PASS");

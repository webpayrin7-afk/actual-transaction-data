/**
 * Coordinate dry-run / gate tests.
 * Run: npx tsx scripts/test-complex-coordinates.ts
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { haversineMeters } from "../src/lib/complex-detail/geo";
import { isCoordinateWriteGateEligible } from "../src/lib/complex-coordinates/types";
import { JAMSIL_ELS_CANONICAL_CENTER } from "../src/lib/nearby-map/jamsil-els-canonical-center";

assert.equal(isCoordinateWriteGateEligible("SINGLE_SOURCE_HIGH_CONFIDENCE"), true);
assert.equal(isCoordinateWriteGateEligible("PILOT_LOW_CONFIDENCE"), false);
assert.equal(isCoordinateWriteGateEligible("SOURCE_NO_MATCH"), false);
assert.equal(isCoordinateWriteGateEligible("AMBIGUOUS"), false);

const d = haversineMeters(
  JAMSIL_ELS_CANONICAL_CENTER.lat,
  JAMSIL_ELS_CANONICAL_CENTER.lng,
  JAMSIL_ELS_CANONICAL_CENTER.lat,
  JAMSIL_ELS_CANONICAL_CENTER.lng,
);
assert.equal(d, 0);

const summaryPath = "data/poc/complex-coordinates/complex-coordinate-summary.json";
if (existsSync(summaryPath)) {
  const s = JSON.parse(readFileSync(summaryPath, "utf8"));
  assert.equal(s.production_coordinate_rows_written, 0);
  assert.equal(s.external_geocoder_used, false);
  assert.equal(s.jamsil_els.regression, "PASS");
  assert.ok(s.resolution.SOURCE_NO_MATCH >= 8000);
}

const wf = readFileSync(".github/workflows/complex-coordinate-dry-run.yml", "utf8");
assert.match(wf, /WRITE GUARD/);

console.log("test-complex-coordinates: PASS");

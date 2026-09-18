/**
 * Fixture-only scale/readiness checks. Does not run Seoul materialization.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SCHOOL_MAT_SOURCE_VERSION } from "../src/lib/school-materialization/types";
import {
  HIGH_SCHOOL_SEED_COMPLEX_ID,
  SCHOOL_MATERIALIZATION_DB_WRITE_ENABLED,
  SCHOOL_MAT_CHUNK_SIZE,
  SCHOOL_MAT_SAFE_COMPLEX_TARGET,
  SchoolMatGuardError,
  advanceCheckpoint,
  assignedAreaKey,
  chunkComplexIds,
  estimateSafeCoordinatePass,
  highSchoolAssignment,
  nearbyUpsertKey,
  refuseSchoolMaterializationWrite,
  relationsSeparated,
  remainingAfterCheckpoint,
} from "../src/lib/school-materialization/scale";

const ROOT = join(__dirname, "..");

function assertGuard(fn: () => void, code: string) {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof SchoolMatGuardError);
    assert.equal(error.code, code);
    return true;
  });
}

const sample = JSON.parse(
  readFileSync(
    join(ROOT, "data/poc/school-materialization/school-materialization-sample.json"),
    "utf8",
  ),
) as {
  jamsil_areas: Array<{
    complex_id: string;
    school_level: string;
    area_type: string;
    resolution_status: string;
    source_version: string;
    school_code?: string | null;
  }>;
  jamsil_nearby_top: Array<{
    complex_id: string;
    school_level: string;
    school_code: string | null;
  }>;
};

assert.equal(SCHOOL_MATERIALIZATION_DB_WRITE_ENABLED, false);
assert.throws(
  () => refuseSchoolMaterializationWrite(["--mode=write"]),
  (error: unknown) => error instanceof SchoolMatGuardError && error.code === "DB_WRITE_DISABLED",
);

const ids = ["cx_a", "cx_b", "cx_c", "cx_d", "cx_e", "cx_f", "cx_g"];
const chunks = chunkComplexIds(ids, 3);
assert.deepEqual(chunks.map((chunk) => chunk.length), [3, 3, 1]);
assertGuard(() => chunkComplexIds(["cx_b", "cx_a"], 2), "UNSORTED_COMPLEX_IDS");
assertGuard(() => chunkComplexIds(["cx_a", "cx_a"], 2), "DUPLICATE_COMPLEX_ID");

const first = advanceCheckpoint(ids, chunks[0]!, SCHOOL_MAT_SOURCE_VERSION);
assert.equal(first.last_completed_complex_id, "cx_c");
assert.equal(first.completed_count, 3);
assert.deepEqual(remainingAfterCheckpoint(ids, first), ["cx_d", "cx_e", "cx_f", "cx_g"]);
const done = advanceCheckpoint(ids, ["cx_d", "cx_e", "cx_f", "cx_g"], SCHOOL_MAT_SOURCE_VERSION);
assert.equal(done.completed_count, 7);
assert.deepEqual(remainingAfterCheckpoint(ids, done), []);

const jamHigh = highSchoolAssignment(HIGH_SCHOOL_SEED_COMPLEX_ID);
const otherHigh = highSchoolAssignment("cx_not_jamsil");
assert.equal(jamHigh.scope, "SEED_ONLY");
assert.equal(jamHigh.resolution_status, "CONFIRMED_SEED");
assert.equal(jamHigh.seoul_wide, false);
assert.equal(otherHigh.scope, "SEOUL_WIDE_DISABLED");
assert.equal(otherHigh.resolution_status, "UNRESOLVED");
assert.equal("district_name" in otherHigh, false);

const highArea = sample.jamsil_areas.find((row) => row.school_level === "high");
assert.ok(highArea);
assert.equal(highArea.complex_id, HIGH_SCHOOL_SEED_COMPLEX_ID);
assert.equal(highArea.resolution_status, "CONFIRMED_SEED");
assert.equal(highArea.source_version, "pilot-high-seed-web");
assert.equal(
  sample.jamsil_areas.filter((row) => row.resolution_status === "CONFIRMED_SEED").length,
  1,
);

const areaKeys = sample.jamsil_areas.map(assignedAreaKey);
const nearbyKeys = sample.jamsil_nearby_top
  .map(nearbyUpsertKey)
  .filter((key): key is string => key != null);
assert.equal(relationsSeparated([...areaKeys, ...nearbyKeys]), true);
assert.ok(sample.jamsil_nearby_top.some((row) => nearbyUpsertKey(row) == null));
assert.equal(
  nearbyUpsertKey({
    complex_id: HIGH_SCHOOL_SEED_COMPLEX_ID,
    school_level: "elementary",
    school_code: null,
  }),
  null,
);
assert.equal(
  nearbyUpsertKey({
    complex_id: HIGH_SCHOOL_SEED_COMPLEX_ID,
    school_level: "elementary",
    school_code: "7130153",
  }),
  "NEARBY|cx_4c63d9a100973c60|elementary|7130153",
);

const estimate = estimateSafeCoordinatePass();
assert.equal(estimate.complexes_with_coords, SCHOOL_MAT_SAFE_COMPLEX_TARGET);
assert.equal(estimate.distance_calculations, 7963 * 1313);
assert.equal(estimate.bottleneck, "nearest_schools_linear_scan");
assert.equal(SCHOOL_MAT_CHUNK_SIZE, 500);
assert.equal(chunkComplexIds(Array.from({ length: 7963 }, (_, i) => `cx_${String(i).padStart(5, "0")}`)).length, 16);

const py = readFileSync(
  join(ROOT, "scripts/school-materialization/dry_run_seoul.py"),
  "utf8",
);
const guardAt = py.indexOf('if args.mode == "write"');
const loadAt = py.indexOf("Path(args.complexes_json)");
assert.ok(guardAt > 0 && loadAt > guardAt, "write guard precedes complex load");
assert.match(py, /WRITE GUARD: this dry-run binary never writes Production rows/);
assert.match(py, /return 2/);
assert.doesNotMatch(py, /INSERT INTO school_|execute\(`INSERT INTO school_/);

console.log(
  JSON.stringify({
    ok: true,
    chunks: chunks.length,
    high_seed_only: jamHigh.scope,
    nearby_upsert_skipped: sample.jamsil_nearby_top.filter((row) => nearbyUpsertKey(row) == null).length,
    distance_calculations: estimate.distance_calculations,
  }),
);

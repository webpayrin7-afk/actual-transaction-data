/**
 * Fixture-only scale/readiness checks. Does not run Seoul materialization.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { SCHOOL_MAT_SOURCE_VERSION } from "../src/lib/school-materialization/types";
import {
  HIGH_SCHOOL_SEED_COMPLEX_ID,
  NULL_SCHOOL_CODE_REASON,
  SCHOOL_MATERIALIZATION_DB_WRITE_ENABLED,
  SCHOOL_MAT_CHUNK_SIZE,
  SCHOOL_MAT_SAFE_COMPLEX_TARGET,
  SchoolMatGuardError,
  advanceCheckpoint,
  annotateNearbyDbCandidate,
  assignedAreaKey,
  chunkComplexIds,
  estimateSafeCoordinatePass,
  highSchoolAssignment,
  nearbyUpsertKey,
  planRemainingChunks,
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
    school_name?: string;
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
assert.equal(estimate.full_scan_distance_upper_bound, 7963 * 1313);
assert.equal(estimate.bottleneck, "nearest_schools_grid_prefilter");
assert.equal(estimate.nearby_prefilter, "grid");
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

const pyNear = spawnSync("python3", ["scripts/school-materialization/test_nearby_fixture.py"], {
  cwd: ROOT,
  encoding: "utf8",
});
assert.equal(pyNear.status, 0, pyNear.stderr || pyNear.stdout);

const planIds = Array.from({ length: 7 }, (_, i) => `cx_${String(i).padStart(2, "0")}`);
const cursor = spawnSync(
  "npx",
  ["tsx", "scripts/school-materialization/chunk_cursor.ts"],
  {
    cwd: ROOT,
    encoding: "utf8",
    input: JSON.stringify({
      command: "plan",
      complex_ids: planIds,
      checkpoint: null,
      chunk_size: 3,
      source_version: SCHOOL_MAT_SOURCE_VERSION,
    }),
  },
);
assert.equal(cursor.status, 0, cursor.stderr);
const planned = JSON.parse(cursor.stdout) as {
  chunks: Array<{ ids: string[]; checkpoint_after: { last_completed_complex_id: string; completed_count: number } }>;
};
assert.deepEqual(planned.chunks.map((chunk) => chunk.ids.length), [3, 3, 1]);
const resumed = planRemainingChunks(planIds, {
  version: 1,
  mode: "dry-run",
  region: "seoul",
  source_version: SCHOOL_MAT_SOURCE_VERSION,
  last_completed_complex_id: planned.chunks[0]!.checkpoint_after.last_completed_complex_id,
  completed_count: planned.chunks[0]!.checkpoint_after.completed_count,
  total: planIds.length,
}, SCHOOL_MAT_SOURCE_VERSION, 3);
assert.deepEqual(resumed.map((chunk) => chunk.ids.length), [3, 1]);
assert.equal(resumed[0]!.ids[0], planIds[3]);

const annotated = sample.jamsil_nearby_top.map((row) =>
  annotateNearbyDbCandidate({ ...row, school_code: row.school_code }),
);
assert.ok(annotated.some((row) => row.db_candidate === false && row.unresolved_reason === NULL_SCHOOL_CODE_REASON && row.school_name));
assert.ok(annotated.some((row) => row.db_candidate && row.school_code === "7130153"));
assert.equal(
  annotateNearbyDbCandidate({ school_code: "  ", school_name: "kept" }).school_name,
  "kept",
);

const dry = readFileSync(join(ROOT, "scripts/school-materialization/dry_run_seoul.py"), "utf8");
assert.match(dry, /plan_remaining\(/);
assert.match(dry, /if cid == JAMSIL_ID/);
assert.match(dry, /--chunk-size", type=int, default=500/);

console.log(
  JSON.stringify({
    ok: true,
    chunks: chunks.length,
    high_seed_only: jamHigh.scope,
    nearby_upsert_skipped: sample.jamsil_nearby_top.filter((row) => nearbyUpsertKey(row) == null).length,
    distance_calculations: estimate.full_scan_distance_upper_bound,
  }),
);

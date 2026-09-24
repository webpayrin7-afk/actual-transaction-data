/**
 * Fixture test for the offline SAFE payload builder.
 * Reuses repair sample/unresolved artifacts. Does not scan cadastral rows
 * and does not open a database.
 */
import { readFileSync } from "fs";
import { spawnSync } from "child_process";
import { join } from "path";
import {
  COORDINATE_PAYLOAD_DB_WRITE_ENABLED,
  JAMSIL_ELS_PARCEL_LOCK,
  PRODUCTION_SAFE_COORDINATE_COUNT,
  PRODUCTION_UNRESOLVED_EXCLUDED_COUNT,
  SafePayloadAbort,
  buildSafeCoordinatePayload,
  inputFromRepairArtifact,
  type SafePayloadInput,
} from "../src/lib/complex-coordinates/safe-payload";

const ROOT = join(__dirname, "..");

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

function assertAbort(fn: () => void, code: string) {
  try {
    fn();
  } catch (error) {
    if (error instanceof SafePayloadAbort) {
      assert(error.code === code, `expected ${code} got ${error.code}`);
      return;
    }
    throw error;
  }
  throw new Error(`expected abort ${code}`);
}

const sample = JSON.parse(
  readFileSync(join(ROOT, "data/poc/complex-coordinates/parcel-coordinate-repair-sample.json"), "utf8"),
) as { samples: Parameters<typeof inputFromRepairArtifact>[0][] };
const unresolved = JSON.parse(
  readFileSync(join(ROOT, "data/poc/complex-coordinates/parcel-coordinate-repair-unresolved.json"), "utf8"),
) as { count: number; rows: Parameters<typeof inputFromRepairArtifact>[0][] };

assert(unresolved.count === PRODUCTION_UNRESOLVED_EXCLUDED_COUNT, "unresolved artifact count");
const notFound = unresolved.rows.find((row) => row.classification === "NOT_FOUND");
assert(notFound, "NOT_FOUND fixture row");

const fixture = [...sample.samples, notFound!].map(inputFromRepairArtifact);
const safeCount = fixture.filter((row) =>
  row.classification === "EXACT_ORIGINAL" ||
  row.classification === "REPAIRED_FROM_SAME_ROW_LOT" ||
  row.classification === "ORIGINAL_CONFLICT_REPAIRED",
).length;

const built = buildSafeCoordinatePayload(fixture, {
  expectedSafeCount: safeCount,
  requireJamsilLock: false,
});
assert(built.report.decision === "PASS", "fixture pass");
assert(built.report.db_write_enabled === false, "db write flag");
assert(COORDINATE_PAYLOAD_DB_WRITE_ENABLED === false, "module db write disabled");
assert(built.report.safe_rows === safeCount, "safe count");
assert(built.rows.length === safeCount, "payload length");
assert(
  built.rows.every((row) => !["AMBIGUOUS", "NOT_FOUND", "NO_SOURCE_PARCEL"].includes(row.classification)),
  "unresolved excluded from payload",
);
assert(
  built.report.excluded_complex_ids.includes(notFound!.complex_id),
  "NOT_FOUND excluded",
);
assert(built.report.excluded_unresolved === fixture.length - safeCount, "excluded count");
const again = buildSafeCoordinatePayload([...fixture].reverse(), {
  expectedSafeCount: safeCount,
  requireJamsilLock: false,
});
assert(again.report.payload_sha256 === built.report.payload_sha256, "deterministic hash");

const badPnu = fixture.map((row) => ({ ...row }));
const safeIndex = badPnu.findIndex((row) => row.classification === "REPAIRED_FROM_SAME_ROW_LOT");
assert(safeIndex >= 0, "safe fixture row");
badPnu[safeIndex] = { ...badPnu[safeIndex]!, pnu: "123" };
assertAbort(
  () => buildSafeCoordinatePayload(badPnu, { expectedSafeCount: safeCount, requireJamsilLock: false }),
  "MALFORMED_PNU",
);

const badCoord = fixture.map((row) => ({ ...row }));
badCoord[safeIndex] = { ...badCoord[safeIndex]!, latitude: 10, longitude: 10 };
assertAbort(
  () => buildSafeCoordinatePayload(badCoord, { expectedSafeCount: safeCount, requireJamsilLock: false }),
  "MALFORMED_COORDINATE",
);

const dup: SafePayloadInput[] = [...fixture, { ...fixture[safeIndex]! }];
assertAbort(
  () => buildSafeCoordinatePayload(dup, { expectedSafeCount: safeCount, requireJamsilLock: false }),
  "DUPLICATE_COMPLEX_ID",
);

assertAbort(
  () =>
    buildSafeCoordinatePayload(fixture, {
      expectedSafeCount: PRODUCTION_SAFE_COORDINATE_COUNT,
      requireJamsilLock: true,
    }),
  "COUNT_MISMATCH",
);

const jamBad: SafePayloadInput = {
  complex_id: JAMSIL_ELS_PARCEL_LOCK.complexId,
  classification: JAMSIL_ELS_PARCEL_LOCK.classification,
  pnu: JAMSIL_ELS_PARCEL_LOCK.pnu,
  latitude: 37.5,
  longitude: JAMSIL_ELS_PARCEL_LOCK.longitude,
};
assertAbort(
  () =>
    buildSafeCoordinatePayload([...fixture, jamBad], {
      expectedSafeCount: safeCount + 1,
      requireJamsilLock: true,
    }),
  "JAMSIL_LOCK",
);

const jamOk: SafePayloadInput = {
  complex_id: JAMSIL_ELS_PARCEL_LOCK.complexId,
  classification: JAMSIL_ELS_PARCEL_LOCK.classification,
  pnu: JAMSIL_ELS_PARCEL_LOCK.pnu,
  latitude: JAMSIL_ELS_PARCEL_LOCK.latitude,
  longitude: JAMSIL_ELS_PARCEL_LOCK.longitude,
};
const locked = buildSafeCoordinatePayload([...fixture, jamOk], {
  expectedSafeCount: safeCount + 1,
  requireJamsilLock: true,
});
assert(locked.report.jamsil_lock === "PASS", "jamsil lock pass");

const twinId = "cx_payload_fixture_dup_pnu";
const twin: SafePayloadInput = { ...fixture[safeIndex]!, complex_id: twinId };
const dupPnu = buildSafeCoordinatePayload([...fixture, twin], {
  expectedSafeCount: safeCount + 1,
  requireJamsilLock: false,
});
assert(dupPnu.report.duplicate_pnu_groups >= 1, "duplicate pnu reported");
assert(dupPnu.report.decision === "PASS", "duplicate pnu does not abort");

const cli = spawnSync(
  "npx",
  ["tsx", "scripts/complex-coordinates/build_safe_coordinate_payload.ts", "--apply"],
  { cwd: ROOT, encoding: "utf8" },
);
assert(cli.status === 2, `cli --apply status ${cli.status} ${cli.stderr}`);
assert(cli.stderr.includes("DB_WRITE_DISABLED"), "cli refuses db write");
assert(!cli.stdout.includes("latitude"), "cli --apply emits no payload");

const cliSource = readFileSync(
  join(ROOT, "scripts/complex-coordinates/build_safe_coordinate_payload.ts"),
  "utf8",
);
assert(!cliSource.includes("@libsql/client"), "no db client import");
assert(!cliSource.includes("TURSO_"), "no production credentials");

console.log(
  JSON.stringify({
    ok: true,
    fixture_safe: safeCount,
    fixture_excluded: built.report.excluded_unresolved,
    sha256: built.report.payload_sha256,
  }),
);

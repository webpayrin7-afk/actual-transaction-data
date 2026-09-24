/**
 * Offline SAFE coordinate payload dry-run.
 * No database client. --apply / --write / --production are refused.
 *
 *   npx tsx scripts/complex-coordinates/build_safe_coordinate_payload.ts <candidates.json>
 *
 * Expected SAFE count is fixed at 7963. This script does not write
 * apt_complex_master and does not assign source_links / enrichment domains.
 */
import { readFileSync } from "fs";
import {
  PRODUCTION_SAFE_COORDINATE_COUNT,
  SafePayloadAbort,
  buildSafeCoordinatePayload,
  inputFromRepairArtifact,
  refuseCoordinateDbWrite,
  type RepairArtifactRow,
} from "../../src/lib/complex-coordinates/safe-payload";

function loadRows(path: string): RepairArtifactRow[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (Array.isArray(parsed)) return parsed as RepairArtifactRow[];
  if (parsed && typeof parsed === "object") {
    const obj = parsed as { samples?: unknown; rows?: unknown; candidates?: unknown };
    const list = obj.candidates ?? obj.samples ?? obj.rows;
    if (Array.isArray(list)) return list as RepairArtifactRow[];
  }
  throw new SafePayloadAbort("MALFORMED_INPUT", "input JSON has no candidate rows");
}

function main(): void {
  const args = process.argv.slice(2);
  refuseCoordinateDbWrite(args);
  const inputPath = args.find((arg) => !arg.startsWith("--"));
  if (!inputPath) {
    throw new SafePayloadAbort(
      "MISSING_INPUT",
      "usage: build_safe_coordinate_payload.ts <candidates.json> (DB write disabled)",
    );
  }

  const built = buildSafeCoordinatePayload(
    loadRows(inputPath).map(inputFromRepairArtifact),
    {
      expectedSafeCount: PRODUCTION_SAFE_COORDINATE_COUNT,
      requireJamsilLock: true,
    },
  );
  console.log(JSON.stringify(built.report));
}

try {
  main();
} catch (error) {
  if (error instanceof SafePayloadAbort) {
    console.error(
      JSON.stringify({
        mode: "dry-run",
        db_write_enabled: false,
        decision: "ABORT",
        abort_code: error.code,
        message: error.message,
      }),
    );
    process.exit(error.code === "DB_WRITE_DISABLED" ? 2 : 1);
  }
  console.error(error);
  process.exit(1);
}

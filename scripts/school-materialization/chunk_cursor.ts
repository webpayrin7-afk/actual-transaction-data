/**
 * Stdin JSON bridge so the Python dry-run uses scale.ts for chunk/resume.
 * No database. No school API.
 *
 *   { "command": "plan", "complex_ids": [...], "checkpoint": null, "chunk_size": 500, "source_version": "..." }
 *   { "command": "annotate-nearby", "rows": [...] }
 */
import { readFileSync } from "fs";
import {
  NULL_SCHOOL_CODE_REASON,
  SCHOOL_MAT_CHUNK_SIZE,
  SchoolMatGuardError,
  annotateNearbyDbCandidate,
  planRemainingChunks,
  type SchoolMatCheckpoint,
} from "../../src/lib/school-materialization/scale";

type PlanInput = {
  command: "plan";
  complex_ids: string[];
  checkpoint?: SchoolMatCheckpoint | null;
  chunk_size?: number;
  source_version: string;
};

type AnnotateInput = {
  command: "annotate-nearby";
  rows: Array<{ school_code: string | null }>;
};

function readStdin(): string {
  return readFileSync(0, "utf8");
}

function main(): void {
  const raw = JSON.parse(readStdin()) as PlanInput | AnnotateInput;
  if (raw.command === "annotate-nearby") {
    console.log(
      JSON.stringify({
        reason: NULL_SCHOOL_CODE_REASON,
        rows: raw.rows.map((row) => annotateNearbyDbCandidate(row)),
      }),
    );
    return;
  }
  if (raw.command !== "plan") {
    throw new SchoolMatGuardError("BAD_COMMAND", "expected plan or annotate-nearby");
  }
  const chunks = planRemainingChunks(
    raw.complex_ids,
    raw.checkpoint ?? null,
    raw.source_version,
    raw.chunk_size ?? SCHOOL_MAT_CHUNK_SIZE,
  );
  console.log(JSON.stringify({ chunk_size: raw.chunk_size ?? SCHOOL_MAT_CHUNK_SIZE, chunks }));
}

try {
  main();
} catch (error) {
  if (error instanceof SchoolMatGuardError) {
    console.error(JSON.stringify({ abort_code: error.code, message: error.message }));
    process.exit(1);
  }
  console.error(error);
  process.exit(1);
}

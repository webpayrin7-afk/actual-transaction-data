/**
 * Offline scale contract for Seoul school materialization.
 * Does not query Production, call NEIS/SchoolInfo, or apply school_* tables.
 *
 * High-school assignment stays seed-only for 잠실엘스. This module does not
 * add Seoul-wide high polygons or membership.
 */

export const SCHOOL_MATERIALIZATION_DB_WRITE_ENABLED = false;

/** Ordered export chunk. Large enough to amortize setup, small enough to resume. */
export const SCHOOL_MAT_CHUNK_SIZE = 500;

/** SAFE coordinate rows that become valid inputs after coordinate write. */
export const SCHOOL_MAT_SAFE_COMPLEX_TARGET = 7963;

/** Seoul school CSV row count from the last dry-run inventory. */
export const SCHOOL_MAT_SEOUL_SCHOOL_ROWS = 1313;

export const HIGH_SCHOOL_SEED_COMPLEX_ID = "cx_4c63d9a100973c60";

export class SchoolMatGuardError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SchoolMatGuardError";
    this.code = code;
  }
}

export type SchoolMatCheckpoint = {
  version: 1;
  mode: "dry-run";
  region: "seoul";
  source_version: string;
  last_completed_complex_id: string | null;
  completed_count: number;
  total: number;
};

export type HighAssignment =
  | {
      scope: "SEED_ONLY";
      complex_id: string;
      resolution_status: "CONFIRMED_SEED";
      source_version: "pilot-high-seed-web";
      seoul_wide: false;
    }
  | {
      scope: "SEOUL_WIDE_DISABLED";
      complex_id: string;
      resolution_status: "UNRESOLVED";
      source_version: "high-shp-absent";
      seoul_wide: false;
    };

export function refuseSchoolMaterializationWrite(argv: readonly string[]): void {
  if (SCHOOL_MATERIALIZATION_DB_WRITE_ENABLED) {
    throw new SchoolMatGuardError(
      "DB_WRITE_DISABLED",
      "school materialization DB write is hard-disabled",
    );
  }
  const blocked = argv.some(
    (arg) =>
      arg === "--write" ||
      arg === "--apply" ||
      arg === "--mode=write" ||
      arg === "--production",
  );
  if (blocked) {
    throw new SchoolMatGuardError(
      "DB_WRITE_DISABLED",
      "school materialization refuses write/apply",
    );
  }
}

export function assertOrderedUniqueComplexIds(ids: readonly string[]): void {
  let prev = "";
  const seen = new Set<string>();
  for (const id of ids) {
    if (!id) throw new SchoolMatGuardError("MALFORMED_COMPLEX_ID", "empty complex_id");
    if (seen.has(id)) {
      throw new SchoolMatGuardError("DUPLICATE_COMPLEX_ID", `duplicate complex_id ${id}`);
    }
    if (prev && id < prev) {
      throw new SchoolMatGuardError("UNSORTED_COMPLEX_IDS", "complex_id list is not sorted");
    }
    seen.add(id);
    prev = id;
  }
}

export function chunkComplexIds(
  orderedIds: readonly string[],
  chunkSize = SCHOOL_MAT_CHUNK_SIZE,
): string[][] {
  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new SchoolMatGuardError("BAD_CHUNK_SIZE", "chunk size must be a positive integer");
  }
  assertOrderedUniqueComplexIds(orderedIds);
  const chunks: string[][] = [];
  for (let i = 0; i < orderedIds.length; i += chunkSize) {
    chunks.push(orderedIds.slice(i, i + chunkSize));
  }
  return chunks;
}

export function remainingAfterCheckpoint(
  orderedIds: readonly string[],
  checkpoint: SchoolMatCheckpoint | null,
): string[] {
  assertOrderedUniqueComplexIds(orderedIds);
  if (!checkpoint) return [...orderedIds];
  if (checkpoint.mode !== "dry-run" || checkpoint.region !== "seoul" || checkpoint.version !== 1) {
    throw new SchoolMatGuardError("BAD_CHECKPOINT", "checkpoint is not a Seoul dry-run cursor");
  }
  if (checkpoint.total !== orderedIds.length) {
    throw new SchoolMatGuardError(
      "CHECKPOINT_TOTAL_MISMATCH",
      `checkpoint total ${checkpoint.total} != ${orderedIds.length}`,
    );
  }
  if (checkpoint.last_completed_complex_id == null) return [...orderedIds];
  const idx = orderedIds.indexOf(checkpoint.last_completed_complex_id);
  if (idx < 0) {
    throw new SchoolMatGuardError(
      "CHECKPOINT_CURSOR_MISSING",
      "last_completed_complex_id is not in the ordered export",
    );
  }
  return orderedIds.slice(idx + 1);
}

export function advanceCheckpoint(
  orderedIds: readonly string[],
  completedChunk: readonly string[],
  sourceVersion: string,
): SchoolMatCheckpoint {
  assertOrderedUniqueComplexIds(orderedIds);
  if (completedChunk.length === 0) {
    throw new SchoolMatGuardError("EMPTY_CHUNK", "cannot advance an empty chunk");
  }
  const last = completedChunk[completedChunk.length - 1]!;
  const end = orderedIds.indexOf(last);
  if (end < 0 || orderedIds[end - completedChunk.length + 1] !== completedChunk[0]) {
    throw new SchoolMatGuardError("CHUNK_NOT_CONTIGUOUS", "chunk is not a contiguous export slice");
  }
  return {
    version: 1,
    mode: "dry-run",
    region: "seoul",
    source_version: sourceVersion,
    last_completed_complex_id: last,
    completed_count: end + 1,
    total: orderedIds.length,
  };
}

/** High assignment is seed-only. Other complexes stay unresolved and get no district name. */
export function highSchoolAssignment(complexId: string): HighAssignment {
  if (complexId === HIGH_SCHOOL_SEED_COMPLEX_ID) {
    return {
      scope: "SEED_ONLY",
      complex_id: complexId,
      resolution_status: "CONFIRMED_SEED",
      source_version: "pilot-high-seed-web",
      seoul_wide: false,
    };
  }
  return {
    scope: "SEOUL_WIDE_DISABLED",
    complex_id: complexId,
    resolution_status: "UNRESOLVED",
    source_version: "high-shp-absent",
    seoul_wide: false,
  };
}

export function assignedAreaKey(row: {
  complex_id: string;
  school_level: string;
  area_type: string;
}): string {
  return `ASSIGNED|${row.complex_id}|${row.school_level}|${row.area_type}`;
}

/**
 * Nearby PK is (complex_id, school_level, school_code) and school_code is NOT NULL.
 * Rows without a NEIS code are not upsert-eligible; they must not collapse onto one key.
 */
export function nearbyUpsertKey(row: {
  complex_id: string;
  school_level: string;
  school_code: string | null;
}): string | null {
  const code = row.school_code?.trim() ?? "";
  if (!code) return null;
  return `NEARBY|${row.complex_id}|${row.school_level}|${code}`;
}

export function relationsSeparated(keys: readonly string[]): boolean {
  const assigned = keys.filter((key) => key.startsWith("ASSIGNED|"));
  const nearby = keys.filter((key) => key.startsWith("NEARBY|"));
  if (assigned.length + nearby.length !== keys.length) return false;
  const all = new Set(keys);
  return all.size === keys.length;
}

export const NULL_SCHOOL_CODE_REASON = "SCHOOL_CODE_UNRESOLVED" as const;

/** Keep the nearby row. Do not invent a NEIS code. Exclude only the DB candidate. */
export function annotateNearbyDbCandidate<T extends { school_code: string | null }>(
  row: T,
): T & {
  school_code: string | null;
  db_candidate: boolean;
  unresolved_reason: typeof NULL_SCHOOL_CODE_REASON | null;
} {
  const code = typeof row.school_code === "string" ? row.school_code.trim() : "";
  if (!code) {
    return {
      ...row,
      school_code: null,
      db_candidate: false,
      unresolved_reason: NULL_SCHOOL_CODE_REASON,
    };
  }
  return {
    ...row,
    school_code: code,
    db_candidate: true,
    unresolved_reason: null,
  };
}

export function planRemainingChunks(
  orderedIds: readonly string[],
  checkpoint: SchoolMatCheckpoint | null,
  sourceVersion: string,
  chunkSize = SCHOOL_MAT_CHUNK_SIZE,
): Array<{ ids: string[]; checkpoint_after: SchoolMatCheckpoint }> {
  const remaining = remainingAfterCheckpoint(orderedIds, checkpoint);
  const parts = chunkComplexIds(remaining, chunkSize);
  return parts.map((ids) => ({
    ids,
    checkpoint_after: advanceCheckpoint(orderedIds, ids, sourceVersion),
  }));
}

export function estimateSafeCoordinatePass(params?: {
  complexesWithCoords?: number;
  seoulSchoolRows?: number;
}): {
  complexes_with_coords: number;
  full_scan_distance_upper_bound: number;
  max_nearby_rows_at_cap: number;
  pip_indexed: true;
  nearby_prefilter: "grid";
  bottleneck: "nearest_schools_grid_prefilter";
} {
  const complexes = params?.complexesWithCoords ?? SCHOOL_MAT_SAFE_COMPLEX_TARGET;
  const schools = params?.seoulSchoolRows ?? SCHOOL_MAT_SEOUL_SCHOOL_ROWS;
  return {
    complexes_with_coords: complexes,
    full_scan_distance_upper_bound: complexes * schools,
    max_nearby_rows_at_cap: complexes * 3 * 24,
    pip_indexed: true,
    nearby_prefilter: "grid",
    bottleneck: "nearest_schools_grid_prefilter",
  };
}

/**
 * Offline SAFE coordinate payload builder.
 * Dry-run only. Does not open a database and does not invent
 * apt_complex_source_links / apt_complex_enrichment_state conventions.
 */

import { createHash } from "crypto";
import { inSeoulBbox, isValidWgs84, parseCadastralPnu } from "./parcel-key";
import {
  isSafeRepairClass,
  type SameRowRepairClass,
} from "./same-row-pnu-repair";

export const COORDINATE_PAYLOAD_DB_WRITE_ENABLED = false;

export const PRODUCTION_SAFE_COORDINATE_COUNT = 7963;
export const PRODUCTION_UNRESOLVED_EXCLUDED_COUNT = 474;

/** Parcel representative point lock. Not the NAVER map-anchor center. */
export const JAMSIL_ELS_PARCEL_LOCK = {
  complexId: "cx_4c63d9a100973c60",
  classification: "EXACT_ORIGINAL" as const,
  pnu: "1171010100100190000",
  latitude: 37.51413457,
  longitude: 127.07932524,
};

const LOCK_EPS = 1e-7;

const UNRESOLVED = new Set<SameRowRepairClass>([
  "AMBIGUOUS",
  "NOT_FOUND",
  "NO_SOURCE_PARCEL",
]);

export class SafePayloadAbort extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SafePayloadAbort";
    this.code = code;
  }
}

export type SafePayloadInput = {
  complex_id: string;
  classification: string;
  pnu: string | null;
  latitude: number | null;
  longitude: number | null;
};

export type SafePayloadRow = {
  complex_id: string;
  pnu: string;
  latitude: number;
  longitude: number;
  classification: "EXACT_ORIGINAL" | "REPAIRED_FROM_SAME_ROW_LOT" | "ORIGINAL_CONFLICT_REPAIRED";
};

export type SafePayloadReport = {
  mode: "dry-run";
  db_write_enabled: false;
  decision: "PASS";
  input_rows: number;
  excluded_unresolved: number;
  excluded_classifications: Record<string, number>;
  excluded_complex_ids: string[];
  safe_rows: number;
  expected_safe_count: number;
  duplicate_pnu_groups: number;
  duplicate_pnu_affected_rows: number;
  max_complexes_per_pnu: number;
  payload_sha256: string;
  jamsil_lock: "PASS" | "NOT_REQUIRED";
};

export type RepairArtifactRow = {
  complex_id: string;
  classification: string;
  derived_pnu?: string | null;
  stored_pnu?: string | null;
  reb_stored_pnu?: string | null;
  parcel_coordinate?: { lat?: number | null; lng?: number | null } | null;
  latitude?: number | null;
  longitude?: number | null;
};

function isKnownClass(value: string): value is SameRowRepairClass {
  return isSafeRepairClass(value as SameRowRepairClass) || UNRESOLVED.has(value as SameRowRepairClass);
}

function round8(n: number): number {
  return Number(n.toFixed(8));
}

export function refuseCoordinateDbWrite(argv: readonly string[]): void {
  if (COORDINATE_PAYLOAD_DB_WRITE_ENABLED) {
    throw new SafePayloadAbort(
      "DB_WRITE_DISABLED",
      "coordinate payload DB write is hard-disabled",
    );
  }
  if (argv.some((arg) => arg === "--apply" || arg === "--write" || arg === "--production")) {
    throw new SafePayloadAbort(
      "DB_WRITE_DISABLED",
      "coordinate payload builder refuses --apply/--write/--production",
    );
  }
}

export function inputFromRepairArtifact(row: RepairArtifactRow): SafePayloadInput {
  const pnu = row.derived_pnu ?? row.stored_pnu ?? row.reb_stored_pnu ?? null;
  const latitude = row.parcel_coordinate?.lat ?? row.latitude ?? null;
  const longitude = row.parcel_coordinate?.lng ?? row.longitude ?? null;
  return {
    complex_id: row.complex_id,
    classification: row.classification,
    pnu,
    latitude: latitude == null ? null : Number(latitude),
    longitude: longitude == null ? null : Number(longitude),
  };
}

function payloadHash(rows: SafePayloadRow[]): string {
  const canonical = rows.map((row) => ({
    complex_id: row.complex_id,
    pnu: row.pnu,
    latitude: row.latitude.toFixed(8),
    longitude: row.longitude.toFixed(8),
    classification: row.classification,
  }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function buildSafeCoordinatePayload(
  inputs: readonly SafePayloadInput[],
  opts: { expectedSafeCount: number; requireJamsilLock: boolean },
): { rows: SafePayloadRow[]; report: SafePayloadReport } {
  refuseCoordinateDbWrite([]);

  const seen = new Map<string, number>();
  for (const row of inputs) {
    if (!row.complex_id) {
      throw new SafePayloadAbort("MALFORMED_COMPLEX_ID", "empty complex_id");
    }
    seen.set(row.complex_id, (seen.get(row.complex_id) ?? 0) + 1);
  }
  const duplicateIds = [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id);
  if (duplicateIds.length > 0) {
    throw new SafePayloadAbort(
      "DUPLICATE_COMPLEX_ID",
      `duplicate complex_id: ${duplicateIds.slice(0, 5).join(",")}`,
    );
  }

  const excluded = new Map<string, number>();
  const excludedIds: string[] = [];
  const safe: SafePayloadRow[] = [];

  for (const row of inputs) {
    if (!isKnownClass(row.classification)) {
      throw new SafePayloadAbort(
        "UNKNOWN_CLASSIFICATION",
        `unknown classification ${row.classification} for ${row.complex_id}`,
      );
    }
    if (!isSafeRepairClass(row.classification)) {
      excluded.set(row.classification, (excluded.get(row.classification) ?? 0) + 1);
      excludedIds.push(row.complex_id);
      continue;
    }
    const parsed = parseCadastralPnu(row.pnu);
    if (!parsed) {
      throw new SafePayloadAbort(
        "MALFORMED_PNU",
        `malformed cadastral PNU for ${row.complex_id}`,
      );
    }
    if (
      row.latitude == null ||
      row.longitude == null ||
      !isValidWgs84(row.latitude, row.longitude) ||
      !inSeoulBbox(row.latitude, row.longitude)
    ) {
      throw new SafePayloadAbort(
        "MALFORMED_COORDINATE",
        `coordinate outside Seoul parcel gate for ${row.complex_id}`,
      );
    }
    safe.push({
      complex_id: row.complex_id,
      pnu: parsed.pnu,
      latitude: round8(row.latitude),
      longitude: round8(row.longitude),
      classification: row.classification,
    });
  }

  safe.sort((a, b) => (a.complex_id < b.complex_id ? -1 : a.complex_id > b.complex_id ? 1 : 0));
  excludedIds.sort();

  if (safe.length !== opts.expectedSafeCount) {
    throw new SafePayloadAbort(
      "COUNT_MISMATCH",
      `safe rows ${safe.length} != expected ${opts.expectedSafeCount}`,
    );
  }

  const jam = safe.find((row) => row.complex_id === JAMSIL_ELS_PARCEL_LOCK.complexId);
  let jamsilLock: SafePayloadReport["jamsil_lock"] = "NOT_REQUIRED";
  if (jam || opts.requireJamsilLock) {
    const ok =
      jam != null &&
      jam.classification === JAMSIL_ELS_PARCEL_LOCK.classification &&
      jam.pnu === JAMSIL_ELS_PARCEL_LOCK.pnu &&
      Math.abs(jam.latitude - JAMSIL_ELS_PARCEL_LOCK.latitude) < LOCK_EPS &&
      Math.abs(jam.longitude - JAMSIL_ELS_PARCEL_LOCK.longitude) < LOCK_EPS;
    if (!ok) {
      throw new SafePayloadAbort(
        "JAMSIL_LOCK",
        "잠실엘스 parcel lock mismatch",
      );
    }
    jamsilLock = "PASS";
  }

  const byPnu = new Map<string, number>();
  for (const row of safe) byPnu.set(row.pnu, (byPnu.get(row.pnu) ?? 0) + 1);
  const dupGroups = [...byPnu.values()].filter((n) => n > 1);
  const excludedClassifications = Object.fromEntries(
    [...excluded.entries()].sort((a, b) => a[0].localeCompare(b[0])),
  );

  const report: SafePayloadReport = {
    mode: "dry-run",
    db_write_enabled: false,
    decision: "PASS",
    input_rows: inputs.length,
    excluded_unresolved: excludedIds.length,
    excluded_classifications: excludedClassifications,
    excluded_complex_ids: excludedIds,
    safe_rows: safe.length,
    expected_safe_count: opts.expectedSafeCount,
    duplicate_pnu_groups: dupGroups.length,
    duplicate_pnu_affected_rows: dupGroups.reduce((n, c) => n + c, 0),
    max_complexes_per_pnu: dupGroups.reduce((m, c) => Math.max(m, c), 1),
    payload_sha256: payloadHash(safe),
    jamsil_lock: jamsilLock,
  };

  return { rows: safe, report };
}

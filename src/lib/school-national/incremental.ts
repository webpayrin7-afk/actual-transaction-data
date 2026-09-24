/**
 * Incremental school refresh policy.
 * Historical snapshots are never rewritten in place.
 * A new disclosure year is a new snapshot. Same source/version is a skip.
 */

export const SCHOOL_CATEGORIES = [
  "BASIC",
  "STUDENT",
  "TEACHER",
  "MEAL",
  "AFTERSCHOOL",
  "SCHOLARSHIP",
  "GRADUATE_PATH",
] as const;

export type SchoolCategory = (typeof SCHOOL_CATEGORIES)[number];

/** Years actually loaded in baseline v1. Categories do not advance together. */
export const BASELINE_LOADED_YEAR: Record<SchoolCategory, string> = {
  BASIC: "2026",
  STUDENT: "2026",
  TEACHER: "2026",
  MEAL: "2026",
  AFTERSCHOOL: "2026",
  SCHOLARSHIP: "2026",
  GRADUATE_PATH: "2025",
};

export const VALID_SNAPSHOT_STATUSES = [
  "COMPLETE",
  "PARTIAL",
  "NO_DATA",
  "NOT_APPLICABLE",
] as const;

export type IdentityClassification =
  | "SAME_SCHOOL_CODE_VERSION"
  | "HISTORICAL_REGION_CODE_ALIAS"
  | "TRUE_IDENTITY_CONFLICT"
  | "DUPLICATE_SOURCE_RECORD"
  | "UNKNOWN";

/** Districts whose 2026 BASIC feed collided with an already stored school_code. */
export const REGION_ALIAS_SGG = [
  "12110", "12130", "12150", "12170", "12190",
  "12210", "12240", "12270", "12300", "12330",
  "12710", "12720", "12730", "12740", "12750",
  "12760", "12770", "12780", "12790", "12800",
  "12810", "12820", "12830", "12840", "12850",
  "12860", "12870",
  "28125", "28155", "28275", "28290",
] as const;

export type SnapshotCandidate = {
  disclosureYear: string;
  status: string;
  source: string;
};

const CLOSED_CHECKPOINTS = new Set(["complete", "empty", "available"]);

export function shouldRefetchScope(
  checkpoint: string | null,
  sourceVersionUnchanged: boolean,
): boolean {
  if (!sourceVersionUnchanged) return true;
  if (checkpoint && CLOSED_CHECKPOINTS.has(checkpoint)) return false;
  return true;
}

/**
 * Latest valid snapshot for one school and category.
 * FAILED never hides an older valid year. History is not deleted.
 */
export function resolveCurrentSnapshot<T extends SnapshotCandidate>(rows: readonly T[]): T | null {
  const valid = rows.filter((row) =>
    (VALID_SNAPSHOT_STATUSES as readonly string[]).includes(row.status),
  );
  const pool = valid.length > 0 ? valid : rows.filter((row) => row.status === "FAILED");
  if (pool.length === 0) return null;
  return [...pool].sort((a, b) => {
    if (a.disclosureYear !== b.disclosureYear) return a.disclosureYear < b.disclosureYear ? 1 : -1;
    return a.source < b.source ? -1 : a.source > b.source ? 1 : 0;
  })[0] ?? null;
}

export function classifyHoldScope(sgg: string, holds: number): IdentityClassification {
  if (holds <= 0) return "SAME_SCHOOL_CODE_VERSION";
  if (sgg.startsWith("12") || (["28125", "28155", "28275", "28290"] as readonly string[]).includes(sgg)) {
    return "HISTORICAL_REGION_CODE_ALIAS";
  }
  return "UNKNOWN";
}

export type ExclusionRecord = {
  schoolCode: string;
  schoolName: string;
  reason: "EXCLUDED_IDENTITY_INCOMPLETE";
  detail: string;
};

/**
 * Graduate-path-only schools. Same display names under other codes are different schools.
 * Do not create a master row from the graduate feed.
 */
export const EXCLUDED_IDENTITY_INCOMPLETE: readonly ExclusionRecord[] = [
  {
    schoolCode: "S090005579",
    schoolName: "봉담고등학교",
    reason: "EXCLUDED_IDENTITY_INCOMPLETE",
    detail: "2025 graduate feed only. ADRCD is null. Office is 경기도교육청 / 경기도화성오산교육지원청. Not 봉담초 or 봉담중.",
  },
  {
    schoolCode: "S090005676",
    schoolName: "광덕고등학교",
    reason: "EXCLUDED_IDENTITY_INCOMPLETE",
    detail: "2025 graduate feed only. ADRCD is null. Office is 경기도안산교육지원청. Not S050000089 광주 서구 광덕고등학교.",
  },
  {
    schoolCode: "S090006652",
    schoolName: "화성반월중학교",
    reason: "EXCLUDED_IDENTITY_INCOMPLETE",
    detail: "2025 graduate feed only. ADRCD is null. Not 안산 반월중학교.",
  },
  {
    schoolCode: "S090007522",
    schoolName: "치동중학교",
    reason: "EXCLUDED_IDENTITY_INCOMPLETE",
    detail: "2025 graduate feed only. ADRCD is null. Not 치동초 or 치동고.",
  },
];

export function discoveryScopeKey(category: string, year: string, sgg: string, kind: string): string {
  return `discover|${year}|${sgg}|${kind}|${category}`;
}

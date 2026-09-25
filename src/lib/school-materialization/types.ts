/**
 * School materialization product contracts (read path target).
 * Snapshot table deferred: JOIN of complex_school_areas + complex_nearby_schools
 * is preferred for maintainability until measured otherwise.
 */

export const SCHOOL_MAT_SOURCE_VERSION = "koies-2026-03-20";
export const SCHOOL_MAT_BASE_DATE = "2026-03-20";

/** Product display radius — must match nearby-schools.ts. */
export const SCHOOL_MAT_NEARBY_MAX_M = 1500;

/**
 * Persist cap per level for materialization.
 * UI has SCHOOL_MAX_PER_LEVEL=null (all within radius); 24 mirrors prior
 * dev map bound and avoids truncating typical in-radius sets.
 */
export const SCHOOL_MAT_NEARBY_STORE_CAP = 24;

export type SchoolMatLevel = "elementary" | "middle" | "high";

export type ElementaryResolutionStatus =
  | "CONFIRMED_SINGLE"
  | "CONFIRMED_COMMON"
  | "BOUNDARY_AMBIGUOUS"
  | "NO_POLYGON_MATCH"
  | "SCHOOL_CODE_UNRESOLVED"
  | "INVALID_COMPLEX_COORD"
  | "SOURCE_INVALID";

export type DistrictResolutionStatus =
  | "CONFIRMED_SINGLE"
  | "CONFIRMED_COMMON"
  | "BOUNDARY_AMBIGUOUS"
  | "NO_POLYGON_MATCH"
  | "INVALID_COMPLEX_COORD"
  | "UNRESOLVED"
  | "CONFIRMED_SEED";

export type MembershipStatus =
  | "MEMBERSHIP_COMPLETE"
  | "RESOLVED_DISTRICT_ONLY"
  | "PARTIAL"
  | null;

/** Write-eligible: CONFIRMED* with membership when required. */
export function isElementaryWriteEligible(
  status: ElementaryResolutionStatus,
): boolean {
  return status === "CONFIRMED_SINGLE" || status === "CONFIRMED_COMMON";
}

export function isMiddleWriteEligible(params: {
  resolutionStatus: DistrictResolutionStatus;
  membershipStatus: MembershipStatus;
}): boolean {
  if (
    params.resolutionStatus !== "CONFIRMED_SINGLE" &&
    params.resolutionStatus !== "CONFIRMED_COMMON" &&
    params.resolutionStatus !== "CONFIRMED_SEED"
  ) {
    return false;
  }
  return params.membershipStatus === "MEMBERSHIP_COMPLETE";
}

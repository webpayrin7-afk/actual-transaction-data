/**
 * Pure helpers for national building/unit closeout classification + lock semantics.
 * Kept separate so unit tests do not need Production DB.
 */
export type CloseoutBucket =
  | "COMPLETE"
  | "READY_LOCAL"
  | "READY_TITLE"
  | "NO_SOURCE"
  | "AMBIGUOUS"
  | "IDENTITY_GAP"
  | "SUPPLY_AREA_UNAVAILABLE"
  | "FAILED_RETRYABLE";

export function classifyBuildingStatus(input: {
  hasResidentialExact: boolean;
  titleStatus: string | null;
  hasParcel: boolean;
}): { status: CloseoutBucket; reason: string | null } {
  if (input.hasResidentialExact) return { status: "COMPLETE", reason: null };
  if (input.titleStatus === "NO_PARCEL") return { status: "IDENTITY_GAP", reason: "title_NO_PARCEL" };
  if (input.titleStatus === "EMPTY") return { status: "NO_SOURCE", reason: "title_EMPTY" };
  if (input.titleStatus === "SUCCESS" || input.titleStatus === "SKIP_CACHED") {
    return { status: "NO_SOURCE", reason: "title_non_residential_only" };
  }
  if (input.hasParcel) return { status: "READY_TITLE", reason: null };
  return { status: "IDENTITY_GAP", reason: "missing_parcel" };
}

export function classifyAreaStatus(input: {
  hasCanonicalType: boolean;
  hasExclusive: boolean;
  hasSupply: boolean;
}): CloseoutBucket {
  if (input.hasExclusive && input.hasSupply) return "COMPLETE";
  if (input.hasExclusive && !input.hasSupply) return "SUPPLY_AREA_UNAVAILABLE";
  if (!input.hasCanonicalType) return "NO_SOURCE";
  return "NO_SOURCE";
}

export function classifyLinkStatus(input: {
  hasExactLink: boolean;
  hasResidentialExact: boolean;
  hasCanonicalType: boolean;
  hasOuacDongHo: boolean;
}): { status: CloseoutBucket; operation: string | null } {
  if (input.hasExactLink) return { status: "COMPLETE", operation: null };
  if (input.hasResidentialExact && input.hasCanonicalType && input.hasOuacDongHo) {
    return { status: "READY_LOCAL", operation: "ATTEMPT_LINK" };
  }
  if (input.hasResidentialExact && input.hasCanonicalType && !input.hasOuacDongHo) {
    return { status: "IDENTITY_GAP", operation: null };
  }
  return { status: "NO_SOURCE", operation: null };
}

/** Never invent supply pyeong from exclusive㎡. */
export function mayInventSupplyFromExclusive(): false {
  return false;
}

export function lockIsStale(input: {
  lockPid: number | null;
  pidAlive: (pid: number) => boolean;
}): boolean {
  if (input.lockPid == null) return true;
  return !input.pidAlive(input.lockPid);
}

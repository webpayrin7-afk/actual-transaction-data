/** Coordinate write-gate helpers (shared with dry-run). */
export type CoordinateResolutionStatus =
  | "CONFIRMED"
  | "MULTI_SOURCE_CONFIRMED"
  | "SINGLE_SOURCE_HIGH_CONFIDENCE"
  | "PILOT_LOW_CONFIDENCE"
  | "AMBIGUOUS"
  | "ADDRESS_INCOMPLETE"
  | "SOURCE_NO_MATCH"
  | "MULTIPLE_MATCHES"
  | "OUTSIDE_EXPECTED_REGION"
  | "INVALID_COORD"
  | "ERROR";

export function isCoordinateWriteGateEligible(
  status: CoordinateResolutionStatus,
): boolean {
  return (
    status === "CONFIRMED" ||
    status === "MULTI_SOURCE_CONFIRMED" ||
    status === "SINGLE_SOURCE_HIGH_CONFIDENCE"
  );
}

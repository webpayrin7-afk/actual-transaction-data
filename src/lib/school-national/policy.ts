/**
 * Idempotent write policy for school master / snapshots.
 * Same source year never overwrites a stored row.
 * A newer disclosure year may update the current master pointer only.
 */

export type MasterWriteAction = "insert" | "skip" | "update_newer" | "conflict_hold";

export function masterWriteAction(existing: {
  sourceAsOf: string;
  fingerprint: string;
} | null, incoming: {
  sourceAsOf: string;
  fingerprint: string;
}): MasterWriteAction {
  if (!existing) return "insert";
  if (incoming.sourceAsOf === existing.sourceAsOf) {
    return incoming.fingerprint === existing.fingerprint ? "skip" : "conflict_hold";
  }
  if (incoming.sourceAsOf > existing.sourceAsOf) return "update_newer";
  return "skip";
}

export type SnapshotWriteAction = "insert" | "skip";

export function snapshotWriteAction(exists: boolean): SnapshotWriteAction {
  return exists ? "skip" : "insert";
}

export type SchoolRollup = "COMPLETE" | "PARTIAL" | "NO_DATA" | "FAILED";

const SATISFIED = new Set(["COMPLETE", "NOT_APPLICABLE"]);

export function rollupSchool(statuses: readonly string[]): SchoolRollup {
  const applicable = statuses.filter((s) => s !== "NOT_APPLICABLE");
  if (applicable.length === 0) return "COMPLETE";
  if (applicable.every((s) => s === "COMPLETE")) return "COMPLETE";
  if (applicable.every((s) => s === "FAILED")) return "FAILED";
  if (applicable.every((s) => s === "NO_DATA")) return "NO_DATA";
  if (statuses.every((s) => SATISFIED.has(s))) return "COMPLETE";
  return "PARTIAL";
}

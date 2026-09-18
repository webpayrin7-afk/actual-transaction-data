/**
 * Classify one stored fee row against a canonical month result.
 * Missing amounts stay null. A COMPLETE explicit 0 matches a stored 0.
 */
import type { Completeness } from "./types";

export type ReconciliationClass =
  | "EXACT_MATCH"
  | "UNDERCOUNT"
  | "OVERCOUNT"
  | "STORED_ZERO_BUT_MISSING"
  | "STORED_VALUE_BUT_MISSING"
  | "PARTIAL_SOURCE"
  | "MAPPING_BLOCKED"
  | "ERROR";

export function sameWon(left: number, right: number): boolean {
  return Math.round(left) === Math.round(right);
}

export function classifyStoredRow(args: {
  mapped: boolean;
  storedAmount: number | null;
  completeness: Completeness | "FAILED" | null;
  canonicalAmount: number | null;
}): { classification: ReconciliationClass; delta: number | null } {
  if (!args.mapped) {
    return { classification: "MAPPING_BLOCKED", delta: null };
  }
  if (args.completeness === "MISSING") {
    if (args.storedAmount === 0) {
      return { classification: "STORED_ZERO_BUT_MISSING", delta: null };
    }
    return { classification: "STORED_VALUE_BUT_MISSING", delta: null };
  }
  if (args.completeness === "PARTIAL") {
    return { classification: "PARTIAL_SOURCE", delta: null };
  }
  if (
    args.completeness !== "COMPLETE" ||
    args.canonicalAmount == null ||
    args.storedAmount == null ||
    !Number.isFinite(args.canonicalAmount) ||
    !Number.isFinite(args.storedAmount)
  ) {
    return { classification: "ERROR", delta: null };
  }
  const delta = Math.round(args.canonicalAmount) - Math.round(args.storedAmount);
  if (delta === 0) return { classification: "EXACT_MATCH", delta: 0 };
  if (delta > 0) return { classification: "UNDERCOUNT", delta };
  return { classification: "OVERCOUNT", delta };
}

export const CORRECTION_CLASSES = new Set<ReconciliationClass>([
  "UNDERCOUNT",
  "OVERCOUNT",
  "STORED_ZERO_BUT_MISSING",
  "STORED_VALUE_BUT_MISSING",
]);

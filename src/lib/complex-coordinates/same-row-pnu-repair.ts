/**
 * Same-row REB address → cadastral PNU repair.
 * Uses only the stored PNU and the 주소 on that same row. No fuzzy match, no name match.
 */

import {
  deriveSameRowCadastralPnu,
  parseCadastralPnu,
  parseSameRowLot,
  type SameRowRepairCause,
} from "./parcel-key";

export type SameRowRepairClass =
  | "EXACT_ORIGINAL"
  | "REPAIRED_FROM_SAME_ROW_LOT"
  | "ORIGINAL_CONFLICT_REPAIRED"
  | "AMBIGUOUS"
  | "NOT_FOUND"
  | "NO_SOURCE_PARCEL";

export type ParcelLookupStatus = "UNIQUE_VALID" | "MISSING" | "DUPLICATE" | "INVALID_COORD";

export type SameRowRepairDecision = {
  classification: SameRowRepairClass;
  storedPnu: string | null;
  derivedPnu: string | null;
  rawAddress: string | null;
  cause: SameRowRepairCause | null;
};

const SAFE = new Set<SameRowRepairClass>([
  "EXACT_ORIGINAL",
  "REPAIRED_FROM_SAME_ROW_LOT",
  "ORIGINAL_CONFLICT_REPAIRED",
]);

export function isSafeRepairClass(classification: SameRowRepairClass): boolean {
  return SAFE.has(classification);
}

export function classifySameRowRepair(
  storedPnus: string[],
  addresses: string[],
  lookup: (pnu: string) => ParcelLookupStatus,
): SameRowRepairDecision {
  const empty = (classification: SameRowRepairClass, cause: SameRowRepairCause | null = null): SameRowRepairDecision => ({
    classification,
    storedPnu: storedPnus.length === 1 ? storedPnus[0] : null,
    derivedPnu: null,
    rawAddress: addresses[0] ?? null,
    cause,
  });

  if (storedPnus.length === 0) return empty("NO_SOURCE_PARCEL");
  if (storedPnus.length > 1) return empty("AMBIGUOUS");
  const stored = storedPnus[0];
  if (!parseCadastralPnu(stored)) return empty("NO_SOURCE_PARCEL");
  if (addresses.length === 0) return empty("NO_SOURCE_PARCEL");

  const lots = addresses.map((address) => parseSameRowLot(address));
  if (lots.some((lot) => lot == null)) {
    return empty(lots.every((lot) => lot == null) ? "NO_SOURCE_PARCEL" : "AMBIGUOUS");
  }
  const signatures = new Set(lots.map((lot) => `${lot!.mountain ? "2" : "1"}:${lot!.bun}:${lot!.ji}`));
  if (signatures.size !== 1) return empty("AMBIGUOUS");

  const derived = deriveSameRowCadastralPnu(stored, addresses[0]);
  if (!derived.pnu) {
    return empty(derived.cause === "PLAT_MISMATCH" ? "AMBIGUOUS" : "NO_SOURCE_PARCEL", derived.cause);
  }

  const storedStatus = lookup(stored);
  const derivedStatus = lookup(derived.pnu);
  if (derivedStatus === "DUPLICATE") return { ...empty("AMBIGUOUS", derived.cause), derivedPnu: derived.pnu };

  if (derived.pnu === stored) {
    return {
      classification: storedStatus === "UNIQUE_VALID" ? "EXACT_ORIGINAL" : "NOT_FOUND",
      storedPnu: stored,
      derivedPnu: derived.pnu,
      rawAddress: addresses[0],
      cause: null,
    };
  }

  if (derivedStatus === "UNIQUE_VALID") {
    return {
      classification: storedStatus === "UNIQUE_VALID" ? "ORIGINAL_CONFLICT_REPAIRED" : "REPAIRED_FROM_SAME_ROW_LOT",
      storedPnu: stored,
      derivedPnu: derived.pnu,
      rawAddress: addresses[0],
      cause: derived.cause,
    };
  }

  return {
    classification: "NOT_FOUND",
    storedPnu: stored,
    derivedPnu: derived.pnu,
    rawAddress: addresses[0],
    cause: derived.cause,
  };
}

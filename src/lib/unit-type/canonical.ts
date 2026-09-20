import { createHash } from "node:crypto";

/** Square meters per supply pyeong. Apply only to supply_area, never to exclusive_area labels. */
export const SUPPLY_PYEONG_FACTOR = 3.305785;

export const NO_SUPPLY_CENTS = -1;

export const CANONICAL_UNIT_STATUSES = [
  "EXACT_SINGLE",
  "EXACT_MULTI_RESOLVABLE",
  "AMBIGUOUS_MULTI",
  "NO_SOURCE",
] as const;

export type CanonicalUnitStatus = (typeof CANONICAL_UNIT_STATUSES)[number];

export const VERIFIED_SUPPLY_CONFIDENCE = new Set(["exact", "building_registry_expos"]);

export function exclusiveCents(area: number): number {
  if (!Number.isFinite(area) || area <= 0) return -1;
  return Math.round(area * 100);
}

export function areaFromCents(cents: number): number {
  return cents / 100;
}

/** Unrounded supply pyeong. User-facing 평당가 divides by this, not by an exclusive conversion. */
export function exactSupplyPyeong(supplyAreaSqm: number): number {
  return supplyAreaSqm / SUPPLY_PYEONG_FACTOR;
}

/** Canonical stored pyeong. 109.29㎡ → 33.06. The integer label is stored separately. */
export function canonicalSupplyPyeong(supplyAreaSqm: number): number {
  return Math.round(exactSupplyPyeong(supplyAreaSqm) * 100) / 100;
}

/**
 * One verified supply → EXACT_SINGLE.
 * Several supplies the trade row cannot tell apart → AMBIGUOUS_MULTI.
 * Several supplies with an external discriminator → EXACT_MULTI_RESOLVABLE.
 * No verified supply → NO_SOURCE.
 * Never picks a nearest or majority variant.
 */
export function resolutionStatus(supplyCount: number, tradeCanIdentifyVariant: boolean): CanonicalUnitStatus {
  if (supplyCount <= 0) return "NO_SOURCE";
  if (supplyCount === 1) return "EXACT_SINGLE";
  if (tradeCanIdentifyVariant) return "EXACT_MULTI_RESOLVABLE";
  return "AMBIGUOUS_MULTI";
}

/** Stable canonical id. Not a provider URL. */
export function canonicalUnitTypeId(complexId: string, exclusiveCentsValue: number, supplyCents: number): string {
  const digest = createHash("sha256")
    .update(`${complexId}|${exclusiveCentsValue}|${supplyCents}`)
    .digest("hex")
    .slice(0, 32);
  return `ut_${digest}`;
}

export function conflictId(
  complexId: string,
  exclusiveCentsValue: number,
  heldSupplyCents: number,
  heldSourceKey: string,
): string {
  const digest = createHash("sha256")
    .update(`${complexId}|${exclusiveCentsValue}|${heldSupplyCents}|${heldSourceKey}`)
    .digest("hex")
    .slice(0, 32);
  return `cf_${digest}`;
}

/** deal_amount / exact supply pyeong. Returns null unless the supply area is a positive verified number. */
export function pricePerSupplyPyeong(dealAmount: number, supplyAreaSqm: number): number | null {
  if (!(dealAmount > 0) || !(supplyAreaSqm > 0)) return null;
  const pyeong = exactSupplyPyeong(supplyAreaSqm);
  if (!(pyeong > 0)) return null;
  return dealAmount / pyeong;
}

/** Internal exclusive metric. This is not 평당가. */
export function pricePerExclusiveSqm(dealAmount: number, exclusiveAreaSqm: number): number | null {
  if (!(dealAmount > 0) || !(exclusiveAreaSqm > 0)) return null;
  return dealAmount / exclusiveAreaSqm;
}

/** 30평대 means 30 <= supply_pyeong < 40. Ranking 59/84/114 bands are a different contract. */
export function supplyPyeongCohort(supplyPyeong: number): string | null {
  if (!Number.isFinite(supplyPyeong) || supplyPyeong < 10) return null;
  const decade = Math.floor(supplyPyeong / 10) * 10;
  return `${decade}평대`;
}

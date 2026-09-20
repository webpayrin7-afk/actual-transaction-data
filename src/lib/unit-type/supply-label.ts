import {
  canonicalSupplyPyeong,
  exactSupplyPyeong,
  type CanonicalUnitStatus,
} from "@/lib/unit-type/canonical";

export type SupplyLabelInput = {
  unitTypeId: string;
  exclusiveArea: number;
  supplyArea: number | null;
  status: CanonicalUnitStatus;
};

export type SelectorSupplyOption = {
  unitTypeId: string;
  exclusiveArea: number;
  supplyArea: number;
  supplyPyeong: number;
  displayLabel: string;
  detailLabel: string;
  status: CanonicalUnitStatus;
  /** True only when a trade filtered by this exclusive area has one verified supply. */
  usableForUnscopedTrade: boolean;
};

/** Existing label version. Integer 평형 is round(canonical supply pyeong), not a new rule. */
export const PYEONG_LABEL_VERSION = "canonical-supply-pyeong-round-v1";

/** Integer market label derived from supply pyeong. 33.06 → "33평". Does not replace the stored pyeong. */
export function supplyPyeongDisplayLabel(supplyAreaSqm: number): string {
  const pyeong = canonicalSupplyPyeong(supplyAreaSqm);
  return `${Math.round(pyeong)}평`;
}

/** Integer denominator used by supplyPyeongDisplayLabel. 109.29㎡ → 33. */
export function marketPyeongLabelInteger(supplyAreaSqm: number): number | null {
  const pyeong = canonicalSupplyPyeong(supplyAreaSqm);
  if (!Number.isFinite(pyeong) || pyeong <= 0) return null;
  const label = Math.round(pyeong);
  return label > 0 ? label : null;
}

/**
 * Read helper for a future area selector.
 * Trade queries stay on exclusive area. URL ?area= is unchanged.
 * Ambiguous and missing supplies do not produce a 평당가 label.
 */
export function selectorSupplyOption(row: SupplyLabelInput): SelectorSupplyOption | null {
  if (row.supplyArea == null || !(row.supplyArea > 0)) return null;
  if (row.status !== "EXACT_SINGLE" && row.status !== "EXACT_MULTI_RESOLVABLE" && row.status !== "AMBIGUOUS_MULTI") {
    return null;
  }
  const supplyPyeong = canonicalSupplyPyeong(row.supplyArea);
  const displayLabel = supplyPyeongDisplayLabel(row.supplyArea);
  const exclusiveText = row.exclusiveArea.toFixed(2);
  return {
    unitTypeId: row.unitTypeId,
    exclusiveArea: row.exclusiveArea,
    supplyArea: row.supplyArea,
    supplyPyeong,
    displayLabel,
    detailLabel: `${displayLabel} · 전용 ${exclusiveText}㎡`,
    status: row.status,
    usableForUnscopedTrade: row.status === "EXACT_SINGLE",
  };
}

export function selectorOptionsForComplex(rows: SupplyLabelInput[]): SelectorSupplyOption[] {
  const options: SelectorSupplyOption[] = [];
  for (const row of rows) {
    const option = selectorSupplyOption(row);
    if (option) options.push(option);
  }
  return options;
}

export function complexHasCanonicalSupplyLabel(rows: SupplyLabelInput[]): boolean {
  return selectorOptionsForComplex(rows).some((option) => option.usableForUnscopedTrade);
}

export function exactSupplyPyeongForLabel(supplyAreaSqm: number): number {
  return exactSupplyPyeong(supplyAreaSqm);
}

/**
 * Selector area contract (no UI change in this pass):
 * - ㎡ display and trade filter key = exclusive area
 * - 평 / 평당가 label = supply area (EXACT_SINGLE only for unscoped trades)
 */
export type SelectorSupplyCoverage = {
  supplyReadyComplexes: number;
  supplyReadyPairs: number;
  /** True when at least one EXACT_SINGLE supply mapping is available for selector labels. */
  SELECTOR_SUPPLY_READY: boolean;
};

export function selectorSupplyCoverage(params: {
  supplyReadyComplexes: number;
  supplyReadyPairs: number;
}): SelectorSupplyCoverage {
  const supplyReadyComplexes = Math.max(0, Math.floor(params.supplyReadyComplexes));
  const supplyReadyPairs = Math.max(0, Math.floor(params.supplyReadyPairs));
  return {
    supplyReadyComplexes,
    supplyReadyPairs,
    SELECTOR_SUPPLY_READY: supplyReadyComplexes > 0 && supplyReadyPairs > 0,
  };
}

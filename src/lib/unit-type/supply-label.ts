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

/** Integer market label derived from supply pyeong. 33.06 → "33평". Does not replace the stored pyeong. */
export function supplyPyeongDisplayLabel(supplyAreaSqm: number): string {
  const pyeong = canonicalSupplyPyeong(supplyAreaSqm);
  return `${Math.round(pyeong)}평`;
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

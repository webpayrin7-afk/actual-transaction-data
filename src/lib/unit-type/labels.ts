import type {
  GroupDisplayMode,
  UnitTypeClassification,
} from "@/lib/unit-type/types";

function fmtSqm(n: number): string {
  const s = n.toFixed(2);
  return s.replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}

function rangeText(min: number, max: number): string {
  if (Math.abs(min - max) < 0.005) return `${fmtSqm(min)}㎡`;
  return `${fmtSqm(min)}~${fmtSqm(max)}㎡`;
}

export function resolveGroupDisplayMode(
  classification: UnitTypeClassification,
  marketLabel: number | null,
): GroupDisplayMode {
  if (
    classification === "ambiguous" ||
    classification === "registry-abnormal"
  ) {
    return "exclusive_only";
  }
  if (classification === "auto-safe" && marketLabel != null) {
    return "label+range";
  }
  return "range_only";
}

/** Selector primary line — A shows market label; B range-only. */
export function formatMarketGroupLabel(group: {
  marketLabel: number | null;
  displayMode: GroupDisplayMode;
  supplyAreaMin: number | null;
  supplyAreaMax: number | null;
  exclusiveAreaMin: number;
  exclusiveAreaMax: number;
}): string {
  if (group.displayMode === "label+range" && group.marketLabel != null) {
    return `${group.marketLabel}평형`;
  }
  if (group.displayMode === "exclusive_only") {
    return `전용 ${rangeText(group.exclusiveAreaMin, group.exclusiveAreaMax)}형`;
  }
  const supply =
    group.supplyAreaMin != null && group.supplyAreaMax != null
      ? `공급 ${rangeText(group.supplyAreaMin, group.supplyAreaMax)}`
      : null;
  const exclusive = `전용 ${rangeText(group.exclusiveAreaMin, group.exclusiveAreaMax)}`;
  return supply ? `${supply} · ${exclusive}` : exclusive;
}

/** Optional secondary line under A label. */
export function formatMarketGroupSecondary(group: {
  displayMode: GroupDisplayMode;
  supplyAreaMin: number | null;
  supplyAreaMax: number | null;
  exclusiveAreaMin: number;
  exclusiveAreaMax: number;
}): string | null {
  if (group.displayMode !== "label+range") return null;
  const supply =
    group.supplyAreaMin != null && group.supplyAreaMax != null
      ? `공급 ${rangeText(group.supplyAreaMin, group.supplyAreaMax)}`
      : null;
  const exclusive = `전용 ${rangeText(group.exclusiveAreaMin, group.exclusiveAreaMax)}`;
  return supply ? `${supply} · ${exclusive}` : exclusive;
}


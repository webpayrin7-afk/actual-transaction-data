import type { AptAreaOption } from "@/lib/molit/apt-client";

/** Legal/common Korean pyeong factor (1평 = 3.3058㎡). */
export const SQM_PER_PYEONG = 3.3058;

function fmtSqm(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const s = n.toFixed(2);
  return s.replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}

function rangeText(min: number, max: number): string {
  if (Math.abs(min - max) < 0.005) return `${fmtSqm(min)}㎡`;
  return `${fmtSqm(min)}~${fmtSqm(max)}㎡`;
}

/**
 * Deterministic representative 평형 from a supply-area range.
 * Rule: mid = (min+max)/2; round(mid / 3.3058) → integer 평.
 * Does not change Phase5 grouping boundaries.
 */
export function representativePyeongFromSupplySqm(
  supplyMin: number,
  supplyMax: number,
): number {
  const mid = (supplyMin + supplyMax) / 2;
  return Math.round(mid / SQM_PER_PYEONG);
}

export function representativePyeongFromExclusiveSqm(exclusiveSqm: number): number {
  return Math.round(exclusiveSqm / SQM_PER_PYEONG);
}

/**
 * Primary selector label — "33평".
 * Prefer Phase5 marketLabel; else supply-area mid / 3.3058.
 * Never convert exclusiveArea / 3.3058 — that is not ZIPLAB 평.
 * Returns null when no market/supply label source exists.
 */
export function areaSelectorPyeongLabel(area: AptAreaOption): string | null {
  if (area.marketLabel != null && Number.isFinite(area.marketLabel)) {
    return `${Math.round(area.marketLabel)}평`;
  }
  const sMin = area.supplyAreaMin;
  const sMax = area.supplyAreaMax;
  if (
    sMin != null &&
    sMax != null &&
    Number.isFinite(sMin) &&
    Number.isFinite(sMax) &&
    sMin > 0 &&
    sMax > 0
  ) {
    return `${representativePyeongFromSupplySqm(sMin, sMax)}평`;
  }
  return null;
}

/** Secondary line — "전용 84.80~84.97㎡" (never truncated in UI). */
export function areaSelectorExclusiveLabel(area: AptAreaOption): string {
  const min = area.exclusiveAreaMin ?? area.exclusiveArea;
  const max = area.exclusiveAreaMax ?? area.exclusiveArea;
  if (!Number.isFinite(min) || !Number.isFinite(max)) return "전용 —";
  // 묶인 평형(같은 타입, 신고값만 소수점 차이)은 정수 전용으로 — "전용 84㎡"
  if (max - min >= 0.005 && Math.floor(min) === Math.floor(max)) return `전용 ${Math.floor(min)}㎡`;
  return `전용 ${rangeText(min, max)}`;
}

/** Closed trigger: "33평 · 전용 84.80~84.97㎡" (exclusive-only when no 평 source). */
export function areaSelectorClosedLabel(area: AptAreaOption): string {
  const pyeong = areaSelectorPyeongLabel(area);
  const exclusive = areaSelectorExclusiveLabel(area);
  return pyeong ? `${pyeong} · ${exclusive}` : exclusive;
}

/** Sticky compact (legacy helper): now same as closed — "33평 · 전용 84.80~84.97㎡". */
export function areaSelectorStickyLabel(area: AptAreaOption): string {
  return areaSelectorClosedLabel(area);
}

/** Tertiary / optional — "공급 109.29~111.52㎡". Null when unavailable. */
export function areaSelectorSupplyLabel(area: AptAreaOption): string | null {
  const sMin = area.supplyAreaMin;
  const sMax = area.supplyAreaMax;
  if (
    sMin == null ||
    sMax == null ||
    !Number.isFinite(sMin) ||
    !Number.isFinite(sMax) ||
    sMin <= 0 ||
    sMax <= 0
  ) {
    return null;
  }
  return `공급 ${rangeText(sMin, sMax)}`;
}

export function areaSelectorDealCountLabel(count: number): string {
  return `거래 ${count.toLocaleString("ko-KR")}건`;
}

/**
 * Phase 8 — optional external enrichment readiness (no new paid signups).
 * Schools / surroundings only activate when keys + coordinates exist.
 */

export type AdvancedSourceStatus =
  | "READY"
  | "DATA_SOURCE_NOT_READY"
  | "NO_COORDINATES"
  | "ERROR";

export type AdvancedSourceMeta = {
  status: AdvancedSourceStatus;
  reason: string;
};

export function neisApiKey(): string | null {
  const key =
    process.env.NEIS_API_KEY?.trim() ||
    process.env.NEIS_KEY?.trim() ||
    "";
  return key || null;
}

export function vworldApiKey(): string | null {
  const key =
    process.env.VWORLD_API_KEY?.trim() ||
    process.env.VWORLD_KEY?.trim() ||
    "";
  return key || null;
}

export function neisReadiness(hasCoords: boolean): AdvancedSourceMeta {
  if (!neisApiKey()) {
    return {
      status: "DATA_SOURCE_NOT_READY",
      reason: "NEIS API 키가 환경에 없어 학군 조회를 건너뜁니다.",
    };
  }
  if (!hasCoords) {
    return {
      status: "NO_COORDINATES",
      reason: "단지 좌표가 없어 인근 학교를 계산할 수 없습니다.",
    };
  }
  return { status: "READY", reason: "" };
}

export function vworldReadiness(hasCoords: boolean): AdvancedSourceMeta {
  if (!vworldApiKey()) {
    return {
      status: "DATA_SOURCE_NOT_READY",
      reason: "VWorld API 키가 환경에 없어 주변환경 조회를 건너뜁니다.",
    };
  }
  if (!hasCoords) {
    return {
      status: "NO_COORDINATES",
      reason: "단지 좌표가 없어 주변 시설 거리를 계산할 수 없습니다.",
    };
  }
  return { status: "READY", reason: "" };
}

/** Area-based management fee audit (K-APT fields). */
export type AreaFeeClassification =
  | "AREA_FEE_OFFICIAL"
  | "AREA_FEE_DERIVABLE_SAFE"
  | "AREA_FEE_CONDITIONAL"
  | "AREA_FEE_UNSAFE";

/**
 * Current warehouse stores complex totals + household_basis only.
 * Approved K-apt fee APIs return complex-month KRW totals (line items + sLevy).
 * per_area_* / area_basis_sqm columns exist in schema but apply path inserts NULL —
 * no official 원/㎡ schedule or confirmed area basis → AREA_FEE_UNSAFE.
 * Do not invent selected-pyeong fees by dividing totals by privArea / supply 평.
 */
export const MANAGEMENT_AREA_FEE_CLASSIFICATION: AreaFeeClassification =
  "AREA_FEE_UNSAFE";

export const MANAGEMENT_AREA_FEE_NOTE =
  "공식 면적단가(원/㎡)와 기준면적(전용·공급·부과 등)이 승인 API에서 확인되지 않아 선택 평형 관리비는 표시하지 않습니다. 단지 총액÷세대수 값은 참고용이며 선택 평형 부과액이 아닙니다.";

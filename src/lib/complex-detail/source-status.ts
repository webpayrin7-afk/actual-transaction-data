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
 * per_area_* columns exist but are not reliably populated from an official
 * ㎡ charge schedule → treat area-specific fee as UNSAFE for product labels.
 */
export const MANAGEMENT_AREA_FEE_CLASSIFICATION: AreaFeeClassification =
  "AREA_FEE_UNSAFE";

export const MANAGEMENT_AREA_FEE_NOTE =
  "면적(㎡·평형) 기준 공식 단가가 검증되지 않아 세대당 단순 환산만 표시합니다.";

/**
 * 주택형/공급면적 마스터 (PoC).
 *
 * - transactions에 공급면적을 억지로 넣지 않음.
 * - 전용÷3.3 평형 추정 금지.
 * - 공급면적 공식 검증 전에는 N평형 라벨 확정 금지.
 * - exclusive float 동등비교 금지 → cents(×100).
 */

export type UnitTypeVerification =
  | "official"
  | "commercial_crosscheck"
  | "inferred";

export type MappingStatus = "unique" | "ambiguous" | "unmatched";

export type AptComplexIdentity = {
  complexId: string;
  lawdCd: string;
  aptNameNorm: string;
  aptNameDisplay: string;
  kaptCode: string | null;
  jibun: string | null;
  roadAddress: string | null;
  source: string;
  sourceUpdatedAt: string;
};

/** @deprecated alias kept for call-site clarity */
export type AptComplex = AptComplexIdentity;

export type AptUnitType = {
  typeId: string;
  complexId: string;
  typeName: string | null;
  supplyAreaSqm: number | null;
  exclusiveAreaSqm: number;
  exclusiveAreaMin: number;
  exclusiveAreaMax: number;
  /** 공급면적 있을 때만. 전용 기반 생성 금지. */
  pyeongGroup: number | null;
  householdCount: number | null;
  verification: UnitTypeVerification;
  source: string;
  sourceUpdatedAt: string;
};

export type ExclusiveAlias = {
  complexId: string;
  exclusiveAreaCents: number;
  typeId: string | null;
  pyeongGroup: number | null;
  mappingStatus: MappingStatus;
};

export function exclusiveAreaCents(sqm: number): number {
  return Math.round(sqm * 100);
}

/**
 * 공급면적 → 관례 평형 추정 (참고용).
 * 전용면적 입력 금지.
 *
 * 주의: 81.8/3.3≈24.8 → round=25 인데, 현장/매물은 종종 "24평형"으로 표기.
 * 따라서 UI·신고가 그룹의 pyeong_group은 반드시 마스터 명시값을 쓰고
 * 이 함수로 덮어쓰지 말 것.
 */
export function pyeongFromSupplyArea(supplySqm: number): number {
  if (!Number.isFinite(supplySqm) || supplySqm <= 0) {
    throw new Error("pyeongFromSupplyArea requires positive supply area");
  }
  return Math.round(supplySqm / 3.3);
}

export function formatUnitTypeLabel(type: AptUnitType): {
  primary: string;
  secondary: string | null;
} {
  const excl =
    Math.abs(type.exclusiveAreaMax - type.exclusiveAreaMin) < 0.005
      ? formatSqm(type.exclusiveAreaMin)
      : `${formatSqm(type.exclusiveAreaMin)}~${formatSqm(type.exclusiveAreaMax)}`;

  if (
    type.supplyAreaSqm != null &&
    type.pyeongGroup != null &&
    type.verification === "official"
  ) {
    return {
      primary: `${type.pyeongGroup}평형`,
      secondary: `공급 ${formatSqm(type.supplyAreaSqm)}㎡ · 전용 ${excl}㎡`,
    };
  }

  return {
    primary: `전용 ${excl}㎡형`,
    secondary: null,
  };
}

function formatSqm(n: number): string {
  const rounded = Math.round(n * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

/**
 * exclusive → type 매핑.
 * 같은 exclusive가 여러 type에 속하면 typeId=null + ambiguous.
 * 다만 동일 pyeongGroup이면 신고가 그룹용 pyeongGroup은 유지.
 */
export function buildExclusiveAliases(
  complexId: string,
  types: AptUnitType[],
  observedExclusiveAreas: number[],
): ExclusiveAlias[] {
  const centsList = [
    ...new Set(observedExclusiveAreas.map(exclusiveAreaCents)),
  ].sort((a, b) => a - b);

  return centsList.map((cents) => {
    const hits = types.filter(
      (t) =>
        t.complexId === complexId &&
        cents >= exclusiveAreaCents(t.exclusiveAreaMin) &&
        cents <= exclusiveAreaCents(t.exclusiveAreaMax),
    );

    if (hits.length === 0) {
      return {
        complexId,
        exclusiveAreaCents: cents,
        typeId: null,
        pyeongGroup: null,
        mappingStatus: "unmatched" as const,
      };
    }

    if (hits.length === 1) {
      return {
        complexId,
        exclusiveAreaCents: cents,
        typeId: hits[0].typeId,
        pyeongGroup: hits[0].pyeongGroup,
        mappingStatus: "unique" as const,
      };
    }

    const pyeongSet = new Set(
      hits.map((h) => h.pyeongGroup).filter((v): v is number => v != null),
    );

    return {
      complexId,
      exclusiveAreaCents: cents,
      typeId: null,
      pyeongGroup: pyeongSet.size === 1 ? [...pyeongSet][0]! : null,
      mappingStatus: "ambiguous" as const,
    };
  });
}

/**
 * 신고가 그룹 키.
 * - pyeongGroup이 있으면 공급평형 그룹
 * - 없으면 exact exclusive
 * (production 신고가 로직 변경 없음 — PoC 소속 산출용)
 */
export function resolveSingogaGroupKey(
  exclusiveArea: number,
  aliases: ExclusiveAlias[],
): string {
  const cents = exclusiveAreaCents(exclusiveArea);
  const alias = aliases.find((a) => a.exclusiveAreaCents === cents);
  if (!alias || alias.mappingStatus === "unmatched") {
    return `exclusive:${cents}`;
  }
  if (alias.pyeongGroup != null) {
    return `pyeong:${alias.pyeongGroup}`;
  }
  return `exclusive:${cents}`;
}

/* -------------------------------------------------------------------------- */
/* 한강(대우) PoC fixture                                                     */
/* -------------------------------------------------------------------------- */

export const HANGANG_DAEWOO_COMPLEX: AptComplexIdentity = {
  complexId: "kr-11170-hangang-daewoo",
  lawdCd: "11170",
  aptNameNorm: "한강(대우)",
  aptNameDisplay: "한강(대우)",
  kaptCode: "A14003105",
  jibun: "415",
  roadAddress: "서울특별시 용산구 이촌로 181",
  source: "k-apt:getKaptInfo_detail",
  sourceUpdatedAt: "2026-09-11",
};

/**
 * 공급㎡·타입명: 상업 공개화면 교차검증 (공식 API 미확보).
 * verification=commercial_crosscheck → formatUnitTypeLabel는 평형 미표시.
 * exclusive min/max: Turso 실측.
 */
export const HANGANG_DAEWOO_UNIT_TYPES: AptUnitType[] = [
  {
    typeId: "hangang-daewoo-24-81a",
    complexId: HANGANG_DAEWOO_COMPLEX.complexId,
    typeName: "81A",
    supplyAreaSqm: 81.8,
    exclusiveAreaSqm: 60,
    exclusiveAreaMin: 59.98,
    exclusiveAreaMax: 60,
    pyeongGroup: 24,
    householdCount: 187,
    verification: "commercial_crosscheck",
    source: "commercial_listing_crosscheck+kapt_band",
    sourceUpdatedAt: "2026-09-11",
  },
  {
    typeId: "hangang-daewoo-24-81b",
    complexId: HANGANG_DAEWOO_COMPLEX.complexId,
    typeName: "81B",
    supplyAreaSqm: 81.6,
    exclusiveAreaSqm: 60,
    exclusiveAreaMin: 59.98,
    exclusiveAreaMax: 60,
    pyeongGroup: 24,
    householdCount: 19,
    verification: "commercial_crosscheck",
    source: "commercial_listing_crosscheck+kapt_band",
    sourceUpdatedAt: "2026-09-11",
  },
  {
    typeId: "hangang-daewoo-33-109a",
    complexId: HANGANG_DAEWOO_COMPLEX.complexId,
    typeName: "109A",
    supplyAreaSqm: 109.3,
    exclusiveAreaSqm: 84.98,
    exclusiveAreaMin: 84.94,
    exclusiveAreaMax: 84.98,
    pyeongGroup: 33,
    householdCount: 293,
    verification: "commercial_crosscheck",
    source: "commercial_listing_crosscheck+kapt_band",
    sourceUpdatedAt: "2026-09-11",
  },
  {
    typeId: "hangang-daewoo-33-109b",
    complexId: HANGANG_DAEWOO_COMPLEX.complexId,
    typeName: "109B",
    supplyAreaSqm: 109.6,
    exclusiveAreaSqm: 84.98,
    exclusiveAreaMin: 84.94,
    exclusiveAreaMax: 84.98,
    pyeongGroup: 33,
    householdCount: 24,
    verification: "commercial_crosscheck",
    source: "commercial_listing_crosscheck+kapt_band",
    sourceUpdatedAt: "2026-09-11",
  },
  {
    typeId: "hangang-daewoo-33-117",
    complexId: HANGANG_DAEWOO_COMPLEX.complexId,
    typeName: "117",
    supplyAreaSqm: 117.1,
    exclusiveAreaSqm: 84.98,
    exclusiveAreaMin: 84.94,
    exclusiveAreaMax: 84.98,
    pyeongGroup: 33,
    householdCount: 40,
    verification: "commercial_crosscheck",
    source: "commercial_listing_crosscheck+kapt_band",
    sourceUpdatedAt: "2026-09-11",
  },
  {
    typeId: "hangang-daewoo-49-163",
    complexId: HANGANG_DAEWOO_COMPLEX.complexId,
    typeName: "163",
    supplyAreaSqm: 163.3,
    exclusiveAreaSqm: 134.13,
    exclusiveAreaMin: 134.13,
    exclusiveAreaMax: 134.13,
    pyeongGroup: 49,
    householdCount: 156,
    verification: "commercial_crosscheck",
    source: "commercial_listing_crosscheck+kapt_band",
    sourceUpdatedAt: "2026-09-11",
  },
  {
    typeId: "hangang-daewoo-50-164b",
    complexId: HANGANG_DAEWOO_COMPLEX.complexId,
    typeName: "164B",
    supplyAreaSqm: 164.9,
    exclusiveAreaSqm: 135.5,
    exclusiveAreaMin: 135.27,
    exclusiveAreaMax: 135.87,
    pyeongGroup: 50,
    householdCount: 24,
    verification: "commercial_crosscheck",
    source: "commercial_listing_crosscheck+kapt_band",
    sourceUpdatedAt: "2026-09-11",
  },
  {
    typeId: "hangang-daewoo-50-165a",
    complexId: HANGANG_DAEWOO_COMPLEX.complexId,
    typeName: "165A",
    supplyAreaSqm: 165.1,
    exclusiveAreaSqm: 135.5,
    exclusiveAreaMin: 135.27,
    exclusiveAreaMax: 135.87,
    pyeongGroup: 50,
    householdCount: 44,
    verification: "commercial_crosscheck",
    source: "commercial_listing_crosscheck+kapt_band",
    sourceUpdatedAt: "2026-09-11",
  },
  {
    typeId: "hangang-daewoo-50-166c",
    complexId: HANGANG_DAEWOO_COMPLEX.complexId,
    typeName: "166C",
    supplyAreaSqm: 166.7,
    exclusiveAreaSqm: 135.87,
    exclusiveAreaMin: 135.27,
    exclusiveAreaMax: 135.87,
    pyeongGroup: 50,
    householdCount: 47,
    verification: "commercial_crosscheck",
    source: "commercial_listing_crosscheck+kapt_band",
    sourceUpdatedAt: "2026-09-11",
  },
];

export const HANGANG_OBSERVED_EXCLUSIVE_AREAS = [
  59.98, 60, 84.94, 84.98, 134.13, 135.27, 135.5, 135.87,
];

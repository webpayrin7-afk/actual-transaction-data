/**
 * 주택형/공급면적 마스터 (PoC).
 *
 * - transactions에 공급면적을 억지로 넣지 않음.
 * - 전용÷3.3 평형 추정 금지.
 * - 공급면적 공식 검증 전 N평형 라벨 확정 금지.
 * - exclusive float 동등비교 금지 → cents(×100).
 * - exclusive만 비슷하다고 같은 타입으로 합치지 않음 (supply 조합 키).
 */

export type UnitTypeVerification =
  | "official"
  | "commercial_crosscheck"
  | "inferred";

export type MappingStatus = "unique" | "ambiguous" | "unmatched";

export type MappingConfidence = "exact" | "grouped" | "ambiguous";

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

/** @deprecated */
export type AptComplex = AptComplexIdentity;

export type AptUnitType = {
  typeId: string;
  complexId: string;
  typeName: string | null;
  supplyAreaSqm: number | null;
  exclusiveAreaSqm: number;
  exclusiveAreaMin: number;
  exclusiveAreaMax: number;
  residentialCommonAreaSqm: number | null;
  /**
   * 시장 표기 평형. round(supply/3.3) 자동 확정 금지.
   * 한강 81.x는 공개 표기 24/25 혼재 → null.
   */
  marketPyeongLabel: number | null;
  /** @deprecated use marketPyeongLabel */
  pyeongGroup: number | null;
  householdCount: number | null;
  mappingConfidence: MappingConfidence;
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
 * 공급면적 → 관례 평형 추정 (참고용만, 마스터 덮어쓰기 금지).
 * 81.8/3.3≈24.79 → round=25. 공개 표기는 24/25 혼재.
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
    type.marketPyeongLabel != null &&
    type.verification === "official"
  ) {
    return {
      primary: `${type.marketPyeongLabel}평형`,
      secondary: `공급 ${formatSqm(type.supplyAreaSqm)}㎡ · 전용 ${excl}㎡`,
    };
  }

  if (type.supplyAreaSqm != null && type.verification === "official") {
    return {
      primary: `공급 ${formatSqm(type.supplyAreaSqm)}㎡형`,
      secondary: `전용 ${excl}㎡ · 시장평형 미확정`,
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
 * 같은 exclusive가 서로 다른 supply 타입에 속하면 typeId=null + ambiguous.
 * 후보 marketPyeongLabel이 모두 같으면 pyeongGroup만 유지.
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
      const t = hits[0]!;
      return {
        complexId,
        exclusiveAreaCents: cents,
        typeId: t.typeId,
        pyeongGroup: t.marketPyeongLabel ?? t.pyeongGroup,
        mappingStatus: "unique" as const,
      };
    }

    const pyeongSet = new Set(
      hits
        .map((h) => h.marketPyeongLabel ?? h.pyeongGroup)
        .filter((v): v is number => v != null),
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
 * 신고가 그룹 키 (PoC). production 신고가 로직 변경 없음.
 * market pyeong 미확정이면 null → 평형 신고가에서 제외.
 */
export function resolveSingogaGroupKey(
  exclusiveArea: number,
  aliases: ExclusiveAlias[],
): string | null {
  const cents = exclusiveAreaCents(exclusiveArea);
  const alias = aliases.find((a) => a.exclusiveAreaCents === cents);
  if (!alias || alias.mappingStatus === "unmatched") return null;
  if (alias.pyeongGroup != null) return `pyeong:${alias.pyeongGroup}`;
  if (alias.mappingStatus === "ambiguous") return null;
  return `exclusive:${cents}`;
}

/* -------------------------------------------------------------------------- */
/* 한강(대우) fixture — 건축물대장 전유+주거공용 (phase2 official)              */
/* -------------------------------------------------------------------------- */

export const HANGANG_DAEWOO_COMPLEX: AptComplexIdentity = {
  complexId: "kr-11170-hangang-daewoo",
  lawdCd: "11170",
  aptNameNorm: "한강(대우)",
  aptNameDisplay: "한강(대우)",
  kaptCode: "A14003105",
  jibun: "415",
  roadAddress: "서울특별시 용산구 이촌로 181",
  source: "building_register_expos_pubuse+k-apt",
  sourceUpdatedAt: "2026-09-11",
};

function hangangType(opts: {
  name: string;
  exclusive: number;
  supply: number;
  households: number;
  marketPyeong: number | null;
  confidence?: MappingConfidence;
}): AptUnitType {
  const common =
    Math.round((opts.supply - opts.exclusive) * 100 + 1e-9) / 100;
  const typeId = `A14003105:${opts.exclusive.toFixed(2)}:${opts.supply.toFixed(2)}`;
  return {
    typeId,
    complexId: HANGANG_DAEWOO_COMPLEX.complexId,
    typeName: opts.name,
    supplyAreaSqm: opts.supply,
    exclusiveAreaSqm: opts.exclusive,
    exclusiveAreaMin: opts.exclusive,
    exclusiveAreaMax: opts.exclusive,
    residentialCommonAreaSqm: common,
    marketPyeongLabel: opts.marketPyeong,
    pyeongGroup: opts.marketPyeong,
    householdCount: opts.households,
    mappingConfidence: opts.confidence ?? "exact",
    verification: "official",
    source: "building_register_expos_pubuse",
    sourceUpdatedAt: "2026-09-11",
  };
}

/**
 * 공급 = 전유 + 주거공용(주건축물 공용: 계단/엘리베이터/복도/현관/대피소).
 * 부속(주차장 등) 제외. 세대합 834 = K-apt.
 */
export const HANGANG_DAEWOO_UNIT_TYPES: AptUnitType[] = [
  hangangType({
    name: "81A",
    exclusive: 60.0,
    supply: 81.81,
    households: 184,
    marketPyeong: null,
  }),
  hangangType({
    name: "81B",
    exclusive: 59.98,
    supply: 81.6,
    households: 19,
    marketPyeong: null,
  }),
  hangangType({
    name: "82-rare-a",
    exclusive: 60.0,
    supply: 82.28,
    households: 1,
    marketPyeong: null,
    confidence: "grouped",
  }),
  hangangType({
    name: "82-rare-b",
    exclusive: 60.0,
    supply: 82.31,
    households: 2,
    marketPyeong: null,
    confidence: "grouped",
  }),
  hangangType({
    name: "109A",
    exclusive: 84.98,
    supply: 109.26,
    households: 293,
    marketPyeong: 33,
  }),
  hangangType({
    name: "109B",
    exclusive: 84.94,
    supply: 109.56,
    households: 24,
    marketPyeong: 33,
  }),
  hangangType({
    name: "117",
    exclusive: 84.98,
    supply: 117.13,
    households: 40,
    marketPyeong: 33,
  }),
  hangangType({
    name: "163",
    exclusive: 134.13,
    supply: 163.34,
    households: 156,
    marketPyeong: 49,
  }),
  hangangType({
    name: "164B",
    exclusive: 135.27,
    supply: 164.89,
    households: 24,
    marketPyeong: 50,
  }),
  hangangType({
    name: "165A",
    exclusive: 135.87,
    supply: 165.08,
    households: 44,
    marketPyeong: 50,
  }),
  hangangType({
    name: "166C",
    exclusive: 135.5,
    supply: 166.73,
    households: 47,
    marketPyeong: 50,
  }),
];

export const HANGANG_OBSERVED_EXCLUSIVE_AREAS = [
  59.98, 60, 84.94, 84.98, 134.13, 135.27, 135.5, 135.87,
];

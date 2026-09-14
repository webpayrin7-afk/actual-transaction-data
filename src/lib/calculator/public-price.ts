/**
 * Complex public-price (공동주택 공시가격) adapter boundary.
 *
 * Phase 1.4B: 잠실엘스 UNIT_EXACT pilot wired from MOLIT bulk fixture
 * (dataset 3073746). No nationwide ingest, no scraping.
 */

import {
  JAMSIL_ELS_LATEST_BULK_YEAR,
  JAMSIL_ELS_PUBLIC_PRICE_YEARS,
  MOLIT_PUBLIC_PRICE_DATASET,
  MOLIT_PUBLIC_PRICE_SOURCE,
  areaMatchesFixture,
  normalizeDongHoToken,
  resolveJamsilElsSourceLink,
  type PublicPriceFixtureUnit,
} from "@/lib/calculator/fixtures/jamsil-els-public-price";

export type PublicPriceGranularity =
  | "complex"
  | "area"
  | "dong_ho"
  | "unknown";

export type PublicPriceLookupStatus =
  | "linked"
  | "partial"
  | "unavailable"
  | "unverified";

export type PublicPriceMatchType =
  | "UNIT_EXACT"
  | "AREA_AGGREGATE"
  | "NOT_FOUND"
  | "YEAR_NOT_AVAILABLE"
  | "SOURCE_LINK_MISSING";

export type PublicPriceYearPoint = {
  year: number;
  /** 만원. null when not available. */
  priceMan: number | null;
  kind: "official" | "estimate";
  note?: string;
};

export type ComplexPublicPriceResult = {
  status: PublicPriceLookupStatus;
  autoLink: "PASS" | "PARTIAL" | "HOLD";
  officialSource: string | null;
  accessMethod: string | null;
  licenseNote: string;
  granularity: PublicPriceGranularity;
  complexId: string | null;
  areaKey: string | null;
  /** Representative or range — only when status is linked/partial. */
  priceMan: number | null;
  priceMinMan: number | null;
  priceMaxMan: number | null;
  priceMeaning: string | null;
  years: PublicPriceYearPoint[];
  unitLinkage: boolean;
  blocker: string | null;
  source: typeof MOLIT_PUBLIC_PRICE_SOURCE | null;
  dataset: typeof MOLIT_PUBLIC_PRICE_DATASET | null;
  matchType: PublicPriceMatchType;
  requestYear: number;
  /** Calendar year of the official price actually returned. */
  priceBaseYear: number | null;
  officialPriceDate: string | null;
  dong: string | null;
  ho: string | null;
  dongRaw: string | null;
  hoRaw: string | null;
  exclusiveArea: number | null;
  officialPriceWon: number | null;
  buildingRegisterPk: string | null;
  /** True when request year has no bulk yet but a prior bulk year was used. */
  usedPriorBulkYear: boolean;
};

export type ComplexPublicPriceQuery = {
  complexId?: string | null;
  complexName?: string | null;
  areaKey?: string | null;
  exclusiveAreaMinSqm?: number | null;
  exclusiveAreaMaxSqm?: number | null;
  exclusiveAreaSqm?: number | null;
  year?: number;
  dong?: string | null;
  ho?: string | null;
};

const LICENSE_NOTE =
  "국토교통부·한국부동산원 공식 공동주택 공시가격(공공데이터포털 dataset 3073746 bulk)만 사용. 경쟁 서비스·실거래 비율 추정·비공식 스크래핑 금지.";

function emptyPilotFields(requestYear: number): Pick<
  ComplexPublicPriceResult,
  | "source"
  | "dataset"
  | "requestYear"
  | "priceBaseYear"
  | "officialPriceDate"
  | "dong"
  | "ho"
  | "dongRaw"
  | "hoRaw"
  | "exclusiveArea"
  | "officialPriceWon"
  | "buildingRegisterPk"
  | "usedPriorBulkYear"
> {
  return {
    source: null,
    dataset: null,
    requestYear,
    priceBaseYear: null,
    officialPriceDate: null,
    dong: null,
    ho: null,
    dongRaw: null,
    hoRaw: null,
    exclusiveArea: null,
    officialPriceWon: null,
    buildingRegisterPk: null,
    usedPriorBulkYear: false,
  };
}

function unitToResult(
  query: ComplexPublicPriceQuery,
  requestYear: number,
  linkComplexId: string,
  unit: PublicPriceFixtureUnit,
  usedPriorBulkYear: boolean,
): ComplexPublicPriceResult {
  const priceMan = Math.round(unit.officialPriceWon / 10_000);
  return {
    status: "linked",
    autoLink: "PASS",
    officialSource: "국토교통부·한국부동산원 공동주택 공시가격",
    accessMethod: "MOLIT bulk ZIP/CSV fixture (dataset 3073746)",
    licenseNote: LICENSE_NOTE,
    granularity: "dong_ho",
    complexId: linkComplexId,
    areaKey: query.areaKey ?? null,
    priceMan,
    priceMinMan: priceMan,
    priceMaxMan: priceMan,
    priceMeaning: usedPriorBulkYear
      ? `${unit.officialPriceDate} 공식 공시가격(요청 연도 ${requestYear} bulk 미공개 · 최신 bulk ${unit.year} 사용)`
      : `${unit.officialPriceDate} 공식 공시가격`,
    years: [
      {
        year: unit.year,
        priceMan,
        kind: "official",
        note: `${unit.officialPriceDate} bulk actual`,
      },
    ],
    unitLinkage: true,
    blocker: null,
    source: MOLIT_PUBLIC_PRICE_SOURCE,
    dataset: MOLIT_PUBLIC_PRICE_DATASET,
    matchType: "UNIT_EXACT",
    requestYear,
    priceBaseYear: unit.year,
    officialPriceDate: unit.officialPriceDate,
    dong: unit.dongNorm,
    ho: unit.hoNorm,
    dongRaw: unit.dongRaw,
    hoRaw: unit.hoRaw,
    exclusiveArea: unit.exclusiveArea,
    officialPriceWon: unit.officialPriceWon,
    buildingRegisterPk: unit.buildingRegisterPk,
    usedPriorBulkYear,
  };
}

function pickFixtureUnit(
  year: number,
  query: ComplexPublicPriceQuery,
): PublicPriceFixtureUnit | null {
  const unit = JAMSIL_ELS_PUBLIC_PRICE_YEARS[year];
  if (!unit) return null;
  if (
    !areaMatchesFixture(
      unit.exclusiveArea,
      query.exclusiveAreaMinSqm,
      query.exclusiveAreaMaxSqm,
      query.exclusiveAreaSqm,
    )
  ) {
    return null;
  }
  const dongNorm = normalizeDongHoToken(query.dong);
  const hoNorm = normalizeDongHoToken(query.ho);
  // Single-fixture pilot: omitted dong/ho still resolves the prepared exact unit
  // when area matches. Provided values must match. Never invent other units.
  if (dongNorm || hoNorm) {
    if (dongNorm !== unit.dongNorm || hoNorm !== unit.hoNorm) return null;
  }
  return unit;
}

/**
 * Resolve official public housing prices for a complex/area/unit.
 * Pilot: 잠실엘스 UNIT_EXACT from official bulk fixture only.
 */
export function getComplexPublicPrices(
  query: ComplexPublicPriceQuery,
): ComplexPublicPriceResult {
  const requestYear = query.year ?? new Date().getFullYear();
  const link = resolveJamsilElsSourceLink(query);

  if (!link) {
    return {
      status: "unavailable",
      autoLink: "HOLD",
      officialSource: null,
      accessMethod: null,
      licenseNote: LICENSE_NOTE,
      granularity: "unknown",
      complexId: query.complexId ?? null,
      areaKey: query.areaKey ?? null,
      priceMan: null,
      priceMinMan: null,
      priceMaxMan: null,
      priceMeaning: null,
      years: [],
      unitLinkage: false,
      blocker:
        "이 단지는 공시가격 공식 source-link 파일럿 대상이 아닙니다. 직접 입력하세요.",
      matchType: "SOURCE_LINK_MISSING",
      ...emptyPilotFields(requestYear),
    };
  }

  const hasAreaContext =
    query.exclusiveAreaSqm != null ||
    query.exclusiveAreaMinSqm != null ||
    query.exclusiveAreaMaxSqm != null;

  if (!hasAreaContext) {
    return {
      status: "unavailable",
      autoLink: "HOLD",
      officialSource: "국토교통부·한국부동산원 공동주택 공시가격",
      accessMethod: "MOLIT bulk ZIP/CSV fixture (dataset 3073746)",
      licenseNote: LICENSE_NOTE,
      granularity: "dong_ho",
      complexId: link.complexId,
      areaKey: query.areaKey ?? null,
      priceMan: null,
      priceMinMan: null,
      priceMaxMan: null,
      priceMeaning: null,
      years: [],
      unitLinkage: false,
      blocker:
        "면적 조건이 없어 UNIT_EXACT 공시가격을 확정할 수 없습니다. 면적을 선택하거나 직접 입력하세요.",
      matchType: "NOT_FOUND",
      ...emptyPilotFields(requestYear),
      source: MOLIT_PUBLIC_PRICE_SOURCE,
      dataset: MOLIT_PUBLIC_PRICE_DATASET,
    };
  }

  const direct = pickFixtureUnit(requestYear, query);
  if (direct) {
    return unitToResult(query, requestYear, link.complexId, direct, false);
  }

  if (requestYear > JAMSIL_ELS_LATEST_BULK_YEAR) {
    const prior = pickFixtureUnit(JAMSIL_ELS_LATEST_BULK_YEAR, query);
    if (prior) {
      return unitToResult(query, requestYear, link.complexId, prior, true);
    }
    return {
      status: "unavailable",
      autoLink: "HOLD",
      officialSource: "국토교통부·한국부동산원 공동주택 공시가격",
      accessMethod: "MOLIT bulk ZIP/CSV fixture (dataset 3073746)",
      licenseNote: LICENSE_NOTE,
      granularity: "dong_ho",
      complexId: link.complexId,
      areaKey: query.areaKey ?? null,
      priceMan: null,
      priceMinMan: null,
      priceMaxMan: null,
      priceMeaning: null,
      years: [],
      unitLinkage: false,
      blocker: `${requestYear}년 공식 bulk 공시가격은 아직 공개되지 않았습니다. 직접 입력하세요.`,
      matchType: "YEAR_NOT_AVAILABLE",
      ...emptyPilotFields(requestYear),
      source: MOLIT_PUBLIC_PRICE_SOURCE,
      dataset: MOLIT_PUBLIC_PRICE_DATASET,
    };
  }

  return {
    status: "unavailable",
    autoLink: "HOLD",
    officialSource: "국토교통부·한국부동산원 공동주택 공시가격",
    accessMethod: "MOLIT bulk ZIP/CSV fixture (dataset 3073746)",
    licenseNote: LICENSE_NOTE,
    granularity: "dong_ho",
    complexId: link.complexId,
    areaKey: query.areaKey ?? null,
    priceMan: null,
    priceMinMan: null,
    priceMaxMan: null,
    priceMeaning: null,
    years: [],
    unitLinkage: false,
    blocker:
      "선택한 면적·동·호에 대한 파일럿 공시가격 fixture가 없습니다. 직접 입력하세요. (평형 집계는 전체 unit bulk 확보 후 제공)",
    matchType: "NOT_FOUND",
    ...emptyPilotFields(requestYear),
    source: MOLIT_PUBLIC_PRICE_SOURCE,
    dataset: MOLIT_PUBLIC_PRICE_DATASET,
  };
}

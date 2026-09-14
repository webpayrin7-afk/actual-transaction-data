/**
 * Complex public-price (공동주택 공시가격) adapter boundary.
 *
 * Phase 1.4 audit result: no approved, wired official source exists in this
 * repo/env for automatic complex→area/unit public-price linkage.
 * Do not invent prices from transaction ratios.
 */

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
};

export type ComplexPublicPriceQuery = {
  complexId?: string | null;
  complexName?: string | null;
  areaKey?: string | null;
  exclusiveAreaMinSqm?: number | null;
  exclusiveAreaMaxSqm?: number | null;
  year?: number;
};

/**
 * Resolve official public housing prices for a complex/area.
 * Currently returns HOLD — no safe auto-link source is configured.
 */
export function getComplexPublicPrices(
  query: ComplexPublicPriceQuery,
): ComplexPublicPriceResult {
  void query;
  return {
    status: "unavailable",
    autoLink: "HOLD",
    officialSource: null,
    accessMethod: null,
    licenseNote:
      "국토교통부·한국부동산원·부동산공시가격알리미 등 공식 출처만 허용. 경쟁 서비스·실거래 비율 추정 금지.",
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
      "repo/env에 공동주택 공시가격 공식 API·DB·승인 설정이 없어 단지·평형 자동연결을 보류합니다.",
  };
}

/**
 * Presentation helpers for published ranking APIs.
 * Does not score, recompute ranks, or invent public metrics.
 */
import { AREA_BANDS_V1, inAreaBand } from "@/lib/region-ranking/area-band";
import { formatDealDate } from "@/lib/utils/format";
import { aptDetailHref } from "@/lib/molit/apt-client";

export const RANKING_TYPES = [
  "COMPOSITE",
  "TRADE_VOLUME",
  "PRICE_PER_SQM",
] as const;
export type RankingType = (typeof RANKING_TYPES)[number];
export type AreaRankingBand = "59" | "84" | "114";

export const RANKING_TABS: ReadonlyArray<{
  id: RankingType;
  label: string;
  hint: string;
}> = [
  {
    id: "COMPOSITE",
    label: "종합",
    hint: "가격 경쟁력, 거래활성도, 단지 규모, 시장 안정성과 최근 흐름 등을 종합해 비교합니다.",
  },
  {
    id: "TRADE_VOLUME",
    label: "거래량",
    hint: "최근 3개월 실거래 매매 건수 기준",
  },
  {
    id: "PRICE_PER_SQM",
    label: "㎡당 가격",
    hint: "최근 3개월 매매 실거래의 ㎡당 가격 중위값 기준",
  },
];

export type RegionRankingCoverage = {
  expected_bands: unknown;
  valid_bands: unknown;
  expected_band_count: unknown;
  valid_band_count: unknown;
  coverage_completeness: unknown;
  coverage_status: unknown;
  single_product_band: boolean;
};

export type RegionRankingPublicMetrics = {
  median_price_per_sqm: unknown;
  median_deal_amount: unknown;
  trade_count: unknown;
  latest_deal_date: unknown;
};

export type RegionRankingRow = {
  rank: number;
  complex_id: string;
  apt_name: string | null;
  dong: string | null;
  confidence?: string | null;
  coverage?: RegionRankingCoverage | null;
  public_metrics?: RegionRankingPublicMetrics | null;
  trade_count_3m?: unknown;
  latest_deal_date?: unknown;
  median_price_per_sqm_3m?: unknown;
};

export type RegionRankingBoard = {
  status: "ok" | "unavailable";
  rankingType: string;
  regionCode: string;
  transactionAsOf: string | null;
  rankingVersion: string | null;
  regionTotal: number | null;
  smallCohort?: boolean;
  rows: RegionRankingRow[];
};

export type RegionRankingBoards = Record<RankingType, RegionRankingBoard | null>;

export type ComplexRankPlace = {
  status: "ranked" | "unavailable";
  rank: number | null;
  total: number | null;
  confidence: string | null;
  coverage: RegionRankingCoverage | null;
  transactionAsOf: string | null;
  rankingVersion: string | null;
  smallCohort: boolean;
};

export type ComplexRegionRankResponse = {
  status: "ok" | "unavailable";
  complex_id: string;
  apt_name: string | null;
  dong: string | null;
  transactionAsOf: string | null;
  rankingVersion: string | null;
  all: { gu: ComplexRankPlace; dong: ComplexRankPlace } | null;
  area: {
    rankingType: string;
    gu: ComplexRankPlace;
    dong: ComplexRankPlace;
  } | null;
};

export class RankingRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RankingRequestError";
  }
}

function asBoard(raw: unknown, fallbackType: RankingType, regionCode: string): RegionRankingBoard {
  if (!raw || typeof raw !== "object") {
    return {
      status: "unavailable",
      rankingType: fallbackType,
      regionCode,
      transactionAsOf: null,
      rankingVersion: null,
      regionTotal: null,
      rows: [],
    };
  }
  const data = raw as Partial<RegionRankingBoard>;
  if (data.status === "ok") {
    return {
      status: "ok",
      rankingType: String(data.rankingType ?? fallbackType),
      regionCode: String(data.regionCode ?? regionCode),
      transactionAsOf: data.transactionAsOf ?? null,
      rankingVersion: data.rankingVersion ?? null,
      regionTotal: data.regionTotal ?? null,
      smallCohort: data.smallCohort === true,
      rows: Array.isArray(data.rows) ? data.rows : [],
    };
  }
  return {
    status: "unavailable",
    rankingType: String(data.rankingType ?? fallbackType),
    regionCode: String(data.regionCode ?? regionCode),
    transactionAsOf: data.transactionAsOf ?? null,
    rankingVersion: data.rankingVersion ?? null,
    regionTotal: null,
    rows: [],
  };
}

export async function fetchRegionRankingBoard(params: {
  regionCode: string;
  rankingType: RankingType;
  limit?: number;
}): Promise<RegionRankingBoard> {
  const qs = new URLSearchParams({
    region_code: params.regionCode,
    ranking_type: params.rankingType,
    limit: String(params.limit ?? 10),
  });
  const res = await fetch(`/api/region-ranking?${qs.toString()}`);
  if (!res.ok) {
    throw new RankingRequestError("지역 순위를 불러오지 못했습니다.");
  }
  return asBoard(await res.json(), params.rankingType, params.regionCode);
}

export async function fetchRegionRankingBoards(
  regionCode: string,
  limit = 10,
): Promise<RegionRankingBoards> {
  const entries = await Promise.all(
    RANKING_TYPES.map(async (rankingType) => {
      const board = await fetchRegionRankingBoard({
        regionCode,
        rankingType,
        limit,
      });
      return [rankingType, board] as const;
    }),
  );
  return {
    COMPOSITE: entries.find(([k]) => k === "COMPOSITE")?.[1] ?? null,
    TRADE_VOLUME: entries.find(([k]) => k === "TRADE_VOLUME")?.[1] ?? null,
    PRICE_PER_SQM: entries.find(([k]) => k === "PRICE_PER_SQM")?.[1] ?? null,
  };
}

export async function fetchComplexRegionRank(params: {
  complexId: string;
  areaBand?: AreaRankingBand | null;
}): Promise<ComplexRegionRankResponse> {
  const qs = new URLSearchParams({ complex_id: params.complexId });
  if (params.areaBand) qs.set("area_band", params.areaBand);
  const res = await fetch(`/api/complex-region-rank?${qs.toString()}`);
  if (!res.ok) {
    throw new RankingRequestError("단지 순위를 불러오지 못했습니다.");
  }
  return (await res.json()) as ComplexRegionRankResponse;
}

export function regionRankingCode(lawdCodes: string[] | undefined): string | null {
  const code = lawdCodes?.[0]?.trim() ?? "";
  return /^[0-9]{5}$/.test(code) ? code : null;
}

export function rankingBandForExclusiveRange(
  min: number,
  max: number,
): AreaRankingBand | null {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  for (const id of ["59", "84", "114"] as const) {
    const band = AREA_BANDS_V1.find((row) => row.id === id);
    if (!band) continue;
    if (inAreaBand(min, band) && inAreaBand(max, band)) return id;
  }
  return null;
}

export function rankingBandForArea(area: {
  exclusiveArea: number;
  exclusiveAreaMin?: number | null;
  exclusiveAreaMax?: number | null;
} | null): AreaRankingBand | null {
  if (!area) return null;
  const min = area.exclusiveAreaMin ?? area.exclusiveArea;
  const max = area.exclusiveAreaMax ?? area.exclusiveArea;
  return rankingBandForExclusiveRange(min, max);
}

export function rankingComplexHref(params: {
  aptName: string | null | undefined;
  regionSlug: string;
  gu?: string;
}): string | null {
  const name = params.aptName?.trim();
  if (!name) return null;
  return aptDetailHref(name, params.regionSlug, params.gu);
}

export function regionRankingHref(regionSlug: string): string {
  return `/region/${regionSlug}?tab=stats`;
}

export function formatRankingAsOf(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  const value = raw.trim();
  const iso = value.length >= 10 ? value.slice(0, 10) : value;
  const dotted = formatDealDate(iso.includes("-") ? iso : iso);
  if (!dotted) return null;
  return `${dotted} 기준`;
}

function finiteNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t ? t : null;
}

function bandLabels(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value.map((item) => String(item))
    : typeof value === "string"
      ? value.split(/[,\s]+/)
      : [];
  const order = ["59", "84", "114"] as const;
  const found = new Set(
    raw.map((item) => item.trim()).filter((item) => item === "59" || item === "84" || item === "114"),
  );
  return order.filter((id) => found.has(id)).map((id) => `${id}㎡`);
}

export function coverageCopy(coverage: RegionRankingCoverage | null | undefined): string | null {
  if (!coverage) return null;
  if (coverage.single_product_band) return "한 면적대 단지";
  const valid = bandLabels(coverage.valid_bands);
  if (valid.length > 0) return `${valid.join(" · ")} 기준`;
  const status = asString(coverage.coverage_status);
  if (status === "COMPLETE_PRODUCT_COVERAGE") return "주요 면적대 순위 확보";
  if (status === "PARTIAL_PRODUCT_COVERAGE") return "일부 면적대 순위";
  if (status === "EXPECTED_BAND_UNKNOWN") return "면적대 정보 확인 중";
  return null;
}

export function confidenceCopy(raw: string | null | undefined): string | null {
  const v = raw?.trim().toUpperCase();
  if (!v) return null;
  if (v === "HIGH") return "자료 충분";
  if (v === "MEDIUM") return "자료 보통";
  if (v === "LOW") return "자료 제한";
  return null;
}

export type RankingRowMetrics = {
  primary: string | null;
  secondary: string | null;
  hint: string | null;
};

export function formatWonPerSqm(value: unknown): string | null {
  const n = finiteNumber(value);
  if (n == null || n <= 0) return null;
  return `${Math.round(n).toLocaleString("ko-KR")}만원/㎡`;
}

/** Display-only 평당가. Does not convert or invent the source number. */
export function formatWonPerPyeong(value: unknown): string | null {
  const n = finiteNumber(value);
  if (n == null || n <= 0) return null;
  const eok = Math.floor(n / 10000);
  const rest = Math.round(n % 10000);
  if (eok >= 1) {
    if (rest === 0) return `${eok}억/평`;
    return `${eok}억 ${rest.toLocaleString("ko-KR")}만원/평`;
  }
  return `${Math.round(n).toLocaleString("ko-KR")}만원/평`;
}

export function formatSignedPct(value: unknown): string | null {
  const n = finiteNumber(value);
  if (n == null) return null;
  const rounded = Math.round(n * 100) / 100;
  const abs = Math.abs(rounded);
  const text = Number.isInteger(abs)
    ? String(Math.abs(rounded))
    : abs.toFixed(2).replace(/0$/, "").replace(/\.$/, "");
  if (rounded > 0) return `+${text}%`;
  if (rounded < 0) return `-${text}%`;
  return "0%";
}

export function formatReferenceMonthLabel(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  const match = /^(\d{4})-(\d{2})/.exec(raw.trim());
  if (!match) return null;
  return `${match[1]}년 ${Number(match[2])}월 기준`;
}

export function formatTradeCount(value: unknown, prefix = ""): string | null {
  const n = finiteNumber(value);
  if (n == null || n <= 0) return null;
  return `${prefix}${Math.round(n).toLocaleString("ko-KR")}건`;
}

export function latestDealLabel(value: unknown): string | null {
  const raw = asString(value);
  if (!raw) return null;
  const iso = raw.length >= 10 ? raw.slice(0, 10) : raw;
  const dotted = formatDealDate(iso.includes("-") ? iso : iso);
  return dotted || null;
}

export function priceLevelScale(
  cells: ReadonlyArray<{ status: string; value: number | null }>,
): number | null {
  const values = cells
    .filter((cell) => cell.status === "ok" && cell.value != null && cell.value > 0)
    .map((cell) => cell.value as number);
  return values.length > 0 ? Math.max(...values) : null;
}

export function barWidthPct(value: number | null, max: number | null): number {
  if (value == null || max == null || !(max > 0) || !(value > 0)) return 0;
  return Math.min(100, (value / max) * 100);
}

export function trendAbsScale(
  cells: ReadonlyArray<{ status: string; changePercent: number | null }>,
  apiMax?: number | null,
): number | null {
  if (apiMax != null && Number.isFinite(apiMax) && apiMax > 0) return apiMax;
  const values = cells
    .filter((cell) => cell.status === "ok" && cell.changePercent != null)
    .map((cell) => Math.abs(cell.changePercent as number));
  return values.length > 0 ? Math.max(...values) : null;
}

export function trendBarLayout(
  value: number | null,
  maxAbs: number | null,
): { side: "left" | "right" | "none"; pct: number } {
  if (value == null || maxAbs == null || !(maxAbs > 0)) {
    return { side: "none", pct: 0 };
  }
  const pct = Math.min(100, (Math.abs(value) / maxAbs) * 100);
  if (value < 0) return { side: "left", pct };
  if (value > 0) return { side: "right", pct };
  return { side: "none", pct: 0 };
}

export function rowPublicMetrics(
  type: RankingType,
  row: RegionRankingRow,
): RankingRowMetrics {
  if (type === "COMPOSITE") {
    const hint = [
      coverageCopy(row.coverage),
      confidenceCopy(row.confidence),
    ]
      .filter(Boolean)
      .join(" · ");
    return {
      primary: null,
      secondary: null,
      hint: hint || null,
    };
  }
  if (type === "TRADE_VOLUME") {
    const count = row.trade_count_3m ?? row.public_metrics?.trade_count;
    const latest = row.latest_deal_date ?? row.public_metrics?.latest_deal_date;
    return {
      primary: formatTradeCount(count),
      secondary: latestDealLabel(latest),
      hint: null,
    };
  }
  const perSqm = row.median_price_per_sqm_3m ?? row.public_metrics?.median_price_per_sqm;
  const count = row.trade_count_3m ?? row.public_metrics?.trade_count;
  return {
    primary: formatWonPerSqm(perSqm),
    secondary: formatTradeCount(count, "거래 "),
    hint: null,
  };
}

export function placeHeadline(params: {
  regionName: string;
  place: ComplexRankPlace | null | undefined;
}): { title: string; meta: string | null } | null {
  const place = params.place;
  if (!place || place.status !== "ranked" || place.rank == null) return null;
  const total = place.total;
  const title = `${params.regionName} ${place.rank}위`;
  return {
    title,
    meta:
      !place.smallCohort && total != null && total > 0
        ? `${total.toLocaleString("ko-KR")}개 단지 중`
        : null,
  };
}

/** One card-level note. Never repeat per ranking row. */
export function dongSmallCohortHelper(params: {
  dongName: string;
  places: Array<ComplexRankPlace | null | undefined>;
}): string | null {
  const name = params.dongName.trim();
  if (!name) return null;
  const hit = params.places.find(
    (place) =>
      place?.status === "ranked" &&
      place.smallCohort === true &&
      place.total != null &&
      place.total > 0,
  );
  if (!hit || hit.total == null) return null;
  return `${name} 순위 · 비교 가능한 ${hit.total.toLocaleString("ko-KR")}개 단지 기준`;
}

export const RANK_PREPARING_COPY = "지역 비교 데이터를 준비 중이에요.";
export const RANK_SMALL_REGION_COPY =
  "이 지역은 비교 가능한 아파트 단지가 적어 순위를 제공하지 않아요.";
export const PRICE_COMPARE_UNSUPPORTED_COPY =
  "이 면적대는 지역 가격 비교를 제공하지 않아요.";
export const INSUFFICIENT_SAMPLE_COPY = "표본 부족";
export const PRICE_POSITION_V2_VERSION = "price-position-v2";
export const LABEL_AMBIGUOUS_COPY = "이 면적은 평형 라벨이 여러 개라 비교하지 않아요.";

export function unavailableBoardCopy(_type?: RankingType): {
  title: string;
  helper: string;
} {
  return {
    title: RANK_PREPARING_COPY,
    helper: "충분한 거래·단지 데이터가 확보되면 제공됩니다.",
  };
}

export function regionOverviewCtaLabel(regionName: string): string {
  return `${regionName} 지역현황 보기`;
}

export const PRICE_COMPARE_TABS = [
  { id: "level", label: "가격 수준" },
  { id: "trend", label: "변동률" },
] as const;
export type PriceCompareTab = (typeof PRICE_COMPARE_TABS)[number]["id"];

export const TREND_PERIOD_TABS = [
  { id: "3M", label: "3개월" },
  { id: "6M", label: "6개월" },
  { id: "1Y", label: "1년" },
  { id: "3Y", label: "3년" },
] as const;
export type TrendPeriodId = (typeof TREND_PERIOD_TABS)[number]["id"];

export const PRICE_LEVEL_TIP =
  "선택한 평형과 같은 평형대의 최근 실거래 기준 평당가를 비교합니다. 평당가는 공급면적 기준 평형으로 계산합니다.";
export const TREND_TIP =
  "선택한 평형대에서 두 비교시점 모두 거래가 확인된 단지들의 실거래 가격 변화를 비교합니다. 지역 값은 같은 평형대에서 맞춰진 단지 기준입니다.";

export type PriceCompareStatus =
  | "ok"
  | "INSUFFICIENT_SAMPLE"
  | "PRICE_COMPARE_UNSUPPORTED_AREA"
  | "LABEL_AMBIGUOUS"
  | "unavailable";

export type PriceLevelPublicCell = {
  scope: "COMPLEX" | "DONG" | "GU" | "SEOUL";
  label: string;
  meanPricePerSupplyPyeong: number | null;
  tradeCount: number | null;
  status: "ok" | "INSUFFICIENT_SAMPLE";
};

export type TrendPublicCell = {
  scope: "COMPLEX" | "DONG" | "GU" | "SEOUL";
  label: string;
  changePercent: number | null;
  status: "ok" | "INSUFFICIENT_SAMPLE";
};

export type ComplexPricePositionResponse = {
  status: PriceCompareStatus;
  version: string | null;
  complexId: string;
  aptName: string | null;
  areaBand: string | null;
  supplyPyeongCohort: string | null;
  transactionAsOf: string | null;
  referenceMonth: string | null;
  areaBasis: string | null;
  priceLevel: PriceLevelPublicCell[];
  trends: Record<TrendPeriodId, TrendPublicCell[]>;
  maxAvailableValue: {
    priceLevel: number | null;
    trends: Record<TrendPeriodId, number | null>;
  };
};

function asPriceCells(raw: unknown): PriceLevelPublicCell[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const row = item as Partial<PriceLevelPublicCell>;
      const scope = row.scope;
      if (scope !== "COMPLEX" && scope !== "DONG" && scope !== "GU" && scope !== "SEOUL") {
        return null;
      }
      const raw = item as Record<string, unknown>;
      return {
        scope,
        label: asString(row.label) ?? scope,
        meanPricePerSupplyPyeong: finiteNumber(raw.meanPricePerSupplyPyeong),
        tradeCount: finiteNumber(row.tradeCount),
        status: row.status === "INSUFFICIENT_SAMPLE" ? "INSUFFICIENT_SAMPLE" : "ok",
      };
    })
    .filter((row): row is PriceLevelPublicCell => row != null);
}

function asTrendCells(raw: unknown): TrendPublicCell[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const row = item as Partial<TrendPublicCell>;
      const scope = row.scope;
      if (scope !== "COMPLEX" && scope !== "DONG" && scope !== "GU" && scope !== "SEOUL") {
        return null;
      }
      return {
        scope,
        label: asString(row.label) ?? scope,
        changePercent: finiteNumber(row.changePercent),
        status: row.status === "INSUFFICIENT_SAMPLE" ? "INSUFFICIENT_SAMPLE" : "ok",
      };
    })
    .filter((row): row is TrendPublicCell => row != null);
}

function emptyPricePosition(
  complexId: string,
  status: PriceCompareStatus,
): ComplexPricePositionResponse {
  return {
    status,
    version: null,
    complexId,
    aptName: null,
    areaBand: null,
    supplyPyeongCohort: null,
    transactionAsOf: null,
    referenceMonth: null,
    areaBasis: null,
    priceLevel: [],
    trends: { "3M": [], "6M": [], "1Y": [], "3Y": [] },
    maxAvailableValue: {
      priceLevel: null,
      trends: { "3M": null, "6M": null, "1Y": null, "3Y": null },
    },
  };
}

export function isPricePositionV2(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  return asString((raw as Record<string, unknown>).version) === PRICE_POSITION_V2_VERSION;
}

export function parseComplexPricePosition(
  raw: unknown,
  complexId: string,
): ComplexPricePositionResponse {
  return asPricePosition(raw, complexId);
}

function asPricePosition(raw: unknown, complexId: string): ComplexPricePositionResponse {
  const data = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const version = asString(data.version);
  const statusRaw = asString(data.status);
  const status: PriceCompareStatus =
    statusRaw === "ok" ||
    statusRaw === "INSUFFICIENT_SAMPLE" ||
    statusRaw === "PRICE_COMPARE_UNSUPPORTED_AREA" ||
    statusRaw === "LABEL_AMBIGUOUS" ||
    statusRaw === "unavailable"
      ? statusRaw
      : "unavailable";
  if (version !== PRICE_POSITION_V2_VERSION) {
    return emptyPricePosition(complexId, status === "PRICE_COMPARE_UNSUPPORTED_AREA" ? status : "unavailable");
  }
  const trendsRaw = data.trends && typeof data.trends === "object"
    ? (data.trends as Record<string, unknown>)
    : {};
  const maxRaw = data.maxAvailableValue && typeof data.maxAvailableValue === "object"
    ? (data.maxAvailableValue as Record<string, unknown>)
    : {};
  const trendMaxRaw = maxRaw.trends && typeof maxRaw.trends === "object"
    ? (maxRaw.trends as Record<string, unknown>)
    : {};
  return {
    status,
    version,
    complexId: asString(data.complexId) ?? complexId,
    aptName: asString(data.aptName),
    areaBand: asString(data.areaBand),
    supplyPyeongCohort: asString(data.supplyPyeongCohort),
    transactionAsOf: asString(data.transactionAsOf),
    referenceMonth: asString(data.referenceMonth),
    areaBasis: asString(data.areaBasis),
    priceLevel: asPriceCells(data.priceLevel),
    trends: {
      "3M": asTrendCells(trendsRaw["3M"]),
      "6M": asTrendCells(trendsRaw["6M"]),
      "1Y": asTrendCells(trendsRaw["1Y"]),
      "3Y": asTrendCells(trendsRaw["3Y"]),
    },
    maxAvailableValue: {
      priceLevel: finiteNumber(maxRaw.priceLevel),
      trends: {
        "3M": finiteNumber(trendMaxRaw["3M"]),
        "6M": finiteNumber(trendMaxRaw["6M"]),
        "1Y": finiteNumber(trendMaxRaw["1Y"]),
        "3Y": finiteNumber(trendMaxRaw["3Y"]),
      },
    },
  };
}

export async function fetchComplexPricePosition(params: {
  complexId: string;
  exclusiveArea: number;
}): Promise<ComplexPricePositionResponse> {
  const qs = new URLSearchParams({
    complex_id: params.complexId,
    exclusive_area: String(params.exclusiveArea),
  });
  const res = await fetch(`/api/complex-region-price-position?${qs.toString()}`);
  if (!res.ok) {
    throw new RankingRequestError("지역 가격 비교를 불러오지 못했습니다.");
  }
  return asPricePosition(await res.json(), params.complexId);
}

export function priceCompareStatusCopy(status: PriceCompareStatus | string | null | undefined): {
  title: string;
  helper?: string;
} {
  if (status === "PRICE_COMPARE_UNSUPPORTED_AREA") {
    return { title: PRICE_COMPARE_UNSUPPORTED_COPY };
  }
  if (status === "LABEL_AMBIGUOUS") {
    return { title: LABEL_AMBIGUOUS_COPY };
  }
  if (status === "INSUFFICIENT_SAMPLE") {
    return { title: INSUFFICIENT_SAMPLE_COPY };
  }
  return { title: RANK_PREPARING_COPY };
}

export function formatReferenceMonthShort(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  const match = /^(\d{4})-(\d{2})/.exec(raw.trim());
  if (!match) return null;
  return `${match[1]}년 ${Number(match[2])}월`;
}

export function supplyCohortCompareLabel(cohort: string | null | undefined): string | null {
  const value = cohort?.trim();
  if (!value) return null;
  if (value.endsWith("비교")) return value;
  return `${value} 비교`;
}

/** Selected exact 평 + API cohort. Never invents 45평대 from 45평. */
export function selectedPyeongCompareLines(params: {
  selectedPyeongLabel: string | null;
  supplyPyeongCohort: string | null;
  referenceMonth: string | null;
}): { line1: string | null; line2: string | null } {
  const selected = params.selectedPyeongLabel?.trim() || null;
  const cohort = supplyCohortCompareLabel(params.supplyPyeongCohort);
  const month = formatReferenceMonthLabel(params.referenceMonth);
  const monthShort = formatReferenceMonthShort(params.referenceMonth);
  if (selected && cohort) {
    return { line1: `${selected} · ${cohort}`, line2: month };
  }
  if (selected) {
    return { line1: [selected, monthShort].filter(Boolean).join(" · ") || selected, line2: null };
  }
  if (cohort) return { line1: cohort, line2: month };
  return { line1: month, line2: null };
}

export function rankingSelectedHeading(params: {
  pyeongLabel: string | null;
  rankingBand: AreaRankingBand | null;
}): string | null {
  if (params.pyeongLabel?.trim()) return params.pyeongLabel.trim();
  if (params.rankingBand) return `${params.rankingBand}㎡`;
  return null;
}

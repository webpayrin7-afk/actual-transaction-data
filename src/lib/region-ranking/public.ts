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
  selectedMarketPyeongLabel: number | null;
  regionPyeongDecade: string | null;
  all: { gu: ComplexRankPlace; dong: ComplexRankPlace } | null;
  area: {
    rankingType: string;
    selectedMarketPyeongLabel?: number | null;
    regionPyeongDecade?: string | null;
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
  marketPyeongLabel?: number | null;
  decadeKey?: string | null;
}): Promise<ComplexRegionRankResponse> {
  const qs = new URLSearchParams({ complex_id: params.complexId });
  if (params.marketPyeongLabel != null && params.marketPyeongLabel > 0) {
    qs.set("market_pyeong_label", String(Math.round(params.marketPyeongLabel)));
  } else if (params.decadeKey && /^\d+$/.test(params.decadeKey)) {
    qs.set("area_band", params.decadeKey);
  }
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

/** Display-only 평당가. Always 만원/평 — no 억 conversion. */
export function formatWonPerPyeong(value: unknown): string | null {
  const n = finiteNumber(value);
  if (n == null || n <= 0) return null;
  return `${Math.round(n).toLocaleString("ko-KR")}만원/평`;
}

/**
 * Selector-confirmed market pyeong only.
 * Does not re-round exclusive or supply area.
 */
export function selectedMarketPyeongInteger(params: {
  marketLabel?: number | null;
  selectedPyeongLabel?: string | null;
}): number | null {
  const fromLabel = params.marketLabel;
  if (fromLabel != null && Number.isFinite(fromLabel) && fromLabel > 0) {
    return Math.round(fromLabel);
  }
  const match = /^(\d+)평$/.exec(params.selectedPyeongLabel?.trim() ?? "");
  if (!match) return null;
  const n = Number(match[1]);
  return n > 0 ? n : null;
}

export function parseMarketPyeongLabelParam(raw: string | null | undefined): number | null {
  if (!raw?.trim()) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  const label = Math.round(n);
  return label > 0 ? label : null;
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

export const DECADE_RANK_UNAVAILABLE_COPY = "해당 평형대 순위 없음";

export function placeHeadline(params: {
  regionName: string;
  place: ComplexRankPlace | null | undefined;
}): { title: string; meta: string | null } | null {
  const place = params.place;
  if (!place || place.status !== "ranked" || place.rank == null) return null;
  return {
    title: `${params.regionName} ${place.rank}위`,
    meta: null,
  };
}

/** Region name + rank parts for the compact 2-column card. Never includes population. */
export function placeRankDisplay(params: {
  regionName: string;
  place: ComplexRankPlace | null | undefined;
}): { region: string; rank: number } | null {
  const place = params.place;
  if (!place || place.status !== "ranked" || place.rank == null) return null;
  const region = params.regionName.trim();
  if (!region) return null;
  return { region, rank: place.rank };
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
export const PRICE_POSITION_V21_VERSION = "price-position-v2.1";
export const PRICE_POSITION_V22_VERSION = "price-position-v2.2";
export const PRICE_POSITION_V23_VERSION = "price-position-v2.3";
export const LABEL_AMBIGUOUS_COPY = "이 면적은 평형 라벨이 여러 개라 비교하지 않아요.";

export const TREND_SAMPLE_THIN_COPY = "표본 적음";
export const TREND_SAMPLE_VERY_THIN_COPY = "표본 매우 적음";
export const TREND_SAMPLE_TIP_TITLE = "표본 안내";
export const TREND_SAMPLE_TIP = [
  "해당 기간에 양 시점 모두 거래가 확인된 같은 평형대 단지들을 기준으로 계산합니다.",
  "비교 가능한 단지가 적은 경우 실제 지역 흐름과 차이가 있을 수 있습니다.",
].join("\n\n");

export type TrendSampleStatus = "ADEQUATE" | "THIN" | "VERY_THIN";
export type TrendWindowStatus = "FULL_WINDOW" | "PARTIAL_HISTORY_WINDOW";

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
  return `${regionName} 지역 순위 보기`;
}

export const PRICE_COMPARE_TABS = [
  { id: "level", label: "가격 수준" },
  { id: "trend", label: "변동률" },
] as const;
export type PriceCompareTab = (typeof PRICE_COMPARE_TABS)[number]["id"];

export const TREND_PERIOD_TABS = [
  { id: "6M", label: "6개월" },
  { id: "1Y", label: "1년" },
  { id: "2Y", label: "2년" },
  { id: "5Y", label: "5년" },
] as const;
export type TrendPeriodId = (typeof TREND_PERIOD_TABS)[number]["id"];

export const PRICE_LEVEL_TIP =
  "선택한 평형대의 단지별 실거래 가격을 기준으로 지역 가격 수준을 비교합니다.";
export const TREND_TIP =
  "동일한 단지의 현재와 과거 실거래 가격을 비교해 지역 가격 변화를 계산합니다.";
export const COMPLEX_EXACT_TIP = "이 단지는 선택한 평형만 사용합니다. 지역 값은 같은 평형대 기준입니다.";

export const ZIPLAB_RANK_TITLE = "집랩 순위";
export const ZIPLAB_RANK_TIP_TITLE = "집랩 순위란?";
export const ZIPLAB_RANK_TIP = [
  "실거래 가격, 거래량, 거래 지속성, 가격 흐름, 단지 규모 등을 종합해 같은 지역 내 단지의 상대적인 위치를 나타냅니다.",
  "종합은 단지 전체를, 평형대 순위는 현재 선택한 평형이 속한 평형대를 기준으로 계산합니다.",
].join("\n\n");

export const PRICE_COMPARE_TITLE = "가격 비교";
export const PRICE_COMPARE_TIP_TITLE = "지역 가격 비교란?";
export const PRICE_COMPARE_TIP = [
  "이 단지는 현재 선택한 평형의 실거래 가격을 기준으로 하고, 지역은 같은 평형대 단지들의 실거래 가격을 기준으로 비교합니다.",
  "평당가는 공급면적 기준입니다.",
].join("\n\n");

export type PriceCompareStatus =
  | "ok"
  | "INSUFFICIENT_SAMPLE"
  | "PRICE_COMPARE_UNSUPPORTED_AREA"
  | "LABEL_AMBIGUOUS"
  | "unavailable";

export type PriceCompareCellStatus = "ok" | "INSUFFICIENT_SAMPLE" | "unavailable";

export type PriceLevelPublicCell = {
  scope: "COMPLEX" | "DONG" | "GU" | "SEOUL";
  label: string;
  meanPricePerSupplyPyeong: number | null;
  tradeCount: number | null;
  status: PriceCompareCellStatus;
};

export type TrendPublicCell = {
  scope: "COMPLEX" | "DONG" | "GU" | "SEOUL";
  label: string;
  changePercent: number | null;
  currentMonth: string | null;
  baselineMonth: string | null;
  actualCurrentMonth: string | null;
  actualBaselineMonth: string | null;
  status: PriceCompareCellStatus;
  sampleStatus: TrendSampleStatus | null;
  windowStatus: TrendWindowStatus | null;
  currentWindow: string | null;
  baselineWindow: string | null;
  matchedComplexCount: number | null;
  matchedCoverageRatio: number | null;
};

export type ComplexPricePositionResponse = {
  status: PriceCompareStatus;
  version: string | null;
  complexId: string;
  aptName: string | null;
  areaBand: string | null;
  supplyPyeongCohort: string | null;
  selectedMarketPyeongLabel: number | null;
  complexScopeBasis: string | null;
  transactionAsOf: string | null;
  referenceMonth: string | null;
  areaBasis: string | null;
  methodologyCopy: { price: string | null; trend: string | null };
  priceLevel: PriceLevelPublicCell[];
  trends: Record<TrendPeriodId, TrendPublicCell[]>;
  maxAvailableValue: {
    priceLevel: number | null;
    trends: Record<TrendPeriodId, number | null>;
  };
};

function asCompareCellStatus(value: unknown): PriceCompareCellStatus {
  if (value === "INSUFFICIENT_SAMPLE") return "INSUFFICIENT_SAMPLE";
  if (value === "unavailable") return "unavailable";
  return "ok";
}

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
        status: asCompareCellStatus(row.status),
      };
    })
    .filter((row): row is PriceLevelPublicCell => row != null);
}

function asSampleStatus(value: unknown): TrendSampleStatus | null {
  if (value === "ADEQUATE" || value === "THIN" || value === "VERY_THIN") return value;
  return null;
}

function asWindowStatus(value: unknown): TrendWindowStatus | null {
  if (value === "FULL_WINDOW" || value === "PARTIAL_HISTORY_WINDOW") return value;
  return null;
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
      const rec = item as Record<string, unknown>;
      return {
        scope,
        label: asString(row.label) ?? scope,
        changePercent: finiteNumber(row.changePercent),
        currentMonth: asString(rec.currentMonth),
        baselineMonth: asString(rec.baselineMonth),
        actualCurrentMonth: asString(rec.actualCurrentMonth),
        actualBaselineMonth: asString(rec.actualBaselineMonth),
        status: asCompareCellStatus(row.status),
        sampleStatus: asSampleStatus(rec.sampleStatus),
        windowStatus: asWindowStatus(rec.windowStatus),
        currentWindow: asString(rec.currentWindow),
        baselineWindow: asString(rec.baselineWindow),
        matchedComplexCount: finiteNumber(rec.matchedComplexCount),
        matchedCoverageRatio: finiteNumber(rec.matchedCoverageRatio),
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
    selectedMarketPyeongLabel: null,
    complexScopeBasis: null,
    transactionAsOf: null,
    referenceMonth: null,
    areaBasis: null,
    methodologyCopy: { price: null, trend: null },
    priceLevel: [],
    trends: { "6M": [], "1Y": [], "2Y": [], "5Y": [] },
    maxAvailableValue: {
      priceLevel: null,
      trends: { "6M": null, "1Y": null, "2Y": null, "5Y": null },
    },
  };
}

export function isPricePositionV21(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  return asString((raw as Record<string, unknown>).version) === PRICE_POSITION_V21_VERSION;
}

export function isPricePositionV23(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  return asString((raw as Record<string, unknown>).version) === PRICE_POSITION_V23_VERSION;
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
  if (version !== PRICE_POSITION_V23_VERSION) {
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
  const copyRaw = data.methodologyCopy && typeof data.methodologyCopy === "object"
    ? (data.methodologyCopy as Record<string, unknown>)
    : {};
  const basis = asString(data.complexScopeBasis);
  const resolvedStatus: PriceCompareStatus =
    basis === "ambiguous" && status === "ok" ? "ok" : status;
  return {
    status: resolvedStatus,
    version,
    complexId: asString(data.complexId) ?? complexId,
    aptName: asString(data.aptName),
    areaBand: asString(data.areaBand),
    supplyPyeongCohort: asString(data.supplyPyeongCohort),
    selectedMarketPyeongLabel: finiteNumber(data.selectedMarketPyeongLabel),
    complexScopeBasis: basis,
    transactionAsOf: asString(data.transactionAsOf),
    referenceMonth: asString(data.referenceMonth),
    areaBasis: asString(data.areaBasis),
    methodologyCopy: {
      price: asString(copyRaw.price),
      trend: asString(copyRaw.trend),
    },
    priceLevel: asPriceCells(data.priceLevel),
    trends: {
      "6M": asTrendCells(trendsRaw["6M"]),
      "1Y": asTrendCells(trendsRaw["1Y"]),
      "2Y": asTrendCells(trendsRaw["2Y"]),
      "5Y": asTrendCells(trendsRaw["5Y"]),
    },
    maxAvailableValue: {
      priceLevel: finiteNumber(maxRaw.priceLevel),
      trends: {
        "6M": finiteNumber(trendMaxRaw["6M"]),
        "1Y": finiteNumber(trendMaxRaw["1Y"]),
        "2Y": finiteNumber(trendMaxRaw["2Y"]),
        "5Y": finiteNumber(trendMaxRaw["5Y"]),
      },
    },
  };
}

export async function fetchComplexPricePosition(params: {
  complexId: string;
  exclusiveArea: number;
  marketPyeongLabel: number;
}): Promise<ComplexPricePositionResponse> {
  const qs = new URLSearchParams({
    complex_id: params.complexId,
    exclusive_area: String(params.exclusiveArea),
    market_pyeong_label: String(params.marketPyeongLabel),
  });
  const res = await fetch(`/api/complex-region-price-position?${qs.toString()}`);
  if (!res.ok) {
    throw new RankingRequestError("지역 가격 비교를 불러오지 못했습니다.");
  }
  return asPricePosition(await res.json(), params.complexId);
}

export const PRICE_COMPARE_UNAVAILABLE_ROW_COPY = "준비 중";

export function priceCompareRowCopy(status: PriceCompareCellStatus | string | null | undefined): string {
  if (status === "INSUFFICIENT_SAMPLE") return INSUFFICIENT_SAMPLE_COPY;
  if (status === "unavailable") return PRICE_COMPARE_UNAVAILABLE_ROW_COPY;
  return "—";
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

export function formatReferenceMonthCompact(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  const match = /^(\d{4})-(\d{2})/.exec(raw.trim());
  if (!match) return null;
  return `${match[1]}.${match[2]} 기준`;
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
  selectedMarketPyeongLabel?: number | null;
  supplyPyeongCohort: string | null;
  referenceMonth: string | null;
}): { line1: string | null; line2: string | null } {
  const fromSelector = params.selectedPyeongLabel?.trim() || null;
  const selectorPyeong = fromSelector && /^\d+평$/.test(fromSelector) ? fromSelector : null;
  const fromApi =
    params.selectedMarketPyeongLabel != null && params.selectedMarketPyeongLabel > 0
      ? `${Math.round(params.selectedMarketPyeongLabel)}평`
      : null;
  const selected = selectorPyeong ?? fromApi ?? fromSelector;
  const cohort = supplyCohortCompareLabel(params.supplyPyeongCohort);
  const compact = formatReferenceMonthCompact(params.referenceMonth);
  if (selected && cohort) {
    return { line1: [selected, cohort, compact].filter(Boolean).join(" · "), line2: null };
  }
  if (selected) {
    return { line1: [selected, compact].filter(Boolean).join(" · ") || selected, line2: null };
  }
  if (cohort) return { line1: [cohort, compact].filter(Boolean).join(" · "), line2: null };
  return { line1: compact, line2: null };
}

function yearMonthLabel(raw: string | null | undefined): string | null {
  const match = raw ? /^(\d{4})-(\d{2})/.exec(raw.trim()) : null;
  if (!match) return raw?.trim() || null;
  return `${match[1]}.${match[2]}`;
}

export function trendEndpointFallbackNote(cell: TrendPublicCell): string | null {
  const parts: string[] = [];
  if (
    cell.baselineMonth &&
    cell.actualBaselineMonth &&
    cell.actualBaselineMonth !== cell.baselineMonth
  ) {
    parts.push(
      `비교월 ${yearMonthLabel(cell.baselineMonth)} → ${yearMonthLabel(cell.actualBaselineMonth)}`,
    );
  }
  if (
    cell.currentMonth &&
    cell.actualCurrentMonth &&
    cell.actualCurrentMonth !== cell.currentMonth
  ) {
    parts.push(
      `현재월 ${yearMonthLabel(cell.currentMonth)} → ${yearMonthLabel(cell.actualCurrentMonth)}`,
    );
  }
  return parts.length ? parts.join(" · ") : null;
}

export function trendHorizonFallbackNotes(cells: readonly TrendPublicCell[]): string[] {
  const seen = new Set<string>();
  const notes: string[] = [];
  for (const cell of cells) {
    const note = trendEndpointFallbackNote(cell);
    if (!note || seen.has(note)) continue;
    seen.add(note);
    notes.push(note);
  }
  return notes;
}

/** COMPLEX row shows the apartment name. Never keeps the generic 이 단지 label when a name exists. */
export function priceCompareScopeLabel(params: {
  scope: string | null | undefined;
  label: string | null | undefined;
  aptName: string | null | undefined;
}): string {
  const name = params.aptName?.trim() || null;
  if (params.scope === "COMPLEX" && name) return name;
  const fallback = params.label?.trim() || null;
  if (fallback && fallback !== "이 단지") return fallback;
  return name ?? "—";
}

/** Decade row label from ranking API regionPyeongDecade. Never invents from exclusive ㎡. */
export function rankingDecadeRowLabel(cohort: string | null | undefined): string | null {
  const value = cohort?.trim();
  if (!value) return null;
  return value.replace(/\s*순위$/, "");
}

/**
 * Selected-area ranking title.
 * Decade text comes from ranking API regionPyeongDecade only.
 */
export function rankingSelectedHeading(params: {
  pyeongLabel?: string | null;
  rankingCohortLabel?: string | null;
}): string | null {
  const decade = rankingDecadeRowLabel(params.rankingCohortLabel);
  return decade ? `${decade} 순위` : null;
}

/** Region-trend sample badge only. COMPLEX never shows a badge. ADEQUATE is silent. */
export function trendSampleStatusLabel(params: {
  scope: string | null | undefined;
  sampleStatus: TrendSampleStatus | string | null | undefined;
}): string | null {
  if (params.scope === "COMPLEX") return null;
  if (params.sampleStatus === "THIN") return TREND_SAMPLE_THIN_COPY;
  if (params.sampleStatus === "VERY_THIN") return TREND_SAMPLE_VERY_THIN_COPY;
  return null;
}

/** Inclusive YYYY-MM..YYYY-MM length. Used for helper copy, not displayed as raw windows. */
export function monthsInYearMonthWindow(raw: string | null | undefined): number | null {
  const match = /^(\d{4})-(\d{2})\.\.(\d{4})-(\d{2})$/.exec(raw?.trim() ?? "");
  if (!match) return null;
  const start = Number(match[1]) * 12 + Number(match[2]);
  const end = Number(match[3]) * 12 + Number(match[4]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start + 1;
}

/**
 * Muted helper when the selected horizon is a partial history window.
 * Horizon label and month count come from the selected tab + API windows.
 */
export function partialHistoryHelperCopy(params: {
  horizonLabel: string;
  cells: ReadonlyArray<Pick<TrendPublicCell, "windowStatus" | "currentWindow" | "baselineWindow">>;
}): string | null {
  const partial = params.cells.find((cell) => cell.windowStatus === "PARTIAL_HISTORY_WINDOW");
  if (!partial) return null;
  const months =
    monthsInYearMonthWindow(partial.currentWindow) ??
    monthsInYearMonthWindow(partial.baselineWindow);
  const horizon = params.horizonLabel.trim();
  if (!horizon) return null;
  if (months != null && months > 0) {
    return `${horizon} 변동률은 확보된 이력 범위에 맞춰 양 시점 ${months}개월씩 비교합니다.`;
  }
  return `${horizon} 변동률은 확보된 이력 범위에 맞춰 비교합니다.`;
}

/** Right-side meta for 가격 비교: "30평대 기준 · 2026.09 기준". No selected 평. */
export function priceCompareMetaLine(params: {
  supplyPyeongCohort: string | null | undefined;
  referenceMonth: string | null | undefined;
}): string | null {
  const decade = rankingDecadeRowLabel(params.supplyPyeongCohort);
  const decadeMeta = decade ? `${decade} 기준` : null;
  const month = formatReferenceMonthCompact(params.referenceMonth);
  const parts = [decadeMeta, month].filter((part): part is string => !!part);
  return parts.length ? parts.join(" · ") : null;
}

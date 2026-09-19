/**
 * Presentation helpers for published ranking APIs.
 * Does not score, recompute ranks, or invent public metrics.
 */
import { AREA_BANDS_V1, inAreaBand } from "@/lib/region-ranking/area-band";
import { formatDealDate, formatEok } from "@/lib/utils/format";
import { aptDetailHref } from "@/lib/molit/apt-client";

export const RANKING_TYPES = ["ALL", "59", "84", "114"] as const;
export type RankingType = (typeof RANKING_TYPES)[number];
export type AreaRankingBand = Exclude<RankingType, "ALL">;

export const RANKING_TABS: ReadonlyArray<{
  id: RankingType;
  label: string;
}> = [
  { id: "ALL", label: "종합" },
  { id: "59", label: "59㎡" },
  { id: "84", label: "84㎡" },
  { id: "114", label: "114㎡" },
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
  confidence: string | null;
  coverage: RegionRankingCoverage | null;
  public_metrics: RegionRankingPublicMetrics | null;
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
    ALL: entries.find(([k]) => k === "ALL")?.[1] ?? null,
    "59": entries.find(([k]) => k === "59")?.[1] ?? null,
    "84": entries.find(([k]) => k === "84")?.[1] ?? null,
    "114": entries.find(([k]) => k === "114")?.[1] ?? null,
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
  return `/region/${regionSlug}#region-ranking`;
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
  price: string | null;
  volume: string | null;
  perSqm: string | null;
  latest: string | null;
  allHint: string | null;
};

export function rowPublicMetrics(
  type: RankingType,
  row: RegionRankingRow,
): RankingRowMetrics {
  if (type === "ALL") {
    const hint = [
      coverageCopy(row.coverage),
      confidenceCopy(row.confidence),
    ]
      .filter(Boolean)
      .join(" · ");
    return {
      price: null,
      volume: null,
      perSqm: null,
      latest: null,
      allHint: hint || null,
    };
  }
  const metrics = row.public_metrics;
  const amount = finiteNumber(metrics?.median_deal_amount);
  const perSqm = finiteNumber(metrics?.median_price_per_sqm);
  const count = finiteNumber(metrics?.trade_count);
  const latest = asString(metrics?.latest_deal_date);
  return {
    price: amount != null && amount > 0 ? formatEok(amount) : null,
    volume:
      count != null && count > 0
        ? `${Math.round(count).toLocaleString("ko-KR")}건`
        : null,
    perSqm:
      perSqm != null && perSqm > 0
        ? `${Math.round(perSqm).toLocaleString("ko-KR")}만/㎡`
        : null,
    latest: latest ? formatDealDate(latest.length >= 10 ? latest.slice(0, 10) : latest) : null,
    allHint: null,
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
  if (place.smallCohort && total != null && total > 0) {
    return {
      title,
      meta: `${params.regionName} 비교 ${total.toLocaleString("ko-KR")}개 단지 기준`,
    };
  }
  return {
    title,
    meta:
      total != null && total > 0
        ? `${total.toLocaleString("ko-KR")}개 단지 중`
        : null,
  };
}

export function unavailableBoardCopy(type: RankingType): {
  title: string;
  helper: string;
} {
  if (type === "ALL") {
    return {
      title: "아직 이 면적대의 순위를 준비 중이에요",
      helper: "충분한 거래·단지 데이터가 확보되면 제공됩니다.",
    };
  }
  return {
    title: "아직 이 면적대의 순위를 준비 중이에요",
    helper: "충분한 거래·단지 데이터가 확보되면 제공됩니다.",
  };
}

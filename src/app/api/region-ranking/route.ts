import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import {
  objectiveMetricsByComplex,
  publishedRegionRanking,
  type LaunchAreaBand,
  type RegionBoardBand,
} from "@/lib/region-ranking/query";
import { SMALL_DONG_COHORT_MAX } from "@/lib/region-ranking/score";
import { DECADE_KEYS_V3 } from "@/lib/region-ranking/ranking-v3";

export const dynamic = "force-dynamic";

const LEGACY = new Set(["ALL", "59", "84", "114"]);
const OBJECTIVE = new Set(["TRADE_VOLUME", "PRICE_PER_SQM"]);

function coverageOf(metrics: Record<string, unknown> | null) {
  if (!metrics || !("coverage_status" in metrics)) return null;
  return {
    expected_bands: metrics.expected_bands ?? null,
    valid_bands: metrics.valid_bands ?? null,
    expected_band_count: metrics.expected_band_count ?? null,
    valid_band_count: metrics.valid_band_count ?? null,
    coverage_completeness: metrics.coverage_completeness ?? null,
    coverage_status: metrics.coverage_status ?? null,
    single_product_band: metrics.single_product_band === true,
  };
}

function publicMetricsOf(metrics: Record<string, unknown> | null) {
  if (!metrics || "coverage_status" in metrics) return null;
  return {
    median_price_per_sqm: metrics.median_price_per_sqm ?? null,
    median_deal_amount: metrics.median_deal_amount ?? null,
    trade_count: metrics.trade_count ?? null,
    latest_deal_date: metrics.latest_deal_date ?? null,
  };
}

function boardOf(
  rankingType: string,
): { areaBand: RegionBoardBand; period: string; sort?: "composite" | "trades" | "price" } | null {
  if (rankingType === "COMPOSITE" || rankingType === "ALL") {
    return { areaBand: "ALL", period: "12M" };
  }
  if (rankingType === "TRADES_12M") return { areaBand: "ALL", period: "12M", sort: "trades" };
  if (rankingType === "PRICE_12M") return { areaBand: "ALL", period: "12M", sort: "price" };
  if (DECADE_KEYS_V3.has(rankingType)) {
    return { areaBand: rankingType as RegionBoardBand, period: "12M" };
  }
  if (LEGACY.has(rankingType)) return { areaBand: rankingType as LaunchAreaBand, period: "12M" };
  if (OBJECTIVE.has(rankingType)) return { areaBand: rankingType as RegionBoardBand, period: "3M" };
  return null;
}

export async function GET(request: NextRequest) {
  const regionCode = request.nextUrl.searchParams.get("region_code")?.trim() ?? "";
  const rankingType = request.nextUrl.searchParams.get("ranking_type")?.trim() ?? "";
  const limitRaw = Number(request.nextUrl.searchParams.get("limit") ?? "10");
  const board = boardOf(rankingType);
  if (!/^[0-9]{5}$|^[0-9]{10}$/.test(regionCode) || !board) {
    return NextResponse.json({ error: "region_code와 ranking_type이 필요합니다." }, { status: 400 });
  }
  if (OBJECTIVE.has(rankingType) && regionCode.length !== 5) {
    return NextResponse.json({
      status: "unavailable",
      rankingType,
      regionCode,
      transactionAsOf: null,
      rankingVersion: null,
      period: null,
      regionTotal: null,
      rows: [],
    });
  }
  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: "순위 저장소를 사용할 수 없습니다." }, { status: 500 });
  }
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 50) : 10;
  try {
    const data = await publishedRegionRanking(db, {
      regionCode,
      areaBand: board.areaBand,
      period: board.period,
      limit,
      sort: board.sort,
    });
    if (!("published" in data) || !data.published) {
      return NextResponse.json({
        status: "unavailable",
        rankingType,
        regionCode,
        transactionAsOf: null,
        rankingVersion: null,
        period: null,
        regionTotal: null,
        rows: [],
      });
    }
    const smallCohort =
      regionCode.length === 10 &&
      data.regionTotal > 0 &&
      data.regionTotal <= SMALL_DONG_COHORT_MAX;
    const objective =
      rankingType === "COMPOSITE" || rankingType === "ALL"
        ? await objectiveMetricsByComplex(
            db,
            data.transactionAsOf,
            data.rows.map((row) => row.complexId),
          )
        : null;
    return NextResponse.json({
      status: "ok",
      rankingType,
      regionCode: data.regionCode,
      transactionAsOf: data.transactionAsOf,
      rankingVersion: data.rankingVersion,
      period: data.period,
      regionTotal: data.regionTotal,
      smallCohort,
      rows: data.rows.map((row) => {
        const metrics = row.publicMetrics as Record<string, unknown> | null;
        if (rankingType === "TRADE_VOLUME") {
          return {
            rank: row.rank,
            complex_id: row.complexId,
            apt_name: row.name,
            dong: row.dong,
            build_year: row.buildYear ?? null,
            trade_count_3m: metrics?.trade_count_3m ?? null,
            latest_deal_date: metrics?.latest_deal_date ?? null,
          };
        }
        if (rankingType === "PRICE_PER_SQM") {
          return {
            rank: row.rank,
            complex_id: row.complexId,
            apt_name: row.name,
            dong: row.dong,
            build_year: row.buildYear ?? null,
            median_price_per_sqm_3m: metrics?.median_price_per_sqm_3m ?? null,
            trade_count_3m: metrics?.trade_count_3m ?? null,
          };
        }
        const extra = objective?.get(row.complexId);
        return {
          rank: row.rank,
          complex_id: row.complexId,
          apt_name: row.name,
          dong: row.dong,
          build_year: row.buildYear ?? null,
          transaction_as_of: row.transactionAsOf,
          confidence: row.confidenceBucket,
          coverage: coverageOf(metrics),
          public_metrics: publicMetricsOf(metrics),
          trade_count_3m: extra?.tradeCount3m ?? 0,
          median_price_per_sqm_3m: extra?.medianPricePerSqm3m ?? null,
          percentiles: row.percentiles ?? null,
        };
      }),
    });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "지역 순위를 불러오지 못했습니다." }, { status: 500 });
  }
}

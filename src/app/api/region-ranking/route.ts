import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { publishedRegionRanking, type LaunchAreaBand } from "@/lib/region-ranking/query";
import { SMALL_DONG_COHORT_MAX } from "@/lib/region-ranking/score";

export const dynamic = "force-dynamic";

const BANDS = new Set(["ALL", "59", "84", "114"]);

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

export async function GET(request: NextRequest) {
  const regionCode = request.nextUrl.searchParams.get("region_code")?.trim() ?? "";
  const rankingType = request.nextUrl.searchParams.get("ranking_type")?.trim() ?? "";
  const limitRaw = Number(request.nextUrl.searchParams.get("limit") ?? "10");
  if (!/^[0-9]{5}$|^[0-9]{10}$/.test(regionCode) || !BANDS.has(rankingType)) {
    return NextResponse.json({ error: "region_code와 ranking_type이 필요합니다." }, { status: 400 });
  }
  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: "순위 저장소를 사용할 수 없습니다." }, { status: 500 });
  }
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 50) : 10;
  try {
    const data = await publishedRegionRanking(db, {
      regionCode,
      areaBand: rankingType as LaunchAreaBand,
      limit,
    });
    if (!("published" in data) || !data.published) {
      return NextResponse.json({
        status: "unavailable",
        rankingType,
        regionCode,
        transactionAsOf: null,
        rankingVersion: null,
        regionTotal: null,
        rows: [],
      });
    }
    const smallCohort = regionCode.length === 10 && data.regionTotal > 0 && data.regionTotal <= SMALL_DONG_COHORT_MAX;
    return NextResponse.json({
      status: "ok",
      rankingType: data.rankingType,
      regionCode: data.regionCode,
      transactionAsOf: data.transactionAsOf,
      rankingVersion: data.rankingVersion,
      regionTotal: data.regionTotal,
      smallCohort,
      rows: data.rows.map((row) => {
        const metrics = row.publicMetrics as Record<string, unknown> | null;
        return {
          rank: row.rank,
          complex_id: row.complexId,
          apt_name: row.name,
          dong: row.dong,
          confidence: row.confidenceBucket,
          coverage: coverageOf(metrics),
          public_metrics: publicMetricsOf(metrics),
        };
      }),
    });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "지역 순위를 불러오지 못했습니다." }, { status: 500 });
  }
}

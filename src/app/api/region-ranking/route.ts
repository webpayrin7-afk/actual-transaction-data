import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { publishedRegionRanking, type LaunchAreaBand } from "@/lib/region-ranking/query";

export const dynamic = "force-dynamic";

const BANDS = new Set(["ALL", "59", "84", "114"]);

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
    const started = Date.now();
    const data = await publishedRegionRanking(db, {
      regionCode,
      areaBand: rankingType as LaunchAreaBand,
      limit,
    });
    const elapsed = Date.now() - started;
    if (!data.published) {
      return NextResponse.json({
        ranking_type: rankingType,
        region_scope: data.regionScope ?? null,
        region_code: regionCode,
        published: false,
        status: "unavailable",
        rows: [],
        elapsed_ms: elapsed,
      });
    }
    return NextResponse.json({
      ranking_type: data.rankingType,
      region_scope: data.regionScope,
      region_code: data.regionCode,
      transaction_as_of: data.transactionAsOf,
      ranking_version: data.rankingVersion,
      region_total: data.regionTotal,
      published: true,
      rows: data.rows.map((row) => ({
        rank: row.rank,
        complex_id: row.complexId,
        apt_name: row.name,
        dong: row.dong,
        public_metrics: row.publicMetrics,
        confidence: row.confidenceBucket,
        coverage: row.publicMetrics,
      })),
      elapsed_ms: elapsed,
    });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "지역 순위를 불러오지 못했습니다." }, { status: 500 });
  }
}

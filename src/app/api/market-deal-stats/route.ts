import { NextRequest, NextResponse } from "next/server";
import { getDealStatsForDong, getDealStatsForRegion } from "@/lib/market/deal-stats-query";
import { DEFAULT_TREND_REGION, trendRegionById } from "@/lib/market/trends-regions";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

const CACHE = { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" };

/** 실거래 월간 사전집계. region=시장흐름 id, 또는 lawd+dong=법정동. */
export async function GET(request: NextRequest) {
  const lawd = request.nextUrl.searchParams.get("lawd");
  const dong = request.nextUrl.searchParams.get("dong");
  try {
    if (lawd && dong) {
      const data = await getDealStatsForDong(lawd, dong);
      return NextResponse.json(data, { headers: CACHE });
    }
    const region = trendRegionById(request.nextUrl.searchParams.get("region") ?? DEFAULT_TREND_REGION);
    if (!region) {
      return NextResponse.json({ error: "알 수 없는 지역입니다." }, { status: 400 });
    }
    const data = await getDealStatsForRegion(region);
    return NextResponse.json(data, { headers: CACHE });
  } catch (error) {
    console.error("[market-deal-stats]", error);
    return NextResponse.json({ error: "실거래 집계를 불러오지 못했습니다." }, { status: 502 });
  }
}

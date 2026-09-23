import { NextRequest, NextResponse } from "next/server";
import { getTrendSeries } from "@/lib/market/trends";
import { DEFAULT_TREND_REGION, trendRegionById } from "@/lib/market/trends-regions";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** 시장 동향 — 선택 지역의 장기 시계열 (R-ONE 가격지수·중위가·전세가율 + 실거래 거래량). */
export async function GET(request: NextRequest) {
  const region = trendRegionById(
    request.nextUrl.searchParams.get("region") ?? DEFAULT_TREND_REGION,
  );
  if (!region) {
    return NextResponse.json({ error: "알 수 없는 지역입니다." }, { status: 400 });
  }
  try {
    const data = await getTrendSeries(region);
    return NextResponse.json(data, {
      headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" },
    });
  } catch (error) {
    console.error("[market-trends]", error);
    return NextResponse.json({ error: "시장 동향을 불러오지 못했습니다." }, { status: 502 });
  }
}

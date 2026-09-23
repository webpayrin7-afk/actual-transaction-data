import { NextRequest, NextResponse } from "next/server";
import { getTrendRanking } from "@/lib/market/trends";
import type { TrendRegionGroup } from "@/lib/market/trends-regions";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

function parseGroup(raw: string | null): TrendRegionGroup | null {
  if (raw === "sido" || raw === "seoul" || raw === "wide") return raw;
  return null;
}

/** 시장 동향 — 지역별 매매가격지수 장기 변동률·전고점 대비 (R-ONE). */
export async function GET(request: NextRequest) {
  const group = parseGroup(request.nextUrl.searchParams.get("group") ?? "sido");
  if (!group) {
    return NextResponse.json({ error: "알 수 없는 지역 묶음입니다." }, { status: 400 });
  }
  try {
    const data = await getTrendRanking(group);
    return NextResponse.json(data, {
      headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" },
    });
  } catch (error) {
    console.error("[market-trends/regions]", error);
    return NextResponse.json({ error: "지역 비교를 불러오지 못했습니다." }, { status: 502 });
  }
}

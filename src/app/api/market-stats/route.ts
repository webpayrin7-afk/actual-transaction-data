import { NextRequest, NextResponse } from "next/server";
import { getMarketStats } from "@/lib/market/stats";
import type { StatsPeriod, StatsScope } from "@/lib/market/keys";

export const dynamic = "force-dynamic";
export const revalidate = 60;

function parsePeriod(raw: string | null): StatsPeriod {
  if (raw === "weekly" || raw === "monthly" || raw === "daily") return raw;
  return "weekly";
}

function parseScope(raw: string | null): StatsScope {
  if (raw === "seoul" || raw === "gyeonggi" || raw === "all") return raw;
  return "all";
}

export async function GET(request: NextRequest) {
  try {
    const period = parsePeriod(request.nextUrl.searchParams.get("period"));
    const scope = parseScope(request.nextUrl.searchParams.get("scope"));
    const data = await getMarketStats({ period, scope });
    return NextResponse.json(data, {
      headers: {
        "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
      },
    });
  } catch (error) {
    console.error("[market-stats]", error);
    return NextResponse.json(
      { error: "통계 데이터를 불러오지 못했습니다." },
      { status: 500 },
    );
  }
}

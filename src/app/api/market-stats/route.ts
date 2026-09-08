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

function parseDate(raw: string | null): string | null {
  if (!raw) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  return raw;
}

export async function GET(request: NextRequest) {
  try {
    const period = parsePeriod(request.nextUrl.searchParams.get("period"));
    const scope = parseScope(request.nextUrl.searchParams.get("scope"));
    const date = parseDate(request.nextUrl.searchParams.get("date"));
    const data = await getMarketStats({ period, scope, date });
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

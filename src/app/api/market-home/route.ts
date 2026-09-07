import { NextResponse } from "next/server";
import { getMarketHome } from "@/lib/market/home";

/** 스냅샷 읽기 전용 — 계산은 sync/db:market 에서 수행 */
export const revalidate = 60;

export async function GET() {
  try {
    const data = await getMarketHome();
    return NextResponse.json(data, {
      headers: {
        "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
      },
    });
  } catch (error) {
    console.error("[market-home]", error);
    return NextResponse.json(
      { error: "시장 데이터를 불러오지 못했습니다." },
      { status: 500 },
    );
  }
}

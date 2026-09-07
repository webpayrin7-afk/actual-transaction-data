import { NextResponse } from "next/server";
import { getMarketHome } from "@/lib/market/home";

export const revalidate = 300;

export async function GET() {
  try {
    const data = await getMarketHome();
    return NextResponse.json(data, {
      headers: {
        "Cache-Control": "public, s-maxage=300, stale-while-revalidate=1800",
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

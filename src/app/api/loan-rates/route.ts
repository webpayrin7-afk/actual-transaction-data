import { NextResponse } from "next/server";
import { fetchDreamMoneyRates } from "@/lib/seoul/dream-money";

export const revalidate = 3600;

export async function GET() {
  try {
    const data = await fetchDreamMoneyRates();
    return NextResponse.json(data, {
      headers: {
        "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
      },
    });
  } catch (error) {
    console.error("[loan-rates]", error);
    const message =
      error instanceof Error
        ? error.message
        : "금리 데이터를 불러오지 못했습니다.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

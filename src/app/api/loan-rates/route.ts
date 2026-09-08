import { NextResponse } from "next/server";
import { fetchDreamMoneyRates } from "@/lib/seoul/dream-money";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  try {
    const data = await fetchDreamMoneyRates();
    const cacheControl = data.usingSampleKey
      ? "no-store"
      : "public, s-maxage=3600, stale-while-revalidate=86400";
    return NextResponse.json(data, {
      headers: {
        "Cache-Control": cacheControl,
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

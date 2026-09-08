import { NextResponse } from "next/server";
import { getActiveComplexes } from "@/lib/complexes/active-complexes";

export const dynamic = "force-dynamic";
export const revalidate = 300;

export async function GET() {
  try {
    const data = await getActiveComplexes();
    return NextResponse.json(data, {
      headers: {
        "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600",
      },
    });
  } catch (error) {
    console.error("[complexes/active]", error);
    return NextResponse.json(
      {
        asOfDate: null,
        fromDate: null,
        windowDays: 30,
        dealType: "trade",
        items: [],
        scannedRows: 0,
        source: "empty",
        note: "거래 활발 단지를 불러오지 못했습니다.",
        error: "failed",
      },
      { status: 500 },
    );
  }
}

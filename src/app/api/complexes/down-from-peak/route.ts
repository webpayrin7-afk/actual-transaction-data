import { NextResponse } from "next/server";
import { getDownFromPeakComplexes } from "@/lib/complexes/down-from-peak";

export const dynamic = "force-dynamic";
export const revalidate = 300;

export async function GET() {
  try {
    const data = await getDownFromPeakComplexes();
    return NextResponse.json(data, {
      headers: {
        "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600",
      },
    });
  } catch (error) {
    console.error("[complexes/down-from-peak]", error);
    return NextResponse.json(
      {
        asOfDate: null,
        fromDate: null,
        freshnessDays: 90,
        thresholdPct: -10,
        dealType: "trade",
        items: [],
        candidateGroups: 0,
        source: "empty",
        note: "고점 대비 내려온 단지를 불러오지 못했습니다.",
        error: "failed",
      },
      { status: 500 },
    );
  }
}

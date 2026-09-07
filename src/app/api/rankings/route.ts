import { NextRequest, NextResponse } from "next/server";
import { getRankings } from "@/lib/molit/rankings";

export async function GET(request: NextRequest) {
  const yearMonth = request.nextUrl.searchParams.get("yearMonth") ?? undefined;

  try {
    const data = await getRankings(yearMonth ?? undefined);
    return NextResponse.json(data);
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: "순위 데이터를 불러오지 못했습니다." },
      { status: 500 },
    );
  }
}

import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { readMarketRecords } from "@/lib/market/records";
import { seoulToday } from "@/lib/market/time";

export const dynamic = "force-dynamic";
export const maxDuration = 20;

/** 시장 홈 '오늘의 기록' — date(YYYY-MM-DD, KST 확인일) 기본 오늘 */
export async function GET(request: NextRequest) {
  const param = request.nextUrl.searchParams.get("date") ?? "";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(param) ? param : seoulToday();
  const db = getDb();
  if (!db) return NextResponse.json({ error: "DB가 설정되지 않았습니다." }, { status: 503 });
  try {
    const data = await readMarketRecords(db, date);
    return NextResponse.json(data, {
      headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=900" },
    });
  } catch (error) {
    console.error("[market-records]", error);
    return NextResponse.json({ error: "오늘의 기록을 불러오지 못했습니다." }, { status: 500 });
  }
}

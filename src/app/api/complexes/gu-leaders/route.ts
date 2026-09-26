import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { METRO_LABELS, type Metro } from "@/lib/constants/regions";
import { readGuLeaders } from "@/lib/complexes/gu-leaders";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** 단지 조회 첫 페이지 — 시·도(metro)의 구별 종합 1위 단지 */
export async function GET(request: NextRequest) {
  const metro = request.nextUrl.searchParams.get("metro") ?? "seoul";
  if (!(metro in METRO_LABELS)) return NextResponse.json({ error: "metro가 올바르지 않습니다." }, { status: 400 });
  const db = getDb();
  if (!db) return NextResponse.json({ error: "DB가 설정되지 않았습니다." }, { status: 503 });
  try {
    const data = await readGuLeaders(db, metro as Metro);
    return NextResponse.json(data, {
      headers: { "Cache-Control": "public, s-maxage=1800, stale-while-revalidate=21600" },
    });
  } catch (error) {
    console.error("[gu-leaders]", error);
    return NextResponse.json({ error: "대장 단지를 불러오지 못했습니다." }, { status: 500 });
  }
}

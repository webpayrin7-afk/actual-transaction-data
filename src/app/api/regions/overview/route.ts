import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { readRegionsOverview } from "@/lib/region/regions-overview";

export const dynamic = "force-dynamic";
export const maxDuration = 20;

/** 지역 조회 첫 페이지 타일 — 시·군·구별 평당 중위가 · 전년 대비 */
export async function GET() {
  const db = getDb();
  if (!db) return NextResponse.json({ error: "DB가 설정되지 않았습니다." }, { status: 503 });
  try {
    const data = await readRegionsOverview(db);
    return NextResponse.json(data, {
      headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=21600" },
    });
  } catch (error) {
    console.error("[regions-overview]", error);
    return NextResponse.json({ error: "지역 정보를 불러오지 못했습니다." }, { status: 500 });
  }
}

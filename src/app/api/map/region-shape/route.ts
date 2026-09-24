import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { readRegionShape } from "@/lib/map/region-shape";

export const dynamic = "force-dynamic";
export const maxDuration = 20;

/** 지도 지역 표시 — lawd(5자리) [+ dong 법정동 이름]의 경계(없으면 단지 범위) 다각형 */
export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const lawd = sp.get("lawd") ?? "";
  const dong = sp.get("dong")?.trim() || null;
  if (!/^\d{5}$/.test(lawd)) return NextResponse.json({ error: "lawd가 필요합니다." }, { status: 400 });
  const db = getDb();
  if (!db) return NextResponse.json({ status: "unavailable", paths: [] }, { status: 503 });
  try {
    const shape = await readRegionShape(db, lawd, dong);
    return NextResponse.json(
      { status: "ok", ...shape },
      { headers: { "Cache-Control": "public, s-maxage=21600, stale-while-revalidate=86400" } },
    );
  } catch (error) {
    console.error("[region-shape]", error);
    return NextResponse.json({ status: "unavailable", paths: [] }, { status: 500 });
  }
}

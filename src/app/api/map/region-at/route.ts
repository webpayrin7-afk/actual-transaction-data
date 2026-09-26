import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { readRegionAt } from "@/lib/map/region-at";

export const dynamic = "force-dynamic";
export const maxDuration = 20;

/** 지도 가운데 → 시·도 · 시·군·구 (지도 브리핑 '이 지역'). 좌표는 소수 셋째 자리(약 100m)로 받는다. */
export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const lat = Number(sp.get("lat"));
  const lng = Number(sp.get("lng"));
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < 32 || lat > 39.5 || lng < 124 || lng > 132) {
    return NextResponse.json({ error: "lat·lng가 필요합니다." }, { status: 400 });
  }
  const db = getDb();
  if (!db) return NextResponse.json({ status: "unavailable" }, { status: 503 });
  try {
    const region = await readRegionAt(db, lat, lng);
    return NextResponse.json(
      region ? { status: "ok", ...region } : { status: "not_found" },
      { headers: { "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=604800" } },
    );
  } catch (error) {
    console.error("[region-at]", error);
    return NextResponse.json({ status: "unavailable" }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { readRedevZonesInBbox } from "@/lib/redev/read";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

const MAX_SPAN_DEG = 0.2;

/** 지도 정비구역 레이어 — 영역 안 서울 정비 구역 모양과 사업 단계 */
export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const nums = ["swLat", "swLng", "neLat", "neLng"].map((k) => Number(sp.get(k)));
  if (nums.some((n) => !Number.isFinite(n))) return NextResponse.json({ error: "bbox가 필요합니다." }, { status: 400 });
  const [swLat, swLng, neLat, neLng] = nums as [number, number, number, number];
  if (neLat - swLat > MAX_SPAN_DEG || neLng - swLng > MAX_SPAN_DEG * 1.4) {
    return NextResponse.json({ status: "zoom_in", zones: [] });
  }
  const db = getDb();
  if (!db) return NextResponse.json({ status: "unavailable", zones: [] }, { status: 503 });
  const zones = await readRedevZonesInBbox(db, { swLat, swLng, neLat, neLng });
  return NextResponse.json(
    { status: "ok", zones },
    { headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" } },
  );
}

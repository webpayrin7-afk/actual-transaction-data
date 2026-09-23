import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { MAP_AREA_BANDS, readMapComplexes, type MapAreaBand } from "@/lib/map/map-complexes";

export const dynamic = "force-dynamic";
export const maxDuration = 20;

/** 너무 넓은 영역은 거부 — 지도를 확대해서 다시 요청하도록 (약 0.12° ≈ 서울 한두 개 구). */
const MAX_SPAN_DEG = 0.12;

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const nums = ["swLat", "swLng", "neLat", "neLng"].map((k) => Number(sp.get(k)));
  if (nums.some((n) => !Number.isFinite(n))) {
    return NextResponse.json({ error: "bbox가 필요합니다." }, { status: 400 });
  }
  const [swLat, swLng, neLat, neLng] = nums as [number, number, number, number];
  if (neLat - swLat > MAX_SPAN_DEG || neLng - swLng > MAX_SPAN_DEG * 1.4) {
    return NextResponse.json({ status: "zoom_in", complexes: [] });
  }
  const bandParam = sp.get("band") ?? "all";
  const band: MapAreaBand = bandParam in MAP_AREA_BANDS ? (bandParam as MapAreaBand) : "all";

  const db = getDb();
  if (!db) return NextResponse.json({ status: "unavailable", complexes: [] }, { status: 503 });
  try {
    const result = await readMapComplexes(db, { swLat, swLng, neLat, neLng }, band);
    return NextResponse.json(
      { status: "ok", band, ...result },
      { headers: { "Cache-Control": "public, s-maxage=600, stale-while-revalidate=3600" } },
    );
  } catch (error) {
    console.error(error);
    return NextResponse.json({ status: "unavailable", complexes: [] }, { status: 500 });
  }
}

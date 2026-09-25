import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { readMapAreas, type MapAreaLevel } from "@/lib/map/map-areas";
import {
  MAP_AREA_BANDS,
  MAP_DEAL_KINDS,
  type MapAreaBand,
  type MapDealKind,
} from "@/lib/map/map-complexes";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** 레벨별 최대 영역 (도). 이보다 넓으면 확대 요청. */
const MAX_SPAN: Record<MapAreaLevel, number> = { dong: 0.6, gu: 3.5 };

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const nums = ["swLat", "swLng", "neLat", "neLng"].map((k) => Number(sp.get(k)));
  if (nums.some((n) => !Number.isFinite(n))) {
    return NextResponse.json({ error: "bbox가 필요합니다." }, { status: 400 });
  }
  const [swLat, swLng, neLat, neLng] = nums as [number, number, number, number];
  const level: MapAreaLevel = sp.get("level") === "gu" ? "gu" : "dong";
  if (neLat - swLat > MAX_SPAN[level] || neLng - swLng > MAX_SPAN[level] * 1.4) {
    return NextResponse.json({ status: "zoom_in", areas: [] });
  }
  const bandParam = sp.get("band") ?? "all";
  const band: MapAreaBand = bandParam in MAP_AREA_BANDS ? (bandParam as MapAreaBand) : "all";
  const dealParam = sp.get("deal") ?? "trade";
  const deal: MapDealKind = dealParam in MAP_DEAL_KINDS ? (dealParam as MapDealKind) : "trade";

  const db = getDb();
  if (!db) return NextResponse.json({ status: "unavailable", areas: [] }, { status: 503 });
  try {
    const areas = await readMapAreas(db, { swLat, swLng, neLat, neLng }, level, band, deal);
    return NextResponse.json(
      { status: "ok", level, band, deal, areas },
      { headers: { "Cache-Control": "public, s-maxage=1800, stale-while-revalidate=21600" } },
    );
  } catch (error) {
    console.error(error);
    return NextResponse.json({ status: "unavailable", areas: [] }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import {
  MAP_DEAL_KINDS,
  parseAreaRange,
  attach3dAnchors,
  readMapComplexes,
  toLiteComplex,
  type MapDealKind,
} from "@/lib/map/map-complexes";

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
  const area = parseAreaRange(sp);

  const dealParam = sp.get("deal") ?? "trade";
  const deal: MapDealKind = dealParam in MAP_DEAL_KINDS ? (dealParam as MapDealKind) : "trade";

  const db = getDb();
  if (!db) return NextResponse.json({ status: "unavailable", complexes: [] }, { status: 503 });
  try {
    const result = await readMapComplexes(db, { swLat, swLng, neLat, neLng }, area, deal);
    // fields=lite — 서울 3D 지도용: 그리는 값만 (전세가율·갭·순위 등은 빼고)
    // 3D 지도(view=3d)는 점을 동 가운데 지붕 위에 — 3D 점 자리를 붙인다
    const list = sp.get("view") === "3d" ? await attach3dAnchors(db, result.complexes) : result.complexes;
    const complexes = sp.get("fields") === "lite" ? list.map(toLiteComplex) : list;
    return NextResponse.json(
      { status: "ok", area, deal, complexes, truncated: result.truncated },
      // 실거래 동기화는 하루 1회 — CDN 1시간 + SWR 1일 (다른 단지 API와 같은 수준).
      { headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" } },
    );
  } catch (error) {
    console.error(error);
    return NextResponse.json({ status: "unavailable", complexes: [] }, { status: 500 });
  }
}

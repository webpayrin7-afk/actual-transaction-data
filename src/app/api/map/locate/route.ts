import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { locateForMap } from "@/lib/map/locate";
import { REGION_BY_SLUG } from "@/lib/constants/regions-registry";

export const dynamic = "force-dynamic";
export const maxDuration = 10;

/**
 * 지도 브리핑에서 항목 하나를 눌렀을 때 — 단지(없으면 그 동·구) 위치 한 곳.
 * ?name=단지이름&gu=구&dong=동[&region=지역 slug]. 한 번에 한 곳만 돌려준다 (목록 조회 없음).
 */
export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const name = (sp.get("name") ?? "").trim().slice(0, 80);
  const gu = (sp.get("gu") ?? "").trim().slice(0, 40);
  const dong = (sp.get("dong") ?? "").trim().slice(0, 40) || null;
  // 단지 링크의 region slug (예: seoul-gwangjin, busan-26290) → 시군구 코드
  const slug = (sp.get("region") ?? "").trim().slice(0, 60);
  const lawdCodes = slug ? (REGION_BY_SLUG[slug]?.lawdCodes ?? (/-(\d{5})$/.exec(slug)?.[1] ? [slug.slice(-5)] : [])) : [];
  if (!name && !gu) return NextResponse.json({ error: "name 또는 gu가 필요합니다." }, { status: 400 });

  const db = getDb();
  if (!db) return NextResponse.json({ status: "unavailable" }, { status: 503 });
  try {
    const hit = await locateForMap(db, { name, gu, dong, lawdCodes });
    if (!hit) return NextResponse.json({ status: "not_found" }, { status: 404 });
    return NextResponse.json(
      { status: "ok", ...hit },
      // 단지 좌표는 거의 바뀌지 않는다
      { headers: { "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=604800" } },
    );
  } catch (error) {
    console.error("[map-locate]", error);
    return NextResponse.json({ status: "error" }, { status: 500 });
  }
}

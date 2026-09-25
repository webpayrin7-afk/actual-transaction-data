import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

/** 3D 바닥에 깔 지도 이미지 — 단지 중심 기준 NAVER Static Map (w·h 1024, scale=2 → 2048px). scale=2면 한 변이 월드 px 512(해당 level)만큼만 담긴다 (겹쳐 그려 확인). 오래 캐시한다. */
const GROUND_LEVEL = 15;

export async function GET(_request: NextRequest, { params }: { params: Promise<{ complexId: string }> }) {
  const { complexId } = await params;
  if (!/^cx_[0-9a-f]{16}$/.test(complexId)) return new NextResponse("bad id", { status: 400 });
  const id = process.env.NAVER_MAP_CLIENT_ID?.trim();
  const key = process.env.NAVER_MAP_CLIENT_SECRET?.trim();
  const db = getDb();
  if (!id || !key || !db) return new NextResponse("unavailable", { status: 503 });
  const r = await db.execute({
    sql: `SELECT COALESCE(a.lat, m.latitude) AS lat, COALESCE(a.lng, m.longitude) AS lng
          FROM apt_complex_master m LEFT JOIN complex_map_anchor a ON a.complex_id = m.complex_id
          WHERE m.complex_id = ?`,
    args: [complexId],
  });
  const row = r.rows[0];
  if (!row || row.lat == null) return new NextResponse("not found", { status: 404 });
  const url = `https://maps.apigw.ntruss.com/map-static/v2/raster?w=1024&h=1024&scale=2&format=png&level=${GROUND_LEVEL}&center=${Number(row.lng)},${Number(row.lat)}`;
  const res = await fetch(url, { headers: { "X-NCP-APIGW-API-KEY-ID": id, "X-NCP-APIGW-API-KEY": key } });
  if (!res.ok) return new NextResponse("map unavailable", { status: 502 });
  return new NextResponse(await res.arrayBuffer(), {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=86400, s-maxage=2592000, stale-while-revalidate=2592000",
    },
  });
}

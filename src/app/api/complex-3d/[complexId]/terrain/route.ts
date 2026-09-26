import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { groundSizeM } from "@/lib/complex-3d/ground";
import { terrainGrid } from "@/lib/complex-3d/terrain";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** 3D 바닥 지형 — 바닥 지도와 같은 한 변, 128×128 꼭짓점 상대 높이. 지형은 거의 안 바뀌니 CDN에 오래 둔다. */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ complexId: string }> }) {
  const { complexId } = await params;
  if (!/^cx_[0-9a-f]{16}$/.test(complexId)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  const db = getDb();
  if (!db) return NextResponse.json({ error: "unavailable" }, { status: 503 });
  const r = await db.execute({
    sql: `SELECT COALESCE(a.lat, m.latitude) AS lat, COALESCE(a.lng, m.longitude) AS lng
          FROM apt_complex_master m LEFT JOIN complex_map_anchor a ON a.complex_id = m.complex_id
          WHERE m.complex_id = ?`,
    args: [complexId],
  });
  const row = r.rows[0];
  if (!row || row.lat == null) return NextResponse.json({ error: "not found" }, { status: 404 });
  const center = { lat: Number(row.lat), lng: Number(row.lng) };
  try {
    const grid = await terrainGrid(center, groundSizeM(center.lat));
    if (!grid) return NextResponse.json({ error: "terrain unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
    return NextResponse.json(grid, {
      headers: { "Cache-Control": "public, max-age=86400, s-maxage=31536000, stale-while-revalidate=31536000" },
    });
  } catch (error) {
    console.error("[complex-3d terrain]", error);
    return NextResponse.json({ error: "terrain unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}

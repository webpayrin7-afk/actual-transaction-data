import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import {
  ELEM_ZONE_NOTE,
  ELEM_ZONE_SOURCE_LABEL,
  readComplexElemZones,
} from "@/lib/complex-detail/elem-school-zone-server";

export const dynamic = "force-dynamic";
export const maxDuration = 20;

/**
 * 단지의 초등학교 통학구역 — 서울 3D 지도에서 단지를 골랐을 때만 부른다 (한 단지씩, 여러 단지를 한꺼번에 주는 길은 없음).
 * 배정 학교 이름과 지도용 구역 도형(단순화본)만 준다. 판정은 미리 계산해 둔 것. 통학구역은 반기마다 바뀌어 CDN에 하루.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ complexId: string }> }) {
  const { complexId } = await params;
  if (!/^cx_[0-9a-f]{16}$/.test(complexId)) {
    return NextResponse.json({ error: "단지 번호가 올바르지 않습니다." }, { status: 400 });
  }
  const db = getDb();
  if (!db) return NextResponse.json({ error: "DB가 설정되지 않았습니다." }, { status: 503 });
  try {
    const data = await readComplexElemZones(db, complexId, { geometry: true });
    if (!data || !data.zones.length) {
      return NextResponse.json(
        { error: "통학구역을 찾지 못했습니다." },
        { status: 404, headers: { "Cache-Control": "public, s-maxage=86400" } },
      );
    }
    return NextResponse.json(
      {
        complexId,
        zones: data.zones.map((z) => ({
          zoneId: z.zoneId,
          name: z.name,
          kind: z.kind,
          schools: z.schools.map((s) => s.name),
        })),
        baseDate: data.baseDate,
        bbox: data.bbox ?? null,
        geometry: data.geometry,
        note: ELEM_ZONE_NOTE,
        attribution: ELEM_ZONE_SOURCE_LABEL,
      },
      { headers: { "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=604800" } },
    );
  } catch (error) {
    console.error("[complex-school-zone]", error);
    return NextResponse.json({ error: "통학구역을 불러오지 못했습니다." }, { status: 500 });
  }
}

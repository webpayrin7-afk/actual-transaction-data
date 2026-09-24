import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { readComplex3d } from "@/lib/complex-3d/read";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** 3D 단지 탐색 — 동 모양·높이·평형, 주변 건물, 층별 시세, 주변 학교·역 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ complexId: string }> }) {
  const { complexId } = await params;
  if (!/^cx_[0-9a-f]{16}$/.test(complexId)) {
    return NextResponse.json({ error: "단지 번호가 올바르지 않습니다." }, { status: 400 });
  }
  const db = getDb();
  if (!db) return NextResponse.json({ error: "DB가 설정되지 않았습니다." }, { status: 503 });
  try {
    const data = await readComplex3d(db, complexId);
    if (!data) return NextResponse.json({ error: "단지를 찾지 못했습니다." }, { status: 404 });
    return NextResponse.json(data, {
      headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" },
    });
  } catch (error) {
    console.error("[complex-3d]", error);
    return NextResponse.json({ error: "3D 정보를 불러오지 못했습니다." }, { status: 500 });
  }
}

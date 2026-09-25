import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { readComplex3dCoverage } from "@/lib/complex-3d/read";

export const dynamic = "force-dynamic";
export const maxDuration = 10;

/** 3D 모형 가능 여부 — 동 수 · 건물 모양이 연결된 동 수 (지도 카드의 '3D로 보기' 버튼용) */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ complexId: string }> }) {
  const { complexId } = await params;
  if (!/^cx_[0-9a-f]{16}$/.test(complexId)) {
    return NextResponse.json({ error: "단지 번호가 올바르지 않습니다." }, { status: 400 });
  }
  const db = getDb();
  if (!db) return NextResponse.json({ error: "DB가 설정되지 않았습니다." }, { status: 503 });
  try {
    const coverage = await readComplex3dCoverage(db, complexId);
    if (!coverage) return NextResponse.json({ error: "단지를 찾지 못했습니다." }, { status: 404 });
    return NextResponse.json(coverage, {
      headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" },
    });
  } catch (error) {
    console.error("[complex-3d/coverage]", error);
    return NextResponse.json({ error: "3D 정보를 불러오지 못했습니다." }, { status: 500 });
  }
}

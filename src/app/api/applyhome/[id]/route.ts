import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { readApplyhomeDetail } from "@/lib/applyhome/read";

export const dynamic = "force-dynamic";
export const maxDuration = 20;

/** 분양 공고 상세 — 주택형별 분양가 · 1순위 경쟁률 · 주변 시세 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^\d{6,12}$/.test(id)) return NextResponse.json({ error: "공고 번호가 올바르지 않습니다." }, { status: 400 });
  const db = getDb();
  if (!db) return NextResponse.json({ error: "DB가 설정되지 않았습니다." }, { status: 503 });
  try {
    const data = await readApplyhomeDetail(db, id);
    if (!data) return NextResponse.json({ error: "공고를 찾지 못했습니다." }, { status: 404 });
    return NextResponse.json(data, {
      headers: { "Cache-Control": "public, s-maxage=1800, stale-while-revalidate=21600" },
    });
  } catch (error) {
    console.error("[applyhome-detail]", error);
    return NextResponse.json({ error: "공고를 불러오지 못했습니다." }, { status: 500 });
  }
}

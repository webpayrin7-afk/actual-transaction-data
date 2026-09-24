import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { readApplyhomeTrends } from "@/lib/applyhome/read";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** 분양 동향 — 분기별 물량·경쟁률·미달 비율·평당 분양가, 시·도별 청약 성적 */
export async function GET() {
  const db = getDb();
  if (!db) return NextResponse.json({ error: "DB가 설정되지 않았습니다." }, { status: 503 });
  try {
    const data = await readApplyhomeTrends(db);
    return NextResponse.json(data, {
      headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=21600" },
    });
  } catch (error) {
    console.error("[applyhome-trends]", error);
    return NextResponse.json({ error: "분양 동향을 불러오지 못했습니다." }, { status: 500 });
  }
}

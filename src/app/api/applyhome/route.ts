import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { readApplyhomeOverview } from "@/lib/applyhome/read";

export const dynamic = "force-dynamic";
export const maxDuration = 20;

/** 청약 일정 · 최근 청약 경쟁률 · 입주 예정 (청약홈 사본) */
export async function GET() {
  const db = getDb();
  if (!db) return NextResponse.json({ error: "DB가 설정되지 않았습니다." }, { status: 503 });
  try {
    const data = await readApplyhomeOverview(db);
    return NextResponse.json(data, {
      headers: { "Cache-Control": "public, s-maxage=1800, stale-while-revalidate=21600" },
    });
  } catch (error) {
    console.error("[applyhome]", error);
    return NextResponse.json({ error: "청약 정보를 불러오지 못했습니다." }, { status: 500 });
  }
}

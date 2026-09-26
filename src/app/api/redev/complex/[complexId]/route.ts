import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { readComplexRedev } from "@/lib/redev/read";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

/** 단지가 들어간 서울 정비 구역과 사업 단계 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ complexId: string }> }) {
  const { complexId } = await params;
  if (!/^cx_[0-9a-f]{16}$/.test(complexId)) {
    return NextResponse.json({ error: "단지 번호가 올바르지 않습니다." }, { status: 400 });
  }
  const db = getDb();
  if (!db) return NextResponse.json({ items: [] }, { status: 503 });
  const items = await readComplexRedev(db, complexId);
  return NextResponse.json(
    { items },
    { headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" } },
  );
}

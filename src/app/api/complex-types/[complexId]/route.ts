import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { readUnitTypesWithDongs } from "@/lib/apt/unit-types-dongs";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

/** 단지 타입(공급·전용면적)과 타입이 있는 동 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ complexId: string }> }) {
  const { complexId } = await params;
  if (!/^cx_[0-9a-f]{16}$/.test(complexId)) {
    return NextResponse.json({ error: "단지 번호가 올바르지 않습니다." }, { status: 400 });
  }
  const db = getDb();
  if (!db) return NextResponse.json({ types: [] }, { status: 503 });
  try {
    const types = await readUnitTypesWithDongs(db, complexId);
    return NextResponse.json(
      { types },
      { headers: { "Cache-Control": "public, s-maxage=600, stale-while-revalidate=3600" } },
    );
  } catch (error) {
    console.error("[complex-types]", error);
    return NextResponse.json({ types: [] }, { status: 500 });
  }
}

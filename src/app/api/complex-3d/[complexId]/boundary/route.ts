import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { readSiteBoundary } from "@/lib/complex-3d/boundary";

export const dynamic = "force-dynamic";
export const maxDuration = 20;

/**
 * 단지 대지 경계 — 서울 3D 지도에서 단지를 골랐을 때만 부른다 (한 단지씩, 여러 단지를 한꺼번에 주는 길은 없음).
 * 지적도 필지(브이월드 연속지적도)를 우선, 없으면 동 외곽선으로 추정. 필지는 거의 안 바뀌어 CDN에 오래 둔다.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ complexId: string }> }) {
  const { complexId } = await params;
  if (!/^cx_[0-9a-f]{16}$/.test(complexId)) {
    return NextResponse.json({ error: "단지 번호가 올바르지 않습니다." }, { status: 400 });
  }
  const db = getDb();
  if (!db) return NextResponse.json({ error: "DB가 설정되지 않았습니다." }, { status: 503 });
  try {
    const data = await readSiteBoundary(db, complexId);
    if (!data) {
      return NextResponse.json(
        { error: "단지 경계를 찾지 못했습니다." },
        { status: 404, headers: { "Cache-Control": "public, s-maxage=86400" } },
      );
    }
    return NextResponse.json(data, {
      headers: {
        // 필지 경계는 30일, 추정 경계는 하루 (브이월드가 잠시 안 돼 추정으로 준 경우 곧 다시 시도)
        "Cache-Control":
          data.source === "parcel"
            ? "public, s-maxage=2592000, stale-while-revalidate=604800"
            : "public, s-maxage=86400, stale-while-revalidate=86400",
      },
    });
  } catch (error) {
    console.error("[complex-3d/boundary]", error);
    return NextResponse.json({ error: "단지 경계를 불러오지 못했습니다." }, { status: 500 });
  }
}

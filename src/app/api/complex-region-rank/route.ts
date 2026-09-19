import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { publishedComplexPosition, type LaunchAreaBand } from "@/lib/region-ranking/query";

export const dynamic = "force-dynamic";

const BANDS = new Set(["ALL", "59", "84", "114"]);

export async function GET(request: NextRequest) {
  const complexId = request.nextUrl.searchParams.get("complex_id")?.trim() ?? "";
  const areaBand = request.nextUrl.searchParams.get("area_band")?.trim() ?? "";
  if (!/^cx_[0-9a-f]{16}$/.test(complexId)) {
    return NextResponse.json({ error: "complex_id가 필요합니다." }, { status: 400 });
  }
  if (areaBand && !BANDS.has(areaBand)) {
    return NextResponse.json({ error: "area_band가 올바르지 않습니다." }, { status: 400 });
  }
  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: "순위 저장소를 사용할 수 없습니다." }, { status: 500 });
  }
  try {
    const started = Date.now();
    const data = await publishedComplexPosition(db, {
      complexId,
      areaBand: areaBand ? (areaBand as LaunchAreaBand) : null,
    });
    const elapsed = Date.now() - started;
    if (!data.found) {
      return NextResponse.json({
        found: false,
        complex_id: complexId,
        published: false,
        status: "unavailable",
        elapsed_ms: elapsed,
      });
    }
    return NextResponse.json({
      found: true,
      complex_id: data.complexId,
      apt_name: data.aptName,
      dong: data.dongName,
      gu_code: data.guCode,
      dong_code: data.dongCode,
      published: data.positions.some((item) => item.gu.published || item.dong.published),
      positions: data.positions,
      elapsed_ms: elapsed,
    });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "단지 순위를 불러오지 못했습니다." }, { status: 500 });
  }
}

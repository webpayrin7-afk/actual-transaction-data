import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { DECADE_KEYS_V3 } from "@/lib/region-ranking/ranking-v3";
import { readRegionalPricePosition } from "@/lib/region-ranking/region-price-read";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const regionCode = request.nextUrl.searchParams.get("region_code")?.trim() ?? "";
  const areaBand = request.nextUrl.searchParams.get("area_band")?.trim() ?? "";
  const preferredComplexId =
    request.nextUrl.searchParams.get("from_complex_id")?.trim() ?? "";

  if (!/^[0-9]{5}$|^[0-9]{10}$/.test(regionCode)) {
    return NextResponse.json(
      { error: "region_code가 필요합니다." },
      { status: 400 },
    );
  }
  if (!DECADE_KEYS_V3.has(areaBand)) {
    return NextResponse.json(
      { error: "area_band(평형대)가 필요합니다." },
      { status: 400 },
    );
  }

  const db = getDb();
  if (!db) {
    return NextResponse.json(
      { error: "가격 저장소를 사용할 수 없습니다." },
      { status: 500 },
    );
  }

  try {
    const data = await readRegionalPricePosition(db, {
      regionCode,
      areaBand,
      preferredComplexId: preferredComplexId || null,
    });
    return NextResponse.json(data);
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: "지역 대표 평당가를 불러오지 못했습니다." },
      { status: 500 },
    );
  }
}

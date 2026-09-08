import { NextRequest, NextResponse } from "next/server";
import { getRegion } from "@/lib/constants/regions";
import { listSyncedYearMonths } from "@/lib/db/repository";
import { recentYearMonths } from "@/lib/utils/format";

export const dynamic = "force-dynamic";

/** 지역에 적재된 계약년월 목록 (선택 UI용) */
export async function GET(request: NextRequest) {
  const regionSlug = request.nextUrl.searchParams.get("region")?.trim() ?? "";
  if (!regionSlug) {
    return NextResponse.json(
      { error: "region 파라미터가 필요합니다." },
      { status: 400 },
    );
  }

  const region = getRegion(regionSlug);
  if (!region) {
    return NextResponse.json(
      { error: `지원하지 않는 지역입니다: ${regionSlug}` },
      { status: 400 },
    );
  }

  let yearMonths: string[] = [];
  try {
    yearMonths = await listSyncedYearMonths(region.lawdCodes);
  } catch (error) {
    console.warn("[region-coverage] db read failed:", error);
  }

  // 적재 데이터가 없으면 API 조회 가능한 최근 구간으로 폴백
  if (!yearMonths.length) {
    yearMonths = recentYearMonths(120);
  }

  const currentYm = recentYearMonths(1)[0];
  if (!yearMonths.includes(currentYm)) {
    yearMonths = [currentYm, ...yearMonths];
  }

  return NextResponse.json({
    region: region.slug,
    yearMonths,
  });
}

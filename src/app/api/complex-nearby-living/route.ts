/**
 * Lazy living-tab API — NAVER Local Search only.
 * Does not block initial apt detail; credentials are server-only.
 */

import { NextRequest, NextResponse } from "next/server";
import { fetchNearbyLivingPlaces } from "@/lib/complex-detail/nearby-living";
import { isNaverLocalSearchConfigured } from "@/lib/complex-detail/naver-local-search";

export const dynamic = "force-dynamic";
export const revalidate = 86400;

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const aptName = searchParams.get("aptName")?.trim() || "";
  const lat = Number(searchParams.get("lat"));
  const lng = Number(searchParams.get("lng"));
  const sigungu = searchParams.get("sigungu")?.trim() || null;
  const legalDong =
    searchParams.get("legalDong")?.trim() ||
    searchParams.get("legalDongName")?.trim() ||
    null;

  if (!aptName) {
    return NextResponse.json(
      { status: "ERROR", reason: "aptName required", places: [], categories: [] },
      { status: 400 },
    );
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json(
      {
        status: "ERROR",
        reason: "lat/lng required",
        places: [],
        categories: [],
      },
      { status: 400 },
    );
  }

  if (!isNaverLocalSearchConfigured()) {
    return NextResponse.json({
      status: "HOLD",
      reason:
        "NAVER Local Search 인증이 없어 주변 생활시설을 불러올 수 없습니다.",
      source: "NAVER_LOCAL",
      configured: false,
      requiredEnv: [
        "NAVER_API_HUB_CLIENT_ID",
        "NAVER_API_HUB_CLIENT_SECRET",
        "(또는 NCP_APIGW_API_KEY_ID / NCP_APIGW_API_KEY)",
        "(또는 NAVER_SEARCH_CLIENT_ID / NAVER_SEARCH_CLIENT_SECRET)",
        "(legacy: NAVER_CLIENT_ID / NAVER_CLIENT_SECRET)",
      ],
      apiCallCount: 0,
      duplicatesRemoved: 0,
      overRadiusRemoved: 0,
      categories: [],
      places: [],
    });
  }

  const result = await fetchNearbyLivingPlaces({
    aptName,
    center: { lat, lng },
    sigungu,
    legalDong,
  });

  return NextResponse.json({
    ...result,
    configured: true,
  });
}

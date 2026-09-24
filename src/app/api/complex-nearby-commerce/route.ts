/**
 * Lazy commerce-tab API — NAVER Local Search only.
 * Does not block initial apt detail; credentials are server-only.
 */

import { NextRequest, NextResponse } from "next/server";
import { fetchNearbyCommercePlaces } from "@/lib/complex-detail/nearby-commerce";
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
        "NAVER Local Search 인증이 없어 주변 상권 정보를 불러올 수 없습니다.",
      source: "NAVER_LOCAL",
      configured: false,
      requiredEnv: [
        "NAVER_API_HUB_CLIENT_ID",
        "NAVER_API_HUB_CLIENT_SECRET",
      ],
      apiCallCount: 0,
      duplicatesRemoved: 0,
      overRadiusRemoved: 0,
      categories: [],
      places: [],
    });
  }

  const result = await fetchNearbyCommercePlaces({
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

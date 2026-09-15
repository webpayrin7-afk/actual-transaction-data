/**
 * Lazy nearby-schools API — NEIS schoolInfo only.
 * Official coords when present; otherwise address for client NAVER Geocode.
 * No DB write. No catchment / assignment claim.
 */

import { NextRequest, NextResponse } from "next/server";
import { isValidLatLng } from "@/lib/complex-detail/geo";
import { isJamsilElsSchoolPilot } from "@/lib/complex-detail/jamsil-els-school-pilot";
import { fetchJamsilElsPilotSchools } from "@/lib/complex-detail/neis";
import {
  SCHOOL_CACHE_VERSION,
  SCHOOL_DISPLAY_MAX_METERS,
  SCHOOL_MAX_PER_LEVEL,
  schoolGeocodeQuery,
  toSchoolLevelCode,
} from "@/lib/complex-detail/nearby-schools";

export const dynamic = "force-dynamic";
export const revalidate = 86400;

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const aptName = searchParams.get("aptName")?.trim() || "";
  const lat = Number(searchParams.get("lat"));
  const lng = Number(searchParams.get("lng"));

  if (!aptName) {
    return NextResponse.json(
      {
        status: "ERROR",
        reason: "aptName required",
        source: "NEIS",
        cacheVersion: SCHOOL_CACHE_VERSION,
        schools: [],
        categories: [],
      },
      { status: 400 },
    );
  }

  if (!isValidLatLng({ lat, lng })) {
    return NextResponse.json(
      {
        status: "ERROR",
        reason: "lat/lng required",
        source: "NEIS",
        cacheVersion: SCHOOL_CACHE_VERSION,
        schools: [],
        categories: [],
      },
      { status: 400 },
    );
  }

  if (!isJamsilElsSchoolPilot(aptName)) {
    return NextResponse.json({
      status: "PILOT_ONLY",
      reason: "인근 학교 실데이터는 잠실엘스 pilot만 지원합니다.",
      source: "NEIS",
      cacheVersion: SCHOOL_CACHE_VERSION,
      displayMaxMeters: SCHOOL_DISPLAY_MAX_METERS,
      maxPerLevel: SCHOOL_MAX_PER_LEVEL,
      schools: [],
      categories: [],
      needsClientGeocode: false,
    });
  }

  try {
    const result = await fetchJamsilElsPilotSchools({
      aptName,
      coords: { lat, lng },
    });

    const schools = result.schools.map((s, i) => {
      const hasOfficial =
        s.lat != null &&
        s.lng != null &&
        Number.isFinite(s.lat) &&
        Number.isFinite(s.lng);
      return {
        id: `school-${s.level}-${i}-${s.name}`,
        name: s.name,
        level: s.level,
        schoolLevel: toSchoolLevelCode(s.level),
        establishment: s.foundation,
        address: s.address,
        roadAddress: s.roadAddress,
        geocodeQuery: schoolGeocodeQuery(s.address, s.roadAddress),
        lat: hasOfficial ? s.lat : null,
        lng: hasOfficial ? s.lng : null,
        distanceMeters: hasOfficial ? s.distanceMeters : null,
        distanceLabel: hasOfficial ? s.distanceLabel : null,
        coordSource: hasOfficial ? ("NEIS" as const) : null,
        source: "NEIS" as const,
      };
    });

    const needsClientGeocode = schools.some(
      (s) => s.lat == null || s.lng == null,
    );

    const ok =
      result.status === "SUCCESS" || result.status === "CATCHMENT_UNVERIFIED";

    return NextResponse.json({
      status: ok
        ? schools.length > 0
          ? "READY"
          : "EMPTY"
        : result.status === "PILOT_ONLY"
          ? "PILOT_ONLY"
          : result.status === "NO_RESULTS"
            ? "EMPTY"
            : "ERROR",
      reason: ok
        ? null
        : result.reason || "인근 학교 정보를 불러오지 못했습니다.",
      source: "NEIS",
      attribution: result.attribution,
      cacheVersion: SCHOOL_CACHE_VERSION,
      displayMaxMeters: SCHOOL_DISPLAY_MAX_METERS,
      maxPerLevel: SCHOOL_MAX_PER_LEVEL,
      distanceBasis: "complexMapAnchor · haversine · 직선거리",
      disclaimer:
        "학교 위치 기반 인근 정보이며 배정학교/통학구역을 의미하지 않습니다.",
      assignmentSupported: false,
      needsClientGeocode,
      schools,
      categories: [],
    });
  } catch {
    return NextResponse.json({
      status: "ERROR",
      reason: "인근 학교 정보를 불러오지 못했습니다.",
      source: "NEIS",
      cacheVersion: SCHOOL_CACHE_VERSION,
      schools: [],
      categories: [],
      needsClientGeocode: false,
    });
  }
}

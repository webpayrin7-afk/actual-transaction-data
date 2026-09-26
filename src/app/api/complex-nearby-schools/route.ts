/**
 * Lazy nearby-schools API.
 * 잠실엘스 pilot: NEIS schoolInfo (official coords, else client NAVER Geocode).
 * 그 외 단지: complex_nearby_schools + school_master (미리 계산, 1.5km).
 * 배정 초등학교: complex_elem_school_zones (통학구역 도형 안에 단지 좌표가 드는지 미리 판정) — 인근 학교 목록과 별개.
 * No DB write.
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
import { buildSchoolDistrictsPayload } from "@/lib/complex-detail/school-district-server";
import {
  buildAttendanceZonePayload,
  readAttendanceZonePayloadFromDb,
} from "@/lib/complex-detail/attendance-zone-server";
import { JAMSIL_ELS_MAP_PILOT } from "@/lib/nearby-map/jamsil-els-pilot";
import { readMaterializedNearbySchools } from "@/lib/school-materialization/read-nearby";
import { getDb } from "@/lib/db/client";

const NOT_APPLICABLE_DISTRICTS = {
  middle: null,
  high: null,
  middleStatus: "NOT_APPLICABLE",
  highStatus: "NOT_APPLICABLE",
} as const;

const NOT_APPLICABLE_ATTENDANCE = {
  elementary: null,
  elementaryStatus: "NOT_APPLICABLE",
} as const;

const NEARBY_DISCLAIMER =
  "학교 위치 기반 인근 정보이며 배정학교/통학구역을 의미하지 않습니다.";

/**
 * 잠실엘스 외 단지 — 미리 계산된 인근 학교(complex_nearby_schools · 학교알리미 좌표).
 * 계산 행이 없는 단지는 EMPTY (pilot 안내 문구 대신).
 */
async function materializedResponse(complexId: string) {
  const base = {
    source: "NEIS" as const,
    cacheVersion: SCHOOL_CACHE_VERSION,
    displayMaxMeters: SCHOOL_DISPLAY_MAX_METERS,
    maxPerLevel: SCHOOL_MAX_PER_LEVEL,
    disclaimer: NEARBY_DISCLAIMER,
    assignmentSupported: false,
    needsClientGeocode: false,
    categories: [],
    schoolDistricts: NOT_APPLICABLE_DISTRICTS,
    attendanceZone: NOT_APPLICABLE_ATTENDANCE,
  };
  const empty = {
    ...base,
    status: "EMPTY",
    reason: "현재 확인 가능한 인근 학교 정보가 없습니다.",
    schools: [],
  };
  const ok = { headers: { "Cache-Control": CACHE_OK } };
  const short = { headers: { "Cache-Control": CACHE_SHORT } };
  if (!complexId) return NextResponse.json(empty, ok);
  // DB가 없으면 reader가 null(=계산 행 없음)을 돌려줘 EMPTY와 구분이 안 된다 → 짧게.
  if (!getDb()) return NextResponse.json(empty, short);

  try {
    const [mat, zone] = await Promise.all([
      readMaterializedNearbySchools(complexId),
      readAttendanceZonePayloadFromDb(complexId),
    ]);
    const attendanceZone = zone ?? NOT_APPLICABLE_ATTENDANCE;
    const schools = (mat?.schools ?? [])
      .filter((s) => s.lat != null && s.lng != null)
      .map((s) => ({
        id: `school-${s.level}-${s.schoolCode}`,
        schoolCode: s.schoolCode,
        name: s.name,
        level: s.level,
        schoolLevel: toSchoolLevelCode(s.level),
        establishment: s.establishment,
        address: s.address,
        roadAddress: s.roadAddress,
        geocodeQuery: schoolGeocodeQuery(s.address, s.roadAddress),
        lat: s.lat,
        lng: s.lng,
        distanceMeters: s.distanceMeters,
        distanceLabel: null,
        coordSource: "NEIS" as const,
        source: "NEIS" as const,
      }));
    if (!schools.length) return NextResponse.json({ ...empty, attendanceZone }, ok);
    return NextResponse.json(
      {
        ...base,
        attendanceZone,
        status: "READY",
        reason: null,
        attribution: mat?.attribution ?? "출처: 학교알리미",
        sourceAsOf: mat?.sourceAsOf ?? null,
        distanceBasis: "단지 대표 필지 좌표 · 직선거리",
        schools,
      },
      ok,
    );
  } catch {
    return NextResponse.json(
      {
        ...base,
        status: "ERROR",
        reason: "인근 학교 정보를 불러오지 못했습니다.",
        schools: [],
      },
      short,
    );
  }
}

export const dynamic = "force-dynamic";

// force-dynamic 라우트에선 revalidate가 안 먹는다 → Cache-Control로 CDN 1시간 캐시.
// 쿼리스트링(단지·좌표)이 캐시 키. 조회 실패(NEIS·DB 오류, DB 미연결)는 60초만.
const CACHE_OK = "public, s-maxage=3600, stale-while-revalidate=86400";
const CACHE_SHORT = "public, s-maxage=60";

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const aptName = searchParams.get("aptName")?.trim() || "";
  const complexId = searchParams.get("complexId")?.trim() || "";
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

  const pilot =
    isJamsilElsSchoolPilot(aptName) ||
    complexId === JAMSIL_ELS_MAP_PILOT.complexId;

  if (!pilot) {
    return materializedResponse(complexId);
  }

  // District / attendance payloads are independent of NEIS nearby fetch.
  const schoolDistricts = buildSchoolDistrictsPayload({
    aptName,
    complexId: complexId || null,
  });
  const attendanceZone =
    (await readAttendanceZonePayloadFromDb(
      complexId || JAMSIL_ELS_MAP_PILOT.complexId,
    ).catch(() => null)) ??
    buildAttendanceZonePayload({
      aptName,
      complexId: complexId || null,
    });

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
        schoolCode: s.schoolCode ?? null,
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

    const status = ok
      ? schools.length > 0
        ? "READY"
        : "EMPTY"
      : result.status === "PILOT_ONLY"
        ? "PILOT_ONLY"
        : result.status === "NO_RESULTS"
          ? "EMPTY"
          : "ERROR";

    return NextResponse.json(
      {
        status,
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
        schoolDistricts,
        attendanceZone,
      },
      {
        headers: {
          "Cache-Control": status === "ERROR" ? CACHE_SHORT : CACHE_OK,
        },
      },
    );
  } catch {
    return NextResponse.json(
      {
        status: "ERROR",
        reason: "인근 학교 정보를 불러오지 못했습니다.",
        source: "NEIS",
        cacheVersion: SCHOOL_CACHE_VERSION,
        schools: [],
        categories: [],
        needsClientGeocode: false,
        schoolDistricts,
        attendanceZone,
      },
      { headers: { "Cache-Control": CACHE_SHORT } },
    );
  }
}

/**
 * Client-only: attach NAVER Geocode coords to NEIS schools, then filter/cap.
 */

import { geocodeAddressWithNaver } from "@/lib/nearby-map/naver-sdk";
import type { LatLng } from "@/lib/nearby-map/geo";
import type { SchoolLevel } from "@/lib/complex-detail/neis";
import {
  buildNearbySchoolPlace,
  selectDisplayedSchools,
  schoolGeocodeQuery,
  SCHOOL_CACHE_VERSION,
  type NearbySchoolCategory,
  type NearbySchoolPlace,
} from "@/lib/complex-detail/nearby-schools";
import {
  attachDistancesToDistrictMembers,
  type ProductSchoolDistrictsPayload,
} from "@/lib/complex-detail/school-district";

export type NearbySchoolApiItem = {
  id: string;
  schoolCode: string | null;
  name: string;
  level: SchoolLevel;
  schoolLevel: "ELEMENTARY" | "MIDDLE" | "HIGH";
  establishment: string | null;
  address: string | null;
  roadAddress: string | null;
  geocodeQuery: string | null;
  lat: number | null;
  lng: number | null;
  distanceMeters: number | null;
  distanceLabel: string | null;
  coordSource: "NEIS" | null;
  source: "NEIS";
};

export type NearbySchoolsClientResult = {
  status: "READY" | "EMPTY" | "ERROR" | "PILOT_ONLY" | "HOLD";
  reason: string | null;
  source: "NEIS";
  cacheVersion: string;
  disclaimer: string;
  needsClientGeocode: boolean;
  geocodeAttempts: number;
  geocodeSuccess: number;
  geocodeFailed: number;
  overRadiusRemoved: number;
  withoutCoords: number;
  places: NearbySchoolPlace[];
  categories: NearbySchoolCategory[];
  schoolDistricts: ProductSchoolDistrictsPayload | null;
};

export async function loadNearbySchoolsForMap(params: {
  aptName: string;
  center: LatLng;
  complexId?: string | null;
}): Promise<NearbySchoolsClientResult> {
  const qs = new URLSearchParams({
    aptName: params.aptName,
    lat: String(params.center.lat),
    lng: String(params.center.lng),
  });
  if (params.complexId?.trim()) {
    qs.set("complexId", params.complexId.trim());
  }
  const res = await fetch(`/api/complex-nearby-schools?${qs}`);
  if (!res.ok) {
    throw new Error("인근 학교 정보를 불러오지 못했습니다.");
  }
  const data = (await res.json()) as {
    status: string;
    reason: string | null;
    disclaimer?: string;
    needsClientGeocode?: boolean;
    schools: NearbySchoolApiItem[];
    schoolDistricts?: ProductSchoolDistrictsPayload | null;
  };

  const disclaimer =
    data.disclaimer ||
    "학교 위치 기반 인근 정보이며 배정학교/통학구역을 의미하지 않습니다.";

  // Preserve district payload even on early status exits when API sent it.
  const apiDistricts = data.schoolDistricts ?? null;

  if (data.status === "PILOT_ONLY") {
    return emptyResult("PILOT_ONLY", data.reason, disclaimer, apiDistricts);
  }
  if (data.status === "ERROR") {
    return emptyResult(
      "ERROR",
      data.reason || "인근 학교 정보를 불러오지 못했습니다.",
      disclaimer,
      apiDistricts,
    );
  }

  const raw = Array.isArray(data.schools) ? data.schools : [];
  let geocodeAttempts = 0;
  let geocodeSuccess = 0;
  let geocodeFailed = 0;
  let withoutCoords = 0;
  const resolved: NearbySchoolPlace[] = [];

  async function geocodeWithTimeout(query: string) {
    const GEOCODE_TIMEOUT_MS = 4000;
    return Promise.race([
      geocodeAddressWithNaver(query, { acceptFirst: true }),
      new Promise<{ ok: false; reason: string }>((resolve) =>
        setTimeout(
          () => resolve({ ok: false, reason: "geocode timeout" }),
          GEOCODE_TIMEOUT_MS,
        ),
      ),
    ]);
  }

  for (let i = 0; i < raw.length; i++) {
    const s = raw[i];
    const seed = {
      level: s.level,
      name: s.name,
      foundation: s.establishment,
      address: s.address,
      roadAddress: s.roadAddress,
      schoolCode: s.schoolCode,
    };

    if (
      s.lat != null &&
      s.lng != null &&
      Number.isFinite(s.lat) &&
      Number.isFinite(s.lng)
    ) {
      const place = buildNearbySchoolPlace({
        school: seed,
        index: i,
        center: params.center,
        lat: s.lat,
        lng: s.lng,
        coordSource: "NEIS",
      });
      if (place) resolved.push(place);
      continue;
    }

    const query =
      s.geocodeQuery || schoolGeocodeQuery(s.address, s.roadAddress);
    if (!query) {
      withoutCoords += 1;
      continue;
    }

    geocodeAttempts += 1;
    // Official NEIS road address — accept first hit (complex-anchor stays fail-closed).
    const geo = await geocodeWithTimeout(query);
    if (!geo.ok) {
      geocodeFailed += 1;
      withoutCoords += 1;
      continue;
    }
    geocodeSuccess += 1;
    const place = buildNearbySchoolPlace({
      school: seed,
      index: i,
      center: params.center,
      lat: geo.coordinate.lat,
      lng: geo.coordinate.lng,
      coordSource: "NAVER_GEOCODE",
    });
    if (place) resolved.push(place);
  }

  const selected = selectDisplayedSchools(resolved);

  let schoolDistricts = apiDistricts;
  if (schoolDistricts?.high) {
    schoolDistricts = {
      ...schoolDistricts,
      high: attachDistancesToDistrictMembers(
        schoolDistricts.high,
        params.center,
        resolved,
      ),
    };
  }

  if (!selected.places.length) {
    return {
      status: "EMPTY",
      reason:
        data.reason || "현재 확인 가능한 인근 학교 정보가 없습니다.",
      source: "NEIS",
      cacheVersion: SCHOOL_CACHE_VERSION,
      disclaimer,
      needsClientGeocode: !!data.needsClientGeocode,
      geocodeAttempts,
      geocodeSuccess,
      geocodeFailed,
      overRadiusRemoved: selected.overRadiusRemoved,
      withoutCoords,
      places: [],
      categories: [],
      schoolDistricts,
    };
  }

  return {
    status: "READY",
    reason: null,
    source: "NEIS",
    cacheVersion: SCHOOL_CACHE_VERSION,
    disclaimer,
    needsClientGeocode: !!data.needsClientGeocode,
    geocodeAttempts,
    geocodeSuccess,
    geocodeFailed,
    overRadiusRemoved: selected.overRadiusRemoved,
    withoutCoords,
    places: selected.places,
    categories: selected.categories,
    schoolDistricts,
  };
}

function emptyResult(
  status: "PILOT_ONLY" | "ERROR" | "EMPTY" | "HOLD",
  reason: string | null,
  disclaimer: string,
  schoolDistricts: ProductSchoolDistrictsPayload | null = null,
): NearbySchoolsClientResult {
  return {
    status,
    reason,
    source: "NEIS",
    cacheVersion: SCHOOL_CACHE_VERSION,
    disclaimer,
    needsClientGeocode: false,
    geocodeAttempts: 0,
    geocodeSuccess: 0,
    geocodeFailed: 0,
    overRadiusRemoved: 0,
    withoutCoords: 0,
    places: [],
    categories: [],
    schoolDistricts,
  };
}

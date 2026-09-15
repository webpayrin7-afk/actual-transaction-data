import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@libsql/client";
import { isValidLatLng } from "@/lib/complex-detail/geo";
import { isJamsilElsSchoolPilot } from "@/lib/complex-detail/jamsil-els-school-pilot";
import { fetchNearbySurroundings } from "@/lib/complex-detail/vworld";
import { vworldReadiness } from "@/lib/complex-detail/source-status";
import { fetchJamsilElsPilotSchools } from "@/lib/complex-detail/neis";
import { nearestSeoulMetroStations } from "@/lib/complex-detail/seoul-metro-stations";
import { isJamsilElsTransportPilot } from "@/lib/complex-detail/nearby-transport-pilot";
import {
  nearestJamsilElsSeoulBusStops,
  SEOUL_BUS_STOP_SOURCE,
} from "@/lib/complex-detail/seoul-bus-stops-pilot";
import {
  routesForSeoulBusStop,
  seoulBusRoutePilotMeta,
} from "@/lib/complex-detail/seoul-bus-routes-pilot";
import { seoulMetroCsvFileNames } from "@/lib/complex-detail/seoul-metro-stations";

export const dynamic = "force-dynamic";
export const maxDuration = 25;

function dbUrl(): string | null {
  return process.env.TURSO_DATABASE_URL?.trim() || null;
}

function dbAuth(): string | undefined {
  return process.env.TURSO_AUTH_TOKEN?.trim() || undefined;
}

function straightDistanceLabel(meters: number): string {
  if (!Number.isFinite(meters) || meters < 0) return "—";
  if (meters < 1000) return `직선거리 ${Math.round(meters)}m`;
  const km = meters / 1000;
  return `직선거리 ${km < 10 ? km.toFixed(1) : Math.round(km)}km`;
}

async function resolveCanonicalAddress(aptName: string): Promise<{
  available: boolean;
  address: string | null;
  addressType: "road" | "jibun_composed" | null;
  addressSource: string | null;
}> {
  const url = dbUrl();
  if (!url || !aptName.trim()) {
    return {
      available: false,
      address: null,
      addressType: null,
      addressSource: null,
    };
  }
  try {
    const client = createClient({ url, authToken: dbAuth() });
    const rs = await client.execute({
      sql: `SELECT road_address, jibun, sido, sigungu, legal_dong_name
            FROM apt_complex_master
            WHERE apt_name = ? OR apt_name_norm = ? OR apt_name LIKE ?
            LIMIT 5`,
      args: [aptName, aptName, `%${aptName}%`],
    });
    for (const row of rs.rows) {
      const road = String(row.road_address ?? "").trim();
      if (road) {
        return {
          available: true,
          address: road,
          addressType: "road",
          addressSource: "apt_complex_master.road_address",
        };
      }
      const sido = String(row.sido ?? "").trim();
      const sigungu = String(row.sigungu ?? "").trim();
      const dong = String(row.legal_dong_name ?? "").trim();
      const jibun = String(row.jibun ?? "").trim();
      if (sido && sigungu && dong && jibun) {
        return {
          available: true,
          address: `${sido} ${sigungu} ${dong} ${jibun}`,
          addressType: "jibun_composed",
          addressSource:
            "apt_complex_master.sido+sigungu+legal_dong_name+jibun",
        };
      }
    }
  } catch {
    /* fail-closed */
  }
  return {
    available: false,
    address: null,
    addressType: null,
    addressSource: null,
  };
}

type PoiItem = {
  id: string;
  name: string;
  subcategory: string;
  distanceMeters: number;
  distanceLabel: string;
  lat: number;
  lng: number;
  /** Subway: official line numbers present in source (e.g. ["2","9"]). */
  lines?: string[];
  /** Bus: official route numbers joined by stop id. */
  routes?: string[];
};

function subwaySubcategory(lines: string[]): string {
  if (!lines.length) return "지하철역";
  return lines.map((l) => (/호선$/.test(l) ? l : `${l}호선`)).join("·");
}

/**
 * Complex Detail “주변 생활” payload.
 * Address from master; POI/schools only when client supplies NAVER-geocoded lat/lng.
 * Transport: Seoul Metro CSV + Seoul official bus-stop file pilot; distances from live NAVER geocode center. No TAGO/VWorld on Seoul transport path.
 * No DB writes.
 */
export async function GET(request: NextRequest) {
  const aptName = request.nextUrl.searchParams.get("aptName")?.trim() ?? "";
  const lat = Number(request.nextUrl.searchParams.get("lat"));
  const lng = Number(request.nextUrl.searchParams.get("lng"));

  if (!aptName) {
    return NextResponse.json({ error: "aptName required" }, { status: 400 });
  }

  const address = await resolveCanonicalAddress(aptName);
  const coords = isValidLatLng({ lat, lng }) ? { lat, lng } : null;

  if (!coords) {
    return NextResponse.json({
      address,
      coords: null,
      transport: { status: "NEED_COORDS", items: [] },
      living: { status: "NEED_COORDS", items: [] },
      commerce: {
        status: "NOT_READY",
        reason: "상권 상세 분석 준비 중",
        summary: null,
        items: [],
      },
      school: { status: "NEED_COORDS", items: [], note: null },
    });
  }

  let transportItems: PoiItem[] = [];
  let livingItems: PoiItem[] = [];
  let transportStatus: "READY" | "EMPTY" | "ERROR" = "EMPTY";
  let livingStatus: "READY" | "EMPTY" | "ERROR" = "EMPTY";
  let transportReason = "";
  let livingReason = "";
  let transportMeta: {
    subwaySource: string;
    subwayFiles?: string[];
    busSource: string;
    subwayStatus: string;
    busStatus: string;
    busReason?: string | null;
    vworldTransport: false;
    tagoForSeoul?: false;
    busService?: unknown;
    busRowsReceived?: number;
    busValidCoordinates?: number;
    busNearbyCount?: number;
    busWithin500m?: number;
    busRouteMetadataAvailable?: boolean;
    busRouteSource?: unknown;
    addressUsed?: string | null;
    centerUsed?: { lat: number; lng: number };
  } = {
    subwaySource: "SEOUL_METRO_STATION_FILE",
    busSource: "NONE",
    subwayStatus: "HOLD",
    busStatus: "HOLD",
    busReason: null,
    vworldTransport: false,
    tagoForSeoul: false,
  };

  // ---- TRANSPORT (Seoul Metro CSV + Seoul official bus-stop artifact; never TAGO/VWorld for Seoul) ----
  // Subway + bus distances ALWAYS use the same live request center (client NAVER geocode).
  if (isJamsilElsTransportPilot(aptName)) {
    // Display policy: ≤800m, max 3 distinct physical stations (after merge), distance ASC.
    // Do not pad with stations beyond 800m to fill the count.
    const subwayItems: PoiItem[] = nearestSeoulMetroStations(coords, {
      limit: 3,
      maxMeters: 800,
    }).map((s) => ({
      id: s.id,
      name: s.name,
      subcategory: subwaySubcategory(s.lines),
      distanceMeters: s.distanceMeters,
      distanceLabel: s.distanceLabel,
      lat: s.lat,
      lng: s.lng,
      lines: s.lines,
    }));

    // Seoul official bus-stop file pilot; TAGO not called. Distances from live center.
    const busResult = nearestJamsilElsSeoulBusStops(coords, {
      limit: 6,
      maxMeters: 700,
    });
    const busItems: PoiItem[] = busResult.items.map((b) => {
      const routeRows = routesForSeoulBusStop({
        stopId: b.id,
        arsNo: b.arsNo,
      });
      return {
        id: `bus-${b.id}`,
        name: b.name,
        subcategory: b.arsNo ? `ARS ${b.arsNo}` : "버스정류장",
        distanceMeters: b.distanceMeters,
        distanceLabel: b.distanceLabel,
        lat: b.lat,
        lng: b.lng,
        routes: routeRows.map((r) => r.routeNumber),
      };
    });

    transportItems = [...subwayItems, ...busItems].sort((a, b) => {
      const as = /호선|지하철/.test(a.subcategory) ? 0 : 1;
      const bs = /호선|지하철/.test(b.subcategory) ? 0 : 1;
      if (as !== bs) return as - bs;
      return a.distanceMeters - b.distanceMeters;
    });

    const routeMeta = seoulBusRoutePilotMeta();
    transportMeta = {
      subwaySource: "SEOUL_METRO_STATION_FILE",
      subwayFiles: seoulMetroCsvFileNames(),
      busSource: SEOUL_BUS_STOP_SOURCE,
      subwayStatus: subwayItems.length ? "PASS" : "HOLD",
      busStatus: busResult.status,
      busReason: busResult.reason,
      vworldTransport: false,
      tagoForSeoul: false,
      busService: busResult.meta,
      busRowsReceived: busResult.rowsParsed,
      busValidCoordinates: busResult.validCoordinates,
      busNearbyCount: busResult.nearbyCount,
      busWithin500m: busResult.within500m,
      busRouteMetadataAvailable: Boolean(routeMeta),
      busRouteSource: routeMeta ?? null,
      addressUsed: address.address ?? busResult.addressUsed,
      centerUsed: coords,
    };
  } else {
    // Non-pilot complexes: no nationwide transport master yet.
    transportStatus = "EMPTY";
    transportReason = "현재 확인 가능한 주변 교통 정보가 없습니다.";
    transportMeta = {
      subwaySource: "NONE",
      busSource: "NONE",
      subwayStatus: "HOLD",
      busStatus: "HOLD",
      busReason: "pilot-only",
      vworldTransport: false,
      tagoForSeoul: false,
    };
  }

  if (transportItems.length > 0) {
    transportStatus = "READY";
    transportReason = "";
  } else if (!transportReason) {
    transportStatus = "EMPTY";
    transportReason = "현재 확인 가능한 주변 교통 정보가 없습니다.";
  }

  // ---- LIVING (VWorld allowed; independent of transport) ----
  try {
    const readiness = vworldReadiness(true);
    if (readiness.status !== "READY") {
      livingStatus = "EMPTY";
      livingReason = "현재 확인 가능한 주변 생활 정보가 없습니다.";
    } else {
      const places = await fetchNearbySurroundings({ coords });
      const toItem = (
        p: (typeof places)[number],
        subcategory: string,
        i: number,
      ): PoiItem | null =>
        p.lat != null && p.lng != null
          ? {
              id: `${p.category}-${i}-${p.name}`,
              name: p.name,
              subcategory,
              distanceMeters: p.distanceMeters,
              distanceLabel: straightDistanceLabel(p.distanceMeters),
              lat: p.lat,
              lng: p.lng,
            }
          : null;

      livingItems = places
        .filter((p) =>
          ["living", "medical", "park", "childcare"].includes(p.category),
        )
        .map((p, i) => {
          const sub =
            p.category === "living"
              ? "마트"
              : p.category === "medical"
                ? "병원"
                : p.category === "park"
                  ? "공원"
                  : "육아";
          return toItem(p, sub, i);
        })
        .filter((x): x is PoiItem => !!x);

      livingStatus = livingItems.length > 0 ? "READY" : "EMPTY";
      livingReason =
        livingStatus === "EMPTY"
          ? "현재 확인 가능한 주변 생활 정보가 없습니다."
          : "";
    }
  } catch {
    livingStatus = "EMPTY";
    livingReason = "현재 확인 가능한 주변 생활 정보가 없습니다.";
  }

  let schoolItems: Array<{
    id: string;
    name: string;
    level: string;
    foundation: string | null;
    distanceMeters: number | null;
    distanceLabel: string | null;
    lat: number | null;
    lng: number | null;
  }> = [];
  let schoolStatus: "READY" | "EMPTY" | "ERROR" | "PILOT_ONLY" = "EMPTY";
  let schoolNote: string | null = null;

  try {
    if (!isJamsilElsSchoolPilot(aptName)) {
      schoolStatus = "PILOT_ONLY";
      schoolNote = "인근 학교 실데이터는 잠실엘스 pilot만 지원합니다.";
    } else {
      const result = await fetchJamsilElsPilotSchools({
        aptName,
        coords,
      });
      schoolItems = result.schools.map((s, i) => ({
        id: `school-${s.level}-${i}-${s.name}`,
        name: s.name,
        level: s.level,
        foundation: s.foundation,
        distanceMeters: s.distanceMeters,
        distanceLabel: s.distanceLabel,
        lat: s.lat,
        lng: s.lng,
      }));
      if (
        result.status === "SUCCESS" ||
        result.status === "CATCHMENT_UNVERIFIED"
      ) {
        schoolStatus = schoolItems.length > 0 ? "READY" : "EMPTY";
        schoolNote =
          "인근 학교(NEARBY_SCHOOL) · 배정학교·통학구역 미검증 · NEIS";
      } else if (result.status === "PILOT_ONLY") {
        schoolStatus = "PILOT_ONLY";
        schoolNote = result.reason;
      } else if (result.status === "NO_RESULTS") {
        schoolStatus = "EMPTY";
        schoolNote = result.reason;
      } else {
        schoolStatus = "ERROR";
        schoolNote = result.reason;
      }
    }
  } catch {
    schoolStatus = "ERROR";
    schoolNote = "인근 학교 정보를 불러오지 못했습니다.";
  }

  return NextResponse.json({
    address,
    coords,
    coordClassification: "NAVER_GEOCODE",
    coordAccuracy: "ADDRESS_POINT",
    transport: {
      status: transportStatus,
      reason: transportReason,
      items: transportItems,
      meta: transportMeta,
    },
    living: {
      status: livingStatus,
      reason: livingReason,
      items: livingItems,
    },
    commerce: {
      status: "NOT_READY",
      reason: "상권 상세 분석 준비 중",
      summary: null,
      items: [],
    },
    school: {
      status: schoolStatus,
      note: schoolNote,
      items: schoolItems,
    },
  });
}

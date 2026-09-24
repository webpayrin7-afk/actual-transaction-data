import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@libsql/client";
import { isValidLatLng } from "@/lib/complex-detail/geo";
import { fetchNearbySurroundings } from "@/lib/complex-detail/vworld";
import { vworldReadiness } from "@/lib/complex-detail/source-status";
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
import { readNearbyRailStations } from "@/lib/transit/rail-stations";
import { readNearbyBusStops } from "@/lib/transit/bus-stops";

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
  // 숫자만 온 노선(시범 단지 CSV의 "2")에만 "호선"을 붙인다 — "신분당선"·"부산1호선"은 그대로
  return lines.map((l) => (/^\d+$/.test(l) ? `${l}호선` : l)).join("·");
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
    // Display policy: all distinct physical stations within ≤800m (after merge),
    // distance ASC. No max-count cap; never pad with stations beyond 800m.
    const subwayItems: PoiItem[] = nearestSeoulMetroStations(coords, {
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
    // 그 밖 단지: 전국 도시철도 역(rail_stations) 800m 안 + 버스정류장(bus_stops) 500m 안 가까운 6곳.
    const url = dbUrl();
    const db = url ? createClient({ url, authToken: dbAuth() }) : null;
    const [stations, stops] = db
      ? await Promise.all([
          readNearbyRailStations(db, coords, { maxMeters: 800 }),
          readNearbyBusStops(db, coords, { maxMeters: 500, limit: 6 }),
        ])
      : [[], []];
    const busItems: PoiItem[] = stops.map((b) => ({
      id: b.id,
      name: b.name,
      subcategory: b.arsNo ? `ARS ${b.arsNo}` : "버스정류장",
      distanceMeters: b.distanceMeters,
      distanceLabel: b.distanceLabel,
      lat: b.lat,
      lng: b.lng,
      routes: b.routes,
    }));
    transportItems = stations.map((s) => ({
      id: s.id,
      name: s.name,
      subcategory: subwaySubcategory(s.lines),
      distanceMeters: s.distanceMeters,
      distanceLabel: s.distanceLabel,
      lat: s.lat,
      lng: s.lng,
      lines: s.lines,
    }));
    const subwayCount = transportItems.length;
    transportItems = [...transportItems, ...busItems];
    transportMeta = {
      subwaySource: "RAIL_STATIONS_STANDARD",
      busSource: busItems.length ? "BUS_STOPS_STANDARD" : "NONE",
      subwayStatus: subwayCount ? "PASS" : "HOLD",
      busStatus: busItems.length ? "PASS" : "HOLD",
      busReason: busItems.length ? null : "no-bus-stops",
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

  // School tab uses lazy /api/complex-nearby-schools (NEIS + client NAVER Geocode).
  // Keep this payload inert so transport/living are unaffected.
  const schoolItems: Array<{
    id: string;
    name: string;
    level: string;
    foundation: string | null;
    distanceMeters: number | null;
    distanceLabel: string | null;
    lat: number | null;
    lng: number | null;
  }> = [];
  const schoolStatus = "LAZY" as const;
  const schoolNote: string | null =
    "학교 탭 진입 시 NEIS 인근 학교를 불러옵니다.";

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

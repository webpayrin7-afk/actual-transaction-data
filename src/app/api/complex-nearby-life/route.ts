import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { normalizeAptName } from "@/lib/db/repository";
import { isValidLatLng, type LatLng } from "@/lib/complex-detail/geo";
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

// 단지명+좌표로만 정해지는 공용 데이터(개인화 없음) → CDN 캐시. 쿼리스트링이 캐시 키라 단지끼리 섞이지 않는다.
// 긴 캐시는 모든 원천(주소·역·정류장·노선·생활 POI)이 실제로 응답했을 때만.
// 하나라도 실패·시간 초과(각 reader가 빈 목록으로 삼키는 경우 포함)면 60초만 — 빠진 채로 하루 넘게 굳지 않게.
const CACHE_LONG = "public, s-maxage=86400, stale-while-revalidate=604800";
const CACHE_SHORT = "public, s-maxage=60";

type AddressRow = Record<string, unknown>;

const ADDRESS_SQL = `SELECT road_address, jibun, sido, sigungu, legal_dong_name
            FROM apt_complex_master`;

function straightDistanceLabel(meters: number): string {
  if (!Number.isFinite(meters) || meters < 0) return "—";
  if (meters < 1000) return `직선거리 ${Math.round(meters)}m`;
  const km = meters / 1000;
  return `직선거리 ${km < 10 ? km.toFixed(1) : Math.round(km)}km`;
}

function addressFromRows(rows: AddressRow[]) {
  for (const row of rows) {
    const road = String(row.road_address ?? "").trim();
    if (road) {
      return {
        available: true,
        address: road,
        addressType: "road" as const,
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
        addressType: "jibun_composed" as const,
        addressSource: "apt_complex_master.sido+sigungu+legal_dong_name+jibun",
      };
    }
  }
  return null;
}

type CanonicalAddress = {
  available: boolean;
  address: string | null;
  addressType: "road" | "jibun_composed" | null;
  addressSource: string | null;
};

/** failed: DB 오류로 못 찾음(짧게 캐시). 응답 JSON에는 address만 나간다. */
async function resolveCanonicalAddress(
  aptName: string,
): Promise<{ address: CanonicalAddress; failed: boolean }> {
  const db = getDb();
  const empty: CanonicalAddress = {
    available: false,
    address: null,
    addressType: null,
    addressSource: null,
  };
  if (!db || !aptName.trim()) return { address: empty, failed: false };
  try {
    // apt_name_norm = normalizeAptName(apt_name) 이라 이름 일치는 idx_acm_name_norm 한 번으로 찾는다.
    const exact = await db.execute({
      sql: `${ADDRESS_SQL}
            WHERE apt_name_norm = ?
            LIMIT 5`,
      args: [normalizeAptName(aptName)],
    });
    const hit = addressFromRows(exact.rows);
    if (hit) return { address: hit, failed: false };
    // 이름이 딱 맞는 단지가 없을 때만 예전 부분일치(LIKE, 풀스캔)로.
    const rs = await db.execute({
      sql: `${ADDRESS_SQL}
            WHERE apt_name = ? OR apt_name_norm = ? OR apt_name LIKE ?
            LIMIT 5`,
      args: [aptName, aptName, `%${aptName}%`],
    });
    return { address: addressFromRows(rs.rows) ?? empty, failed: false };
  } catch {
    /* fail-closed */
    return { address: empty, failed: true };
  }
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

const LIVING_EMPTY_REASON = "현재 확인 가능한 주변 생활 정보가 없습니다.";

type LivingResult = {
  status: "READY" | "EMPTY";
  reason: string;
  items: PoiItem[];
  /** 실패한 원천(짧은 캐시 판단용, 응답 JSON에는 안 나간다) */
  failed: string[];
};

// VWorld 교통 검색어(지하철역·버스정류장) 결과는 이 응답에 쓰지 않는다(교통은 역·정류장 표에서).
// 쓰지 않는 결과의 실패로 캐시를 60초로 줄이지 않는다.
const UNUSED_VWORLD_QUERIES = new Set(["지하철역", "버스정류장"]);

// 좌표 단위 인스턴스 메모리 캐시 — 쓰는 검색어가 모두 응답했을 때만 담는다.
const LIVING_TTL_MS = 6 * 60 * 60 * 1000;
const LIVING_CACHE_MAX = 500;
const livingCache = new Map<string, { at: number; value: LivingResult }>();

/** 생활 POI (VWorld) — 교통·주소 조회와 동시에 돈다. */
async function readLiving(coords: LatLng): Promise<LivingResult> {
  const key = `${coords.lat},${coords.lng}`;
  const hit = livingCache.get(key);
  if (hit && Date.now() - hit.at < LIVING_TTL_MS) return hit.value;
  const failed: string[] = [];
  let value: LivingResult;
  try {
    const readiness = vworldReadiness(true);
    if (readiness.status !== "READY") {
      value = { status: "EMPTY", reason: LIVING_EMPTY_REASON, items: [], failed };
    } else {
      const places = await fetchNearbySurroundings({
        coords,
        onFailure: (query) => {
          if (!UNUSED_VWORLD_QUERIES.has(query)) failed.push(`vworld:${query}`);
        },
      });
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

      const items = places
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

      value = {
        status: items.length > 0 ? "READY" : "EMPTY",
        reason: items.length > 0 ? "" : LIVING_EMPTY_REASON,
        items,
        failed,
      };
    }
  } catch {
    return { status: "EMPTY", reason: LIVING_EMPTY_REASON, items: [], failed: ["living"] };
  }
  if (value.failed.length === 0) {
    if (livingCache.size >= LIVING_CACHE_MAX) {
      const oldest = livingCache.keys().next().value;
      if (oldest !== undefined) livingCache.delete(oldest);
    }
    livingCache.set(key, { at: Date.now(), value });
  }
  return value;
}

/** 그 밖 단지 교통: 전국 도시철도 역(rail_stations) 800m 안 + 버스정류장(bus_stops) 500m 안 가까운 6곳. */
async function readDbTransport(coords: LatLng) {
  const failed: string[] = [];
  const onFailure = (source: string) => {
    failed.push(source);
  };
  const db = getDb();
  if (!db) failed.push("db");
  const [stations, stops] = db
    ? await Promise.all([
        readNearbyRailStations(db, coords, { maxMeters: 800, onFailure }),
        readNearbyBusStops(db, coords, {
          maxMeters: 500,
          limit: 6,
          onFailure,
        }),
      ])
    : [[], []];
  return { stations, stops, failed };
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

  const coords = isValidLatLng({ lat, lng }) ? { lat, lng } : null;
  const jamsilPilot = isJamsilElsTransportPilot(aptName);
  // 주소·교통(DB)·생활(VWorld)은 서로 기다릴 이유가 없어 한꺼번에 시작한다.
  const addressP = resolveCanonicalAddress(aptName);
  const dbTransportP = coords && !jamsilPilot ? readDbTransport(coords) : null;
  const livingP = coords ? readLiving(coords) : null;
  const { address, failed: addressFailed } = await addressP;

  if (!coords) {
    return NextResponse.json(
      {
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
      },
      { headers: { "Cache-Control": CACHE_SHORT } },
    );
  }

  let transportItems: PoiItem[] = [];
  let transportStatus: "READY" | "EMPTY" | "ERROR" = "EMPTY";
  let transportReason = "";
  // 일부 원천 실패 기록(응답 JSON에는 안 나간다) — 하나라도 있으면 짧은 캐시.
  const failedSources = new Set<string>();
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
  if (jamsilPilot || !dbTransportP) {
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
    const { stations, stops, failed } = await dbTransportP;
    for (const source of failed) failedSources.add(source);
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
  const living = livingP ? await livingP : null;
  for (const source of living?.failed ?? []) failedSources.add(source);

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

  if (addressFailed) failedSources.add("address");
  const cacheControl = failedSources.size > 0 ? CACHE_SHORT : CACHE_LONG;

  return NextResponse.json(
    {
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
        status: living?.status ?? "EMPTY",
        reason: living?.reason ?? LIVING_EMPTY_REASON,
        items: living?.items ?? [],
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
    },
    { headers: { "Cache-Control": cacheControl } },
  );
}

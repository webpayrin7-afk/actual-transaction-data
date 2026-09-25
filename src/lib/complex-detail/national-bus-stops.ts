/**
 * 전국버스정류소표준데이터 (data.go.kr standard 15096280)
 * → 국토교통부_(TAGO)_버스정류소정보 OpenAPI
 *
 * Access: REST JSON via getCrdntPrxmtSttnList (coordinate proximity)
 * Auth: server-only MOLIT_API_KEY (공공데이터포털 ServiceKey)
 * No VWorld. No local file. No route invention. No DB write.
 */

import { haversineMeters, type LatLng } from "@/lib/complex-detail/geo";

export const NATIONAL_BUS_STOP_SOURCE = "NATIONAL_BUS_STOP_STANDARD" as const;

const SERVICE_BASE =
  "https://apis.data.go.kr/1613000/BusSttnInfoInqireService";
const PROXIMITY_OP = "getCrdntPrxmtSttnList" as const;

/** Pilot extract radius — not a lifestyle-radius claim in UI. */
export const BUS_PILOT_RADIUS_M = 700;

export type NationalBusStop = {
  id: string;
  name: string;
  lat: number;
  lng: number;
  source: typeof NATIONAL_BUS_STOP_SOURCE;
  cityCode?: string | null;
  nodeNo?: string | null;
};

export type NearbyNationalBusStop = NationalBusStop & {
  distanceMeters: number;
  distanceLabel: string;
};

export type NationalBusFetchResult = {
  status: "PASS" | "HOLD" | "EMPTY";
  reason: string | null;
  rowsReceived: number;
  validCoordinates: number;
  nearby: NearbyNationalBusStop[];
  routeMetadataAvailable: false;
  service: {
    name: "국토교통부_(TAGO)_버스정류소정보";
    dataset: "전국버스정류소표준데이터";
    datasetId: "15096280";
    operation: typeof PROXIMITY_OP;
    accessMethod: "OpenAPI";
    responseFormat: "JSON";
    serviceKeyEnv: "MOLIT_API_KEY";
  };
};

function serviceKey(): string | null {
  const raw = process.env.MOLIT_API_KEY?.trim();
  if (!raw) return null;
  // Encoding key may already contain %; Decoding key needs encodeURIComponent.
  return raw.includes("%") ? raw : encodeURIComponent(raw);
}

function straightDistanceLabel(meters: number): string {
  if (!Number.isFinite(meters) || meters < 0) return "—";
  if (meters < 1000) return `직선거리 ${Math.round(meters)}m`;
  const km = meters / 1000;
  return `직선거리 ${km < 10 ? km.toFixed(1) : Math.round(km)}km`;
}

function asArray<T>(v: T | T[] | null | undefined): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string {
  return String(v ?? "").trim();
}

type RawItem = Record<string, unknown>;

function normalizeItem(raw: RawItem): NationalBusStop | null {
  // Actual TAGO JSON fields (verified): nodeid, nodenm, gpslati, gpslong, citycode, nodeno
  const name = str(raw.nodenm ?? raw.nodeNm);
  const id = str(raw.nodeid ?? raw.nodeId);
  const lat = num(raw.gpslati ?? raw.gpsLati);
  const lng = num(raw.gpslong ?? raw.gpsLong);
  if (!name || lat == null || lng == null) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  if (lat === 0 && lng === 0) return null;
  return {
    id: id || `bus-${lat},${lng}-${name}`,
    name,
    lat,
    lng,
    source: NATIONAL_BUS_STOP_SOURCE,
    cityCode: str(raw.citycode ?? raw.cityCode) || null,
    nodeNo: str(raw.nodeno ?? raw.nodeNo) || null,
  };
}

/**
 * Fetch nearby bus stops from the approved public-data service.
 * Bounded by proximity operation — does not download a national dump to the client.
 */
export async function fetchNearbyNationalBusStops(
  center: LatLng,
  opts?: { limit?: number; maxMeters?: number; numOfRows?: number },
): Promise<NationalBusFetchResult> {
  const serviceMeta = {
    name: "국토교통부_(TAGO)_버스정류소정보" as const,
    dataset: "전국버스정류소표준데이터" as const,
    datasetId: "15096280" as const,
    operation: PROXIMITY_OP,
    accessMethod: "OpenAPI" as const,
    responseFormat: "JSON" as const,
    serviceKeyEnv: "MOLIT_API_KEY" as const,
  };

  const key = serviceKey();
  if (!key) {
    return {
      status: "HOLD",
      reason: "MOLIT_API_KEY missing (server-only 공공데이터포털 ServiceKey)",
      rowsReceived: 0,
      validCoordinates: 0,
      nearby: [],
      routeMetadataAvailable: false,
      service: serviceMeta,
    };
  }

  const limit = opts?.limit ?? 3;
  const maxMeters = opts?.maxMeters ?? BUS_PILOT_RADIUS_M;
  const numOfRows = opts?.numOfRows ?? 100;

  const qs = new URLSearchParams({
    pageNo: "1",
    numOfRows: String(numOfRows),
    _type: "json",
    gpsLati: String(center.lat),
    gpsLong: String(center.lng),
  });
  const url = `${SERVICE_BASE}/${PROXIMITY_OP}?serviceKey=${key}&${qs.toString()}`;

  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    });
    if (!res.ok) {
      return {
        status: "HOLD",
        reason: `TAGO bus-stop HTTP ${res.status}`,
        rowsReceived: 0,
        validCoordinates: 0,
        nearby: [],
        routeMetadataAvailable: false,
        service: serviceMeta,
      };
    }

    const json = (await res.json()) as {
      response?: {
        header?: { resultCode?: string; resultMsg?: string };
        body?: {
          items?: { item?: RawItem | RawItem[] } | string | null;
          totalCount?: number;
        };
      };
    };

    const header = json.response?.header;
    const code = str(header?.resultCode);
    if (code && code !== "00" && code !== "0") {
      return {
        status: "HOLD",
        reason: `TAGO bus-stop resultCode=${code} ${str(header?.resultMsg)}`,
        rowsReceived: 0,
        validCoordinates: 0,
        nearby: [],
        routeMetadataAvailable: false,
        service: serviceMeta,
      };
    }

    const rawItems = json.response?.body?.items;
    const list =
      !rawItems || rawItems === ""
        ? []
        : asArray(
            typeof rawItems === "object" && rawItems && "item" in rawItems
              ? (rawItems as { item?: RawItem | RawItem[] }).item
              : [],
          );

    const rowsReceived =
      typeof json.response?.body?.totalCount === "number"
        ? json.response.body.totalCount
        : list.length;

    const valid = list
      .map(normalizeItem)
      .filter((x): x is NationalBusStop => !!x);

    const nearby: NearbyNationalBusStop[] = valid
      .map((s) => {
        const distanceMeters = Math.round(
          haversineMeters(center.lat, center.lng, s.lat, s.lng),
        );
        return {
          ...s,
          distanceMeters,
          distanceLabel: straightDistanceLabel(distanceMeters),
        };
      })
      .filter((s) => s.distanceMeters <= maxMeters)
      .sort((a, b) => a.distanceMeters - b.distanceMeters)
      .slice(0, limit);

    if (nearby.length > 0) {
      return {
        status: "PASS",
        reason: null,
        rowsReceived,
        validCoordinates: valid.length,
        nearby,
        routeMetadataAvailable: false,
        service: serviceMeta,
      };
    }

    return {
      status: "HOLD",
      reason:
        rowsReceived === 0
          ? "TAGO getCrdntPrxmtSttnList returned 0 stops near center (서울/잠실 coverage gap in this service)"
          : `TAGO returned ${rowsReceived} rows but none within ${maxMeters}m`,
      rowsReceived,
      validCoordinates: valid.length,
      nearby: [],
      routeMetadataAvailable: false,
      service: serviceMeta,
    };
  } catch (e) {
    return {
      status: "HOLD",
      reason: `TAGO bus-stop fetch failed: ${e instanceof Error ? e.message : String(e)}`,
      rowsReceived: 0,
      validCoordinates: 0,
      nearby: [],
      routeMetadataAvailable: false,
      service: serviceMeta,
    };
  }
}

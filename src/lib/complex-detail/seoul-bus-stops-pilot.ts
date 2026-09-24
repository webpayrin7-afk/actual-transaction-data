/**
 * 잠실엘스 — Seoul official bus-stop pilot loader.
 * Source: 서울 열린데이터광장 OA-15067 서울시 버스정류소 위치정보
 *
 * Candidate pool is pre-extracted; distances are ALWAYS recomputed from the
 * request complex center (live NAVER geocode). No TAGO. No VWorld. No routes.
 */

import { readFileSync } from "fs";
import path from "path";
import { haversineMeters, type LatLng } from "@/lib/complex-detail/geo";

export const SEOUL_BUS_STOP_SOURCE = "SEOUL_BUS_STOP_OFFICIAL" as const;

export type SeoulBusStopPilotRow = {
  id: string;
  arsNo: string | null;
  name: string;
  lat: number;
  lng: number;
  stopType?: string | null;
  source: typeof SEOUL_BUS_STOP_SOURCE;
  seedDistanceM?: number;
};

export type SeoulBusStopPilotArtifact = {
  complexId: string;
  complexName: string;
  addressUsed?: string;
  center: {
    lat: number;
    lng: number;
    source: string;
    accuracy: string;
  };
  source: {
    dataset: string;
    datasetId: string;
    provider: string;
    portal: string;
    file: string;
    fileDate: string;
    format: string;
    sourceVersion?: string;
  };
  stats: {
    rowsParsed: number;
    validCoordinates: number;
    candidatePoolWithin2000m?: number;
    seedWithin700m?: number;
    seedWithin500m?: number;
    nearbyWithin700m?: number;
  };
  radiusM: number;
  busStops: SeoulBusStopPilotRow[];
  generatedAt: string;
};

const ARTIFACT = path.join(
  "data",
  "poc",
  "nearby-transport",
  "jamsil-els-bus-stops.json",
);

const DEFAULT_RADIUS_M = 700;

let cache: SeoulBusStopPilotArtifact | null | undefined;

export function loadJamsilElsSeoulBusStopPilot(): SeoulBusStopPilotArtifact | null {
  if (cache !== undefined) return cache;
  try {
    const raw = readFileSync(path.join(process.cwd(), ARTIFACT), "utf8");
    cache = JSON.parse(raw) as SeoulBusStopPilotArtifact;
  } catch {
    cache = null;
  }
  return cache;
}

function straightDistanceLabel(meters: number): string {
  if (!Number.isFinite(meters) || meters < 0) return "—";
  if (meters < 1000) return `직선거리 ${Math.round(meters)}m`;
  const km = meters / 1000;
  return `직선거리 ${km < 10 ? km.toFixed(1) : Math.round(km)}km`;
}

/**
 * Nearby Seoul official bus stops relative to the live complex center.
 * Distances are recomputed from `center` — not seed distances in the artifact.
 */
export function nearestJamsilElsSeoulBusStops(
  center: LatLng,
  opts?: { limit?: number; maxMeters?: number },
): {
  status: "PASS" | "HOLD";
  reason: string | null;
  items: Array<{
    id: string;
    name: string;
    arsNo: string | null;
    lat: number;
    lng: number;
    distanceMeters: number;
    distanceLabel: string;
    source: typeof SEOUL_BUS_STOP_SOURCE;
  }>;
  meta: SeoulBusStopPilotArtifact["source"] | null;
  addressUsed: string | null;
  rowsParsed: number;
  validCoordinates: number;
  nearbyCount: number;
  within500m: number;
  centerUsed: LatLng;
} {
  const pilot = loadJamsilElsSeoulBusStopPilot();
  if (!pilot?.busStops?.length) {
    return {
      status: "HOLD",
      reason: "Seoul official bus-stop pilot artifact missing or empty",
      items: [],
      meta: pilot?.source ?? null,
      addressUsed: pilot?.addressUsed ?? null,
      rowsParsed: pilot?.stats?.rowsParsed ?? 0,
      validCoordinates: pilot?.stats?.validCoordinates ?? 0,
      nearbyCount: 0,
      within500m: 0,
      centerUsed: center,
    };
  }

  const limit = opts?.limit ?? 3;
  const maxMeters = opts?.maxMeters ?? pilot.radiusM ?? DEFAULT_RADIUS_M;

  const ranked = pilot.busStops
    .map((b) => {
      const distanceMeters = Math.round(
        haversineMeters(center.lat, center.lng, b.lat, b.lng),
      );
      return {
        id: b.id,
        name: b.name,
        arsNo: b.arsNo ?? null,
        lat: b.lat,
        lng: b.lng,
        distanceMeters,
        distanceLabel: straightDistanceLabel(distanceMeters),
        source: SEOUL_BUS_STOP_SOURCE,
      };
    })
    .filter((b) => b.distanceMeters <= maxMeters)
    .sort((a, b) => a.distanceMeters - b.distanceMeters);

  const within500m = ranked.filter((b) => b.distanceMeters <= 500).length;
  const items = ranked.slice(0, limit);

  return {
    status: items.length ? "PASS" : "HOLD",
    reason: items.length
      ? null
      : `No Seoul bus stops within ${maxMeters}m of live complex center`,
    items,
    meta: pilot.source,
    addressUsed: pilot.addressUsed ?? null,
    rowsParsed: pilot.stats.rowsParsed,
    validCoordinates: pilot.stats.validCoordinates,
    nearbyCount: ranked.length,
    within500m,
    centerUsed: center,
  };
}

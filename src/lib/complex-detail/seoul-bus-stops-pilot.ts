/**
 * 잠실엘스 — Seoul official bus-stop pilot artifact loader.
 * Source: 서울 열린데이터광장 OA-15067 서울시 버스정류소 위치정보
 * Seoul active path: official file extract only (no TAGO). No VWorld. No routes invented.
 */

import { readFileSync } from "fs";
import path from "path";

export const SEOUL_BUS_STOP_SOURCE = "SEOUL_BUS_STOP_OFFICIAL" as const;

export type SeoulBusStopPilotRow = {
  id: string;
  arsNo: string | null;
  name: string;
  lat: number;
  lng: number;
  stopType?: string | null;
  distanceM: number;
  source: typeof SEOUL_BUS_STOP_SOURCE;
};

export type SeoulBusStopPilotArtifact = {
  complexId: string;
  complexName: string;
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
  };
  stats: {
    rowsParsed: number;
    validCoordinates: number;
    nearbyWithin700m: number;
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

/** Nearest Seoul official bus stops from the 잠실엘스 pilot artifact. */
export function nearestJamsilElsSeoulBusStops(opts?: { limit?: number }): {
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
  rowsParsed: number;
  validCoordinates: number;
  nearbyCount: number;
  within500m: number;
} {
  const pilot = loadJamsilElsSeoulBusStopPilot();
  if (!pilot?.busStops?.length) {
    return {
      status: "HOLD",
      reason: "Seoul official bus-stop pilot artifact missing or empty",
      items: [],
      meta: pilot?.source ?? null,
      rowsParsed: pilot?.stats?.rowsParsed ?? 0,
      validCoordinates: pilot?.stats?.validCoordinates ?? 0,
      nearbyCount: 0,
      within500m: 0,
    };
  }

  const limit = opts?.limit ?? 3;
  const items = pilot.busStops
    .slice()
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, limit)
    .map((b) => ({
      id: b.id,
      name: b.name,
      arsNo: b.arsNo ?? null,
      lat: b.lat,
      lng: b.lng,
      distanceMeters: b.distanceM,
      distanceLabel: straightDistanceLabel(b.distanceM),
      source: SEOUL_BUS_STOP_SOURCE,
    }));

  const within500m = pilot.busStops.filter((b) => b.distanceM <= 500).length;

  return {
    status: items.length ? "PASS" : "HOLD",
    reason: null,
    items,
    meta: pilot.source,
    rowsParsed: pilot.stats.rowsParsed,
    validCoordinates: pilot.stats.validCoordinates,
    nearbyCount: pilot.stats.nearbyWithin700m,
    within500m,
  };
}

/**
 * 잠실엘스 nearby-transport pilot artifact (official file extract).
 * No VWorld. No DB write. No route invention.
 */

import { readFileSync } from "fs";
import path from "path";
import { isJamsilElsSchoolPilot } from "@/lib/complex-detail/jamsil-els-school-pilot";

export type PilotTransportPoi = {
  id: string;
  name: string;
  line?: string | null;
  lat: number;
  lng: number;
  distanceMeters: number;
  distanceLabel: string;
  source: string;
  kind: "subway" | "bus";
};

export type NearbyTransportPilot = {
  complex: {
    name: string;
    center: {
      lat: number;
      lng: number;
      source: string;
      accuracy: string;
    };
  };
  sources: {
    subway: {
      file: string | null;
      coverage?: string | null;
      rowsParsed?: number;
      validCoordinates?: number;
      status?: string;
      reason?: string | null;
    };
    bus: {
      file: string | null;
      status: string;
      reason?: string | null;
      rowsParsed?: number;
      validCoordinates?: number;
      routeMetadataAvailable?: boolean;
    };
  };
  subway: Array<{
    id: string;
    name: string;
    line: string | null;
    lat: number;
    lng: number;
    distanceMeters: number;
    distanceLabel: string;
    source: string;
  }>;
  bus: Array<{
    id: string;
    name: string;
    lat: number;
    lng: number;
    distanceMeters: number;
    distanceLabel: string;
    source: string;
  }>;
  radiiMeters: { subway: number; bus: number };
};

const ARTIFACT = path.join(
  "data",
  "poc",
  "nearby-transport",
  "jamsil-els.json",
);

let cache: NearbyTransportPilot | null | undefined;

export function loadJamsilElsNearbyTransportPilot(): NearbyTransportPilot | null {
  if (cache !== undefined) return cache;
  try {
    const raw = readFileSync(path.join(process.cwd(), ARTIFACT), "utf8");
    cache = JSON.parse(raw) as NearbyTransportPilot;
  } catch {
    cache = null;
  }
  return cache;
}

export function isJamsilElsTransportPilot(aptName: string): boolean {
  return isJamsilElsSchoolPilot(aptName);
}

/**
 * Map pilot rows to display POIs.
 * Subway visual priority; caps keep the list small.
 */
export function pilotTransportItems(
  aptName: string,
  opts?: { subwayLimit?: number; busLimit?: number },
): {
  items: PilotTransportPoi[];
  meta: NearbyTransportPilot["sources"] | null;
  usedPilot: boolean;
} {
  if (!isJamsilElsTransportPilot(aptName)) {
    return { items: [], meta: null, usedPilot: false };
  }
  const pilot = loadJamsilElsNearbyTransportPilot();
  if (!pilot) return { items: [], meta: null, usedPilot: false };

  const subwayLimit = opts?.subwayLimit ?? 3;
  const busLimit = opts?.busLimit ?? 3;

  const subway = (pilot.subway ?? [])
    .slice()
    .sort((a, b) => a.distanceMeters - b.distanceMeters)
    .slice(0, subwayLimit)
    .map((s) => ({
      id: s.id,
      name: s.name,
      line: s.line,
      lat: s.lat,
      lng: s.lng,
      distanceMeters: s.distanceMeters,
      distanceLabel: s.distanceLabel,
      source: s.source,
      kind: "subway" as const,
    }));

  const bus = (pilot.bus ?? [])
    .slice()
    .sort((a, b) => a.distanceMeters - b.distanceMeters)
    .slice(0, busLimit)
    .map((b) => ({
      id: b.id,
      name: b.name,
      line: null,
      lat: b.lat,
      lng: b.lng,
      distanceMeters: b.distanceMeters,
      distanceLabel: b.distanceLabel,
      source: b.source,
      kind: "bus" as const,
    }));

  return {
    items: [...subway, ...bus],
    meta: pilot.sources,
    usedPilot: true,
  };
}

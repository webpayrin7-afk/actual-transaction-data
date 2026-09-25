/**
 * 잠실엘스 pilot — bus routes serving nearby official stops.
 * Source extract from OA-1095 서울시버스노선별정류소정보(20260902).xlsx
 * Join key: NODE_ID ↔ bus stop id. No name fuzzy join.
 * Full XLSX is not committed / not bundled to client.
 */

import { readFileSync } from "fs";
import path from "path";

export type SeoulBusRouteRow = {
  routeId: string;
  routeNumber: string;
  routeType: string | null;
};

type BusRoutePilotArtifact = {
  routesByStopId: Record<string, SeoulBusRouteRow[]>;
  routesByArsNo?: Record<string, SeoulBusRouteRow[]>;
  source?: {
    dataset?: string;
    datasetId?: string;
    file?: string;
    fileDate?: string;
    sourceVersion?: string;
  };
  joinKey?: string;
  stats?: Record<string, number>;
};

const ARTIFACT = path.join(
  "data",
  "poc",
  "nearby-transport",
  "jamsil-els-bus-routes.json",
);

let cache: BusRoutePilotArtifact | null | undefined;

export function loadJamsilElsBusRoutePilot(): BusRoutePilotArtifact | null {
  if (cache !== undefined) return cache;
  try {
    const raw = readFileSync(path.join(process.cwd(), ARTIFACT), "utf8");
    cache = JSON.parse(raw) as BusRoutePilotArtifact;
  } catch {
    cache = null;
  }
  return cache;
}

export function routesForSeoulBusStop(opts: {
  stopId: string;
  arsNo?: string | null;
}): SeoulBusRouteRow[] {
  const pilot = loadJamsilElsBusRoutePilot();
  if (!pilot?.routesByStopId) return [];
  const byId = pilot.routesByStopId[opts.stopId];
  if (byId?.length) return byId;
  const ars = opts.arsNo?.trim();
  if (ars && pilot.routesByArsNo?.[ars]?.length) {
    return pilot.routesByArsNo[ars];
  }
  // Official join is NODE_ID, then ARS. Do not fuzzy-match by stop name.
  return [];
}

export function seoulBusRoutePilotMeta(): BusRoutePilotArtifact["source"] | null {
  return loadJamsilElsBusRoutePilot()?.source ?? null;
}

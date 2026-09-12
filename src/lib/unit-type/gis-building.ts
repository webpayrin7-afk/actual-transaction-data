/**
 * Local MOLIT GIS건물통합정보 join helpers.
 *
 * Expects cached shapefiles under data/cache/gis-building/** (Seoul/Gyeonggi only).
 * No external geocoder calls.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

export const GIS_GEO_DATA_VERSION = 1;
export const GIS_SOURCE = "MOLIT_GIS_BUILDING";

export type GisJoinClass =
  | "EXACT-PARCEL"
  | "MULTI-BUILDING-PARCEL"
  | "NO-MATCH"
  | "AMBIGUOUS";

export type GisBuildingFeature = {
  pnu: string;
  /** Polygon rings in EPSG:4326 as [lng, lat][]. */
  rings4326: number[][][];
  attrs: Record<string, unknown>;
};

export type GisMatchResult = {
  joinClass: GisJoinClass;
  reasonCode: string | null;
  geometryCount: number;
  latitude: number | null;
  longitude: number | null;
  matchMethod: string | null;
  parcelId: string | null;
  confidence: "high" | "medium" | "low" | null;
};

/** Seoul / Gyeonggi loose WGS84 bounds. */
export function inSeoulGyeonggiBounds(lat: number, lng: number): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat === 0 && lng === 0) return false;
  return lat >= 36.8 && lat <= 38.4 && lng >= 126.3 && lng <= 127.9;
}

function pointInRing(lng: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersect =
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi + 0.0) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function ringArea(ring: number[][]): number {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return Math.abs(a) / 2;
}

function ringCentroid(ring: number[][]): { lng: number; lat: number } {
  let x = 0;
  let y = 0;
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const cross = ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    x += (ring[i][0] + ring[i + 1][0]) * cross;
    y += (ring[i][1] + ring[i + 1][1]) * cross;
    a += cross;
  }
  if (Math.abs(a) < 1e-18) {
    const n = Math.max(ring.length - 1, 1);
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < n; i++) {
      sx += ring[i][0];
      sy += ring[i][1];
    }
    return { lng: sx / n, lat: sy / n };
  }
  return { lng: x / (3 * a), lat: y / (3 * a) };
}

/**
 * Reproducible representative point for matched building polygons.
 * Prefer largest-ring centroid when on-surface; otherwise first vertex
 * of that ring (always on boundary / on surface).
 */
export function representativePoint4326(
  rings4326: number[][][],
): { latitude: number; longitude: number; method: string } | null {
  const rings = rings4326.filter((r) => r && r.length >= 3);
  if (rings.length === 0) return null;
  let best = rings[0];
  let bestArea = ringArea(best);
  for (const r of rings.slice(1)) {
    const a = ringArea(r);
    if (a > bestArea) {
      best = r;
      bestArea = a;
    }
  }
  const c = ringCentroid(best);
  if (pointInRing(c.lng, c.lat, best)) {
    return {
      latitude: c.lat,
      longitude: c.lng,
      method: "largest_ring_centroid_on_surface",
    };
  }
  return {
    latitude: best[0][1],
    longitude: best[0][0],
    method: "largest_ring_vertex0_on_surface",
  };
}

export function listShapefileBases(rootDir: string): string[] {
  if (!existsSync(rootDir)) return [];
  const out: string[] = [];
  const stack = [rootDir];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) stack.push(p);
      else if (extname(name).toLowerCase() === ".shp") out.push(p.slice(0, -4));
    }
  }
  return out.sort();
}

export type GisCacheManifest = {
  source: string;
  versionDate: string | null;
  license: string;
  originalCrs: string | null;
  shapefileCount: number;
  notes: string[];
};

export function readGisCacheManifest(rootDir: string): GisCacheManifest {
  const sourcePath = join(rootDir, "SOURCE.txt");
  const notes: string[] = [];
  let versionDate: string | null = null;
  let license = "공공누리 제1유형 (출처표시) — expected";
  let originalCrs: string | null = null;
  if (existsSync(sourcePath)) {
    const text = readFileSync(sourcePath, "utf8");
    const vd = text.match(/Dataset Version:\s*(\S+)/);
    if (vd) versionDate = vd[1];
    if (/제\s*1유형|Type 1|공공누리/i.test(text)) {
      license = "공공누리 제1유형 (출처표시)";
    }
    const crs = text.match(/EPSG:\s*(\d+)/i);
    if (crs) originalCrs = `EPSG:${crs[1]}`;
    notes.push("SOURCE.txt present");
  } else {
    notes.push("SOURCE.txt missing");
  }
  return {
    source: GIS_SOURCE,
    versionDate,
    license,
    originalCrs,
    shapefileCount: listShapefileBases(rootDir).length,
    notes,
  };
}

/** Detect PNU-like 19-digit field from shapefile attributes. */
export function detectPnu(attrs: Record<string, unknown>): string | null {
  const preferred = ["PNU", "pnu", "A2", "a2", "고유번호", "PNU_CD", "BD_PNU"];
  for (const k of preferred) {
    if (k in attrs) {
      const v = String(attrs[k] ?? "").trim();
      if (/^\d{19}$/.test(v)) return v;
    }
  }
  for (const [k, raw] of Object.entries(attrs)) {
    const v = String(raw ?? "").trim();
    if (/^\d{19}$/.test(v) && /pnu|고유|필지|a2/i.test(k)) return v;
  }
  for (const raw of Object.values(attrs)) {
    const v = String(raw ?? "").trim();
    if (/^\d{19}$/.test(v)) return v;
  }
  return null;
}

export function matchParcelToBuildings(
  pnu: string,
  byPnu: Map<string, GisBuildingFeature[]>,
): GisMatchResult {
  const feats = byPnu.get(pnu) ?? [];
  if (feats.length === 0) {
    return {
      joinClass: "NO-MATCH",
      reasonCode: "PNU_NOT_IN_GIS",
      geometryCount: 0,
      latitude: null,
      longitude: null,
      matchMethod: null,
      parcelId: pnu,
      confidence: null,
    };
  }
  const rings = feats.flatMap((f) => f.rings4326);
  const pt = representativePoint4326(rings);
  if (!pt) {
    return {
      joinClass: "AMBIGUOUS",
      reasonCode: "GEOMETRY_EMPTY",
      geometryCount: feats.length,
      latitude: null,
      longitude: null,
      matchMethod: null,
      parcelId: pnu,
      confidence: "low",
    };
  }
  if (!inSeoulGyeonggiBounds(pt.latitude, pt.longitude)) {
    return {
      joinClass: "AMBIGUOUS",
      reasonCode: "OUT_OF_BOUNDS",
      geometryCount: feats.length,
      latitude: pt.latitude,
      longitude: pt.longitude,
      matchMethod: pt.method,
      parcelId: pnu,
      confidence: "low",
    };
  }
  return {
    joinClass: feats.length === 1 ? "EXACT-PARCEL" : "MULTI-BUILDING-PARCEL",
    reasonCode: null,
    geometryCount: feats.length,
    latitude: pt.latitude,
    longitude: pt.longitude,
    matchMethod: pt.method,
    parcelId: pnu,
    confidence: "high",
  };
}

export function provenanceMeta(input: {
  datasetVersion: string | null;
  originalCrs: string | null;
  match: GisMatchResult;
}): string {
  return JSON.stringify({
    dataset: GIS_SOURCE,
    dataset_version: input.datasetVersion,
    original_crs: input.originalCrs,
    match_method: input.match.matchMethod,
    matched_parcel_id: input.match.parcelId,
    geometry_count: input.match.geometryCount,
    join_class: input.match.joinClass,
    confidence: input.match.confidence,
    attribution: "국토교통부 GIS건물통합정보 (공공누리 제1유형 출처표시)",
  });
}

export function stableCoordKey(lat: number, lng: number): string {
  return `${lat.toFixed(6)},${lng.toFixed(6)}`;
}

export function sha1Short(s: string): string {
  return createHash("sha1").update(s).digest("hex").slice(0, 12);
}

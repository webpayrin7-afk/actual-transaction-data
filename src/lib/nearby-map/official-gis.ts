/**
 * Official-GIS-derived complex representative point (Phase 8.1b).
 *
 * Coordinate priority (see geocode.ts):
 *   1. apt_complex_master validated lat/lng
 *   2. official GIS-derived representative point  ← this module
 *      a) experiments/nearby-map/pilot-complex-coordinates.json (tiny pre-derived)
 *      b) live derive from Phase2 GeoJSON if present in checkout
 *   3. VWorld geocode fallback
 *   4. UNAVAILABLE
 *
 * Phase2 source (do NOT commit full polygon set to app public/data):
 *   experiments/3d-city-map/public/data/phase2-visible.geojson
 * Regenerator:
 *   scripts/build-pilot-complex-coordinate.mjs
 *
 * Method (deterministic, vendor-independent):
 *   verified residential/DONG-EXACT building polygons for complex_id
 *   → largest exterior ring
 *   → centroid if on-surface, else ring vertex0
 *
 * Classification: OFFICIAL-GIS-DERIVED
 * Does NOT write production DB.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { JAMSIL_ELS_MAP_PILOT } from "@/lib/nearby-map/jamsil-els-pilot";
import type { LatLng } from "@/lib/nearby-map/geo";

export type OfficialGisCoordinateResult = {
  ok: boolean;
  coordinate: LatLng | null;
  source: "official_gis_derived" | "unavailable";
  classification: "OFFICIAL-GIS-DERIVED" | "UNAVAILABLE";
  accuracy: "building" | "none";
  method: string | null;
  sourceArtifact: string | null;
  polygonCount: number;
  note: string;
  complexId: string;
};

type Ring = number[][]; // [lng, lat][]

type GjGeometry = { type: string; coordinates?: unknown };
type GjFeature = {
  geometry?: GjGeometry | null;
  properties?: Record<string, unknown> | null;
};
type GjCollection = { features?: GjFeature[] };

type LinkageBuilding = {
  featureId?: string;
  id?: string;
  complexId?: string;
  complex_id?: string;
  verified?: boolean;
};

type LinkageDoc = {
  complexId?: string;
  complex_id?: string;
  buildings?: LinkageBuilding[];
  featureIds?: string[];
  buildingFeatureIds?: string[];
  [key: string]: unknown;
};

const PILOT_COORDINATE_ARTIFACT =
  "experiments/nearby-map/pilot-complex-coordinates.json";

const ARTIFACT_CANDIDATES = [
  "experiments/3d-city-map/public/data/phase2-visible.geojson",
  "experiments/3d-city-map/public/data/phase2-visible.geojson",
  "experiments/3d-city-map/public/data/complex-building-linkage.json",
  "public/data/phase2-visible.geojson",
  "public/data/complex-building-linkage.json",
  "data/gis/jamsil-els-buildings.geojson",
  "data/gis/complex-building-linkage.json",
] as const;

type PilotCoordinateRow = {
  complex_id?: string;
  apt_name?: string;
  lat?: number;
  lng?: number;
  coordinate_source?: string;
  source_dataset?: string;
  source_artifact?: string;
  method?: string;
  polygon_count?: number;
};

function pointInRing(lng: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersect =
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function ringArea(ring: Ring): number {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return Math.abs(a) / 2;
}

function ringCentroid(ring: Ring): LatLng | null {
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
    const lng = sx / n;
    const lat = sy / n;
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  }
  const lng = x / (3 * a);
  const lat = y / (3 * a);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

function asRing(coords: unknown): Ring | null {
  if (!Array.isArray(coords) || coords.length < 3) return null;
  const ring: Ring = [];
  for (const p of coords) {
    if (!Array.isArray(p) || p.length < 2) return null;
    const lng = Number(p[0]);
    const lat = Number(p[1]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
    ring.push([lng, lat]);
  }
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    ring.push([first[0], first[1]]);
  }
  return ring.length >= 4 ? ring : null;
}

function exteriorRings(geometry: GjGeometry | null | undefined): Ring[] {
  if (!geometry?.coordinates) return [];
  const c = geometry.coordinates;
  if (geometry.type === "Polygon") {
    const ring = asRing(Array.isArray(c) ? c[0] : null);
    return ring ? [ring] : [];
  }
  if (geometry.type === "MultiPolygon" && Array.isArray(c)) {
    const out: Ring[] = [];
    for (const poly of c) {
      const ring = asRing(Array.isArray(poly) ? poly[0] : null);
      if (ring) out.push(ring);
    }
    return out;
  }
  return [];
}

export function representativePointFromRings(rings: Ring[]): {
  coordinate: LatLng;
  method: string;
} | null {
  const usable = rings.filter((r) => r.length >= 4);
  if (usable.length === 0) return null;
  let best = usable[0];
  let bestArea = ringArea(best);
  for (const r of usable.slice(1)) {
    const a = ringArea(r);
    if (a > bestArea) {
      best = r;
      bestArea = a;
    }
  }
  const c = ringCentroid(best);
  if (c && pointInRing(c.lng, c.lat, best)) {
    return {
      coordinate: c,
      method:
        "union-of-verified-building-polygons → largest-ring centroid (point-on-surface)",
    };
  }
  return {
    coordinate: { lat: best[0][1], lng: best[0][0] },
    method:
      "union-of-verified-building-polygons → largest-ring vertex0 (on-boundary fallback)",
  };
}

function featureMatchesComplex(
  feature: GjFeature,
  complexId: string,
  allowedFeatureIds: Set<string> | null
): boolean {
  const props = feature.properties ?? {};
  const ids = [
    props.complex_id,
    props.complexId,
    props.complexID,
    props.COMPLEX_ID,
  ]
    .map((v) => (v == null ? "" : String(v)))
    .filter(Boolean);
  const featureIds = [
    props.id,
    props.feature_id,
    props.featureId,
    props.building_id,
    props.BUILDING_ID,
    props.UFID,
    props.A1,
  ]
    .map((v) => (v == null ? "" : String(v)))
    .filter(Boolean);

  if (allowedFeatureIds && allowedFeatureIds.size > 0) {
    if (featureIds.some((id) => allowedFeatureIds.has(id))) return true;
    if (ids.includes(complexId) && featureIds.length === 0) return true;
    return false;
  }
  return ids.includes(complexId);
}

function isResidentialBuildingFeature(feature: GjFeature): boolean {
  const props = feature.properties ?? {};
  const verified = props.verified;
  if (verified === false || verified === "false" || verified === 0) return false;

  const use = String(
    props.use ??
      props.building_use ??
      props.BDTYP_NM ??
      props.mainPurpsCdNm ??
      ""
  );
  const kind = String(
    props.kind ?? props.type ?? props.feature_type ?? ""
  ).toLowerCase();
  const building = props.building ?? props.is_building ?? props.residential;

  if (building === false || building === "false") return false;
  if (kind.includes("poi") || kind.includes("road")) return false;
  if (
    use &&
    /(주차장|부대|근생|판매|업무|숙박|공장|창고|공공)/.test(use) &&
    !/(공동주택|아파트|주택|기숙)/.test(use)
  ) {
    return false;
  }
  return true;
}

async function readJsonIfExists(relPath: string): Promise<unknown | null> {
  try {
    const text = await readFile(join(process.cwd(), relPath), "utf8");
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function parseLinkage(doc: unknown, complexId: string): Set<string> | null {
  if (!doc || typeof doc !== "object") return null;

  if (Array.isArray(doc)) {
    const ids = new Set<string>();
    for (const row of doc as LinkageBuilding[]) {
      const cid = String(row.complex_id ?? row.complexId ?? "");
      if (cid && cid !== complexId) continue;
      const fid = row.featureId ?? row.id;
      if (fid) ids.add(String(fid));
    }
    return ids.size ? ids : null;
  }

  const root = doc as LinkageDoc;
  const cid = String(root.complex_id ?? root.complexId ?? "");
  if (cid && cid !== complexId) {
    const keyed = root[complexId];
    if (keyed && typeof keyed === "object") return parseLinkage(keyed, complexId);
    return null;
  }

  const ids = new Set<string>();
  for (const fid of [
    ...(root.featureIds ?? []),
    ...(root.buildingFeatureIds ?? []),
  ]) {
    ids.add(String(fid));
  }
  for (const b of root.buildings ?? []) {
    const bcid = String(b.complex_id ?? b.complexId ?? cid ?? complexId);
    if (bcid !== complexId) continue;
    if (b.verified === false) continue;
    const fid = b.featureId ?? b.id;
    if (fid) ids.add(String(fid));
  }
  return ids.size ? ids : null;
}

function collectRings(
  geojson: GjCollection,
  complexId: string,
  allowedFeatureIds: Set<string> | null
): Ring[] {
  const rings: Ring[] = [];
  for (const feature of geojson.features ?? []) {
    if (!featureMatchesComplex(feature, complexId, allowedFeatureIds)) continue;
    if (!isResidentialBuildingFeature(feature)) continue;
    rings.push(...exteriorRings(feature.geometry));
  }
  return rings;
}

async function fromPilotCoordinateArtifact(
  complexId: string
): Promise<OfficialGisCoordinateResult | null> {
  const data = await readJsonIfExists(PILOT_COORDINATE_ARTIFACT);
  if (data == null) return null;
  const rows = Array.isArray(data) ? data : [data];
  for (const raw of rows) {
    const row = raw as PilotCoordinateRow;
    if (String(row.complex_id ?? "") !== complexId) continue;
    const lat = Number(row.lat);
    const lng = Number(row.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) < 1) {
      continue;
    }
    if (row.coordinate_source && row.coordinate_source !== "OFFICIAL-GIS-DERIVED") {
      continue;
    }
    return {
      ok: true,
      coordinate: { lat, lng },
      source: "official_gis_derived",
      classification: "OFFICIAL-GIS-DERIVED",
      accuracy: "building",
      method:
        row.method ??
        "pilot artifact from Phase2 official GIS (see scripts/build-pilot-complex-coordinate.mjs)",
      sourceArtifact: PILOT_COORDINATE_ARTIFACT,
      polygonCount: Number(row.polygon_count) || 0,
      note: `Pilot OFFICIAL-GIS-DERIVED artifact ${PILOT_COORDINATE_ARTIFACT} (source_dataset=${row.source_dataset ?? "n/a"}; source_artifact=${row.source_artifact ?? "n/a"})`,
      complexId,
    };
  }
  return null;
}

/** Derive 잠실엘스 point from official GIS artifacts — never invents. */
export async function deriveJamsilElsOfficialGisCoordinate(): Promise<OfficialGisCoordinateResult> {
  const complexId = JAMSIL_ELS_MAP_PILOT.complexId;

  const pilot = await fromPilotCoordinateArtifact(complexId);
  if (pilot?.ok && pilot.coordinate) return pilot;

  const foundArtifacts: string[] = [];
  let linkageIds: Set<string> | null = null;
  let geojson: GjCollection | null = null;
  let geoArtifact: string | null = null;

  for (const rel of ARTIFACT_CANDIDATES) {
    const data = await readJsonIfExists(rel);
    if (data == null) continue;
    foundArtifacts.push(rel);
    if (
      rel.endsWith(".geojson") ||
      rel.includes("visible") ||
      rel.includes("buildings")
    ) {
      if (
        data &&
        typeof data === "object" &&
        Array.isArray((data as GjCollection).features)
      ) {
        geojson = data as GjCollection;
        geoArtifact = rel;
      }
    }
    if (rel.includes("linkage")) {
      linkageIds = parseLinkage(data, complexId) ?? linkageIds;
    }
  }

  if (!geojson) {
    return {
      ok: false,
      coordinate: null,
      source: "unavailable",
      classification: "UNAVAILABLE",
      accuracy: "none",
      method: null,
      sourceArtifact: foundArtifacts[0] ?? null,
      polygonCount: 0,
      note:
        foundArtifacts.length === 0
          ? `Official GIS artifacts missing. Looked for pilot JSON (${PILOT_COORDINATE_ARTIFACT}) and Phase2 GeoJSON (${ARTIFACT_CANDIDATES.join(", ")}). Run: PHASE2_VISIBLE_GEOJSON=<path-to-phase2-visible.geojson> node scripts/build-pilot-complex-coordinate.mjs — then commit only the tiny pilot JSON. VWorld GIS건물통합정보 (dsId=18) HTTP 502. Refusing to invent coordinates.`
          : `Found non-geometry artifact(s): ${foundArtifacts.join(", ")} but no FeatureCollection with building polygons for ${complexId}`,
      complexId,
    };
  }

  const rings = collectRings(geojson, complexId, linkageIds);
  if (rings.length === 0) {
    return {
      ok: false,
      coordinate: null,
      source: "unavailable",
      classification: "UNAVAILABLE",
      accuracy: "none",
      method: null,
      sourceArtifact: geoArtifact,
      polygonCount: 0,
      note: `GeoJSON loaded from ${geoArtifact} but no verified residential/building polygons matched complex_id=${complexId}`,
      complexId,
    };
  }

  const rep = representativePointFromRings(rings);
  if (!rep) {
    return {
      ok: false,
      coordinate: null,
      source: "unavailable",
      classification: "UNAVAILABLE",
      accuracy: "none",
      method: null,
      sourceArtifact: geoArtifact,
      polygonCount: rings.length,
      note: "Polygons found but representative point derivation failed",
      complexId,
    };
  }

  return {
    ok: true,
    coordinate: rep.coordinate,
    source: "official_gis_derived",
    classification: "OFFICIAL-GIS-DERIVED",
    accuracy: "building",
    method: rep.method,
    sourceArtifact: geoArtifact,
    polygonCount: rings.length,
    note: `Derived from ${geoArtifact} · ${rings.length} building ring(s) · ${rep.method}`,
    complexId,
  };
}

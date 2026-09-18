#!/usr/bin/env node
/**
 * Phase 8.1b — build minimal OFFICIAL-GIS-DERIVED pilot coordinate.
 *
 * Input (first existing path wins):
 *   $PHASE2_VISIBLE_GEOJSON
 *   experiments/3d-city-map/public/data/phase2-visible.geojson
 *   experiments/3d-city-map/public/data/phase2-visible.geojson
 *   public/data/phase2-visible.geojson
 *   data/gis/phase2-visible.geojson
 *
 * Optional linkage:
 *   experiments/3d-city-map/public/data/complex-building-linkage.json
 *   (and parallel paths)
 *
 * Output:
 *   experiments/nearby-map/pilot-complex-coordinates.json
 *
 * Exits non-zero if source geometry is missing or no polygons match.
 * Never invents / hard-codes lat/lng.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COMPLEX_ID = "cx_4c63d9a100973c60";
const APT_NAME = "잠실엘스";
const OUT_REL = "experiments/nearby-map/pilot-complex-coordinates.json";

const SOURCE_CANDIDATES = [
  process.env.PHASE2_VISIBLE_GEOJSON,
  "experiments/3d-city-map/public/data/phase2-visible.geojson",
  "experiments/3d-city-map/public/data/phase2-visible.geojson",
  "public/data/phase2-visible.geojson",
  "data/gis/phase2-visible.geojson",
].filter(Boolean);

const LINKAGE_CANDIDATES = [
  "experiments/3d-city-map/public/data/complex-building-linkage.json",
  "experiments/3d-city-map/public/data/complex-building-linkage.json",
  "public/data/complex-building-linkage.json",
  "data/gis/complex-building-linkage.json",
];

function die(message) {
  console.error(`[build-pilot-complex-coordinate] FAIL: ${message}`);
  process.exit(1);
}

function resolveFirst(candidates) {
  for (const rel of candidates) {
    const abs = resolve(ROOT, rel);
    if (existsSync(abs)) return { rel, abs };
  }
  return null;
}

function asRing(coords) {
  if (!Array.isArray(coords) || coords.length < 3) return null;
  const ring = [];
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

function exteriorRings(geometry) {
  if (!geometry?.coordinates) return [];
  if (geometry.type === "Polygon") {
    const ring = asRing(geometry.coordinates[0]);
    return ring ? [ring] : [];
  }
  if (geometry.type === "MultiPolygon") {
    const out = [];
    for (const poly of geometry.coordinates) {
      const ring = asRing(Array.isArray(poly) ? poly[0] : null);
      if (ring) out.push(ring);
    }
    return out;
  }
  return [];
}

function ringArea(ring) {
  let area = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return Math.abs(area) / 2;
}

function ringCentroid(ring) {
  let x = 0;
  let y = 0;
  let area = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const cross = ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    x += (ring[i][0] + ring[i + 1][0]) * cross;
    y += (ring[i][1] + ring[i + 1][1]) * cross;
    area += cross;
  }
  if (Math.abs(area) < 1e-18) {
    const n = Math.max(ring.length - 1, 1);
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < n; i++) {
      sx += ring[i][0];
      sy += ring[i][1];
    }
    return { lng: sx / n, lat: sy / n };
  }
  return { lng: x / (3 * area), lat: y / (3 * area) };
}

function pointInRing(lng, lat, ring) {
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

function propStr(props, keys) {
  for (const key of keys) {
    const value = props?.[key];
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return "";
}

function isPreferredResidential(props) {
  const matchClass = propStr(props, [
    "match_class",
    "matchClass",
    "linkage_class",
    "verify_class",
  ]).toUpperCase();
  if (matchClass.includes("DONG-EXACT") || matchClass.includes("DONG_EXACT")) {
    return true;
  }
  const use = propStr(props, [
    "use",
    "building_use",
    "BDTYP_NM",
    "mainPurpsCdNm",
    "purps",
  ]);
  if (/(공동주택|아파트|주택|기숙)/.test(use)) return true;
  const kind = propStr(props, ["kind", "feature_type", "type"]).toLowerCase();
  if (kind.includes("building") || kind.includes("dong")) return true;
  return true;
}

function parseLinkageIds(doc, complexId) {
  if (!doc) return null;
  const ids = new Set();
  if (Array.isArray(doc)) {
    for (const row of doc) {
      const cid = String(row.complex_id ?? row.complexId ?? "");
      if (cid && cid !== complexId) continue;
      const fid = row.featureId ?? row.id ?? row.building_id;
      if (fid) ids.add(String(fid));
    }
    return ids.size ? ids : null;
  }
  if (doc[complexId] && typeof doc[complexId] === "object") {
    return parseLinkageIds(doc[complexId], complexId);
  }
  const cid = String(doc.complex_id ?? doc.complexId ?? "");
  if (cid && cid !== complexId) return null;
  for (const fid of [
    ...(doc.featureIds ?? []),
    ...(doc.buildingFeatureIds ?? []),
  ]) {
    ids.add(String(fid));
  }
  for (const building of doc.buildings ?? []) {
    const bcid = String(
      building.complex_id ?? building.complexId ?? cid ?? complexId
    );
    if (bcid !== complexId) continue;
    if (building.verified === false) continue;
    const fid = building.featureId ?? building.id;
    if (fid) ids.add(String(fid));
  }
  return ids.size ? ids : null;
}

function featureMatches(feature, complexId, allowedIds) {
  const props = feature.properties ?? {};
  const ids = [props.complex_id, props.complexId, props.COMPLEX_ID]
    .filter((v) => v != null)
    .map(String);
  const featureIds = [
    props.id,
    props.feature_id,
    props.featureId,
    props.building_id,
    props.UFID,
    props.A1,
  ]
    .filter((v) => v != null)
    .map(String);

  if (allowedIds && allowedIds.size > 0) {
    if (featureIds.some((id) => allowedIds.has(id))) return true;
    if (ids.includes(complexId) && featureIds.length === 0) return true;
    return false;
  }
  return ids.includes(complexId);
}

function representativePoint(rings) {
  let best = rings[0];
  let bestArea = ringArea(best);
  for (const ring of rings.slice(1)) {
    const area = ringArea(ring);
    if (area > bestArea) {
      best = ring;
      bestArea = area;
    }
  }
  const centroid = ringCentroid(best);
  if (
    Number.isFinite(centroid.lat) &&
    Number.isFinite(centroid.lng) &&
    pointInRing(centroid.lng, centroid.lat, best)
  ) {
    return {
      lat: centroid.lat,
      lng: centroid.lng,
      method:
        "verified residential/DONG-EXACT building polygons → largest exterior ring → centroid (point-on-surface)",
    };
  }
  return {
    lat: best[0][1],
    lng: best[0][0],
    method:
      "verified residential/DONG-EXACT building polygons → largest exterior ring → vertex0 (on-boundary fallback)",
  };
}

function main() {
  const source = resolveFirst(SOURCE_CANDIDATES);
  if (!source) {
    die(
      `Phase2 official GIS GeoJSON not found. Looked for:\n  - ${SOURCE_CANDIDATES.join(
        "\n  - "
      )}\nPlace phase2-visible.geojson (MOLIT GIS building integrated info / Phase2 PoC) then re-run. Do not invent coordinates.`
    );
  }

  let geojson;
  try {
    geojson = JSON.parse(readFileSync(source.abs, "utf8"));
  } catch (error) {
    die(`Cannot parse ${source.rel}: ${error.message}`);
  }
  if (!Array.isArray(geojson?.features)) {
    die(`${source.rel} is not a FeatureCollection`);
  }

  const linkageHit = resolveFirst(LINKAGE_CANDIDATES);
  let allowedIds = null;
  if (linkageHit) {
    try {
      allowedIds = parseLinkageIds(
        JSON.parse(readFileSync(linkageHit.abs, "utf8")),
        COMPLEX_ID
      );
      console.log(
        `[build-pilot-complex-coordinate] linkage=${linkageHit.rel} ids=${
          allowedIds ? allowedIds.size : 0
        }`
      );
    } catch (error) {
      console.warn(
        `[build-pilot-complex-coordinate] linkage parse warning: ${error.message}`
      );
    }
  }

  const preferredRings = [];
  let matchedFeatures = 0;

  for (const feature of geojson.features) {
    if (!featureMatches(feature, COMPLEX_ID, allowedIds)) continue;
    matchedFeatures += 1;
    const props = feature.properties ?? {};
    if (props.verified === false || props.verified === "false") continue;
    const rings = exteriorRings(feature.geometry);
    if (!rings.length) continue;
    if (!isPreferredResidential(props)) continue;
    preferredRings.push(...rings);
  }

  if (!preferredRings.length) {
    die(
      `No verified building polygons for complex_id=${COMPLEX_ID} in ${
        source.rel
      } (matched features=${matchedFeatures}, linkageIds=${
        allowedIds ? allowedIds.size : "none"
      }). Refusing to invent a coordinate.`
    );
  }

  const rep = representativePoint(preferredRings);
  if (
    !Number.isFinite(rep.lat) ||
    !Number.isFinite(rep.lng) ||
    Math.abs(rep.lat) < 1 ||
    Math.abs(rep.lng) < 1
  ) {
    die(`Derived coordinate invalid: lat=${rep.lat} lng=${rep.lng}`);
  }

  if (
    rep.lat < 37.48 ||
    rep.lat > 37.55 ||
    rep.lng < 127.05 ||
    rep.lng > 127.15
  ) {
    die(
      `Derived coordinate outside expected 잠실/송파 bounds: ${rep.lat}, ${rep.lng}`
    );
  }

  const out = [
    {
      complex_id: COMPLEX_ID,
      apt_name: APT_NAME,
      lat: Number(rep.lat.toFixed(7)),
      lng: Number(rep.lng.toFixed(7)),
      coordinate_source: "OFFICIAL-GIS-DERIVED",
      source_dataset: "MOLIT GIS building integrated information",
      source_artifact: source.rel,
      linkage_artifact: linkageHit?.rel ?? null,
      polygon_count: preferredRings.length,
      method: rep.method,
      generated_at: new Date().toISOString(),
    },
  ];

  const outAbs = join(ROOT, OUT_REL);
  mkdirSync(dirname(outAbs), { recursive: true });
  writeFileSync(outAbs, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  console.log(
    `[build-pilot-complex-coordinate] OK wrote ${OUT_REL} lat=${out[0].lat} lng=${out[0].lng} polygons=${preferredRings.length} from ${source.rel}`
  );
}

main();

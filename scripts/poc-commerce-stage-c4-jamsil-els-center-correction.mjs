#!/usr/bin/env node
/**
 * Commerce Stage C4 — 잠실엘스 center correction.
 *
 * Root cause: CENTER_MISMATCH — commerce pilot center (37.5133/127.1028)
 * ≠ product mapAnchor NAVER_GEOCODE (37.5133051/127.0815962) ≈ 1872m.
 *
 * Recomputes P0/P2/composition/facilities/TOP5 + actual P2 map points
 * using the product canonical center. Taxonomy unchanged.
 *
 * Usage:
 *   SEMAS_SEOUL_CSV=/path/to/서울_202606.csv \
 *     node scripts/poc-commerce-stage-c4-jamsil-els-center-correction.mjs
 */

import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import {
  SOURCE,
  SOURCE_PERIOD,
  SOURCE_DATE,
  RADIUS_M,
  POPULATION_VERSION,
  POPULATION_RULE_VERSION,
  aggregateCommerceSnapshots,
  haversineMeters,
} from "./lib/commerce-semas-snapshot-transform.mjs";
import {
  toLocalMeters,
  fromLocalMeters,
} from "./lib/commerce-semas-p2-points.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "data/poc/commerce");
const OUT_REPORT = join(OUT_DIR, "stage-c4-jamsil-els-center-correction.json");
const OUT_POINTS = join(OUT_DIR, "stage-c4-jamsil-els-map-points.json");
const OUT_APP_POINTS = join(
  ROOT,
  "src/lib/complex-detail/jamsil-els-commerce-map-points.json",
);

/** Legacy commerce / U3 center (LEGACY_PILOT_CENTER_RESULT). */
const LEGACY = {
  lat: 37.5133,
  lng: 127.1028,
  p0: 5904,
  p2: 4381,
  coordinateSource: "c1_verified_pilot_center",
};

/**
 * Product mapAnchor snapshot (resolveComplexMapAnchor → NAVER_GEOCODE).
 * Keep in sync with src/lib/nearby-map/jamsil-els-canonical-center.ts
 */
const CANONICAL = {
  complex_id: "cx_4c63d9a100973c60",
  name: "잠실엘스",
  lat: 37.5133051,
  lng: 127.0815962,
  coordinateSource: "product_map_anchor_naver_geocode",
  anchorType: "NAVER_GEOCODE",
  addressUsed: "서울특별시 송파구 올림픽로 99",
};

const RADIUS_TOLERANCE_M = 1.5;
const ENCODING = "meter-offset-int-v1";

function hav(a, b) {
  return haversineMeters(a.lat, a.lng, b.lat, b.lng);
}

async function collectP2Points(csvPath, origin) {
  const { createReadStream } = await import("node:fs");
  const { createInterface } = await import("node:readline");
  const { parseCsvLine, inP2 } = await import(
    "./lib/commerce-semas-snapshot-transform.mjs"
  );

  const dlat = 1.2 / 111;
  const dlng = 1.2 / (111 * Math.cos((origin.lat * Math.PI) / 180));
  const bbox = [
    origin.lat - dlat,
    origin.lat + dlat,
    origin.lng - dlng,
    origin.lng + dlng,
  ];

  const seen = new Set();
  const points = [];
  let header = null;
  const idx = {};
  let rows = 0;
  let maxDist = 0;
  let outside = 0;

  const rl = createInterface({
    input: createReadStream(csvPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!header) {
      header = parseCsvLine(line);
      for (const name of [
        "상가업소번호",
        "상권업종대분류코드",
        "상권업종중분류코드",
        "경도",
        "위도",
      ]) {
        idx[name] = header.indexOf(name);
        if (idx[name] < 0) throw new Error(`Missing column: ${name}`);
      }
      continue;
    }
    if (!line.trim()) continue;
    rows += 1;
    const cols = parseCsvLine(line);
    const lat = Number(cols[idx["위도"]]);
    const lng = Number(cols[idx["경도"]]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (lat < bbox[0] || lat > bbox[1] || lng < bbox[2] || lng > bbox[3]) {
      continue;
    }
    const l = cols[idx["상권업종대분류코드"]];
    const m = cols[idx["상권업종중분류코드"]];
    if (!inP2(l, m)) continue;
    const dist = haversineMeters(origin.lat, origin.lng, lat, lng);
    if (dist > RADIUS_M) continue;
    const id = cols[idx["상가업소번호"]];
    if (seen.has(id)) continue;
    seen.add(id);
    if (dist > maxDist) maxDist = dist;
    points.push({ lat, lng, dist });
  }

  return {
    points,
    sourceRows: rows,
    uniqueIds: seen.size,
    maxDist,
    outside,
  };
}

async function main() {
  const csvPath = resolve(process.argv[2] || process.env.SEMAS_SEOUL_CSV || "");
  if (!csvPath || !existsSync(csvPath)) {
    console.error(
      "Usage: SEMAS_SEOUL_CSV=/path/to/서울.csv node scripts/poc-commerce-stage-c4-jamsil-els-center-correction.mjs",
    );
    process.exit(1);
  }

  const offsetM = Number(hav(LEGACY, CANONICAL).toFixed(1));
  console.error(
    `[c4] CENTER_MISMATCH legacy=${LEGACY.lat},${LEGACY.lng} canonical=${CANONICAL.lat},${CANONICAL.lng} offsetM=${offsetM}`,
  );

  console.error("[c4] aggregating P0/P2/composition/facilities/TOP5…");
  const t0 = Date.now();
  const agg = await aggregateCommerceSnapshots(csvPath, [CANONICAL], {
    onProgress: (n) => console.error(`[c4] rows ${n}`),
  });
  const snap = agg.snapshots[0];
  console.error(
    `[c4] P0=${snap.p0Total} P2=${snap.p2Total} (legacy P0=${LEGACY.p0} P2=${LEGACY.p2})`,
  );

  console.error("[c4] collecting actual P2 map points…");
  const collected = await collectP2Points(csvPath, CANONICAL);
  if (collected.uniqueIds !== snap.p2Total) {
    console.error(
      `[c4] HOLD point uniqueIds=${collected.uniqueIds} != snap.p2Total=${snap.p2Total}`,
    );
  }

  const oLat = CANONICAL.lat;
  const oLng = CANONICAL.lng;
  const offsetsM = [];
  let maxReconstructedDist = 0;
  let nonFinite = 0;
  let within1000 = 0;
  let outside1000 = 0;
  let maxActualDist = 0;

  for (const p of collected.points) {
    if (p.dist > maxActualDist) maxActualDist = p.dist;
    if (p.dist <= RADIUS_M + RADIUS_TOLERANCE_M) within1000 += 1;
    else outside1000 += 1;

    const { x, y } = toLocalMeters(p.lat, p.lng, oLat, oLng);
    const dx = Math.round(x);
    const dy = Math.round(y);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
      nonFinite += 1;
      continue;
    }
    offsetsM.push(dx, dy);
    const recon = fromLocalMeters(dx, dy, oLat, oLng);
    const dist = haversineMeters(oLat, oLng, recon.lat, recon.lng);
    if (dist > maxReconstructedDist) maxReconstructedDist = dist;
  }

  const pointCount = offsetsM.length / 2;
  const radiusOk = maxReconstructedDist <= RADIUS_M + RADIUS_TOLERANCE_M;
  const pointsIntegrity =
    pointCount === snap.p2Total &&
    outside1000 === 0 &&
    nonFinite === 0 &&
    radiusOk
      ? "PASS"
      : "HOLD";

  const mapPoints = {
    complexId: CANONICAL.complex_id,
    complexName: CANONICAL.name,
    source: SOURCE,
    sourcePeriod: SOURCE_PERIOD,
    sourceDate: SOURCE_DATE,
    populationVersion: POPULATION_VERSION,
    populationRuleVersion: POPULATION_RULE_VERSION,
    radiusM: RADIUS_M,
    origin: { lat: oLat, lng: oLng },
    encoding: ENCODING,
    pointCount,
    offsetsM,
  };

  const pointsArtifact = {
    stage: "C4",
    purpose: "jamsil-els-center-corrected-semas-p2-map-points",
    generatedAt: new Date().toISOString(),
    integrity: pointsIntegrity,
    rootCause: "CENTER_MISMATCH",
    canonicalCenter: {
      lat: CANONICAL.lat,
      lng: CANONICAL.lng,
      coordinateSource: CANONICAL.coordinateSource,
      anchorType: CANONICAL.anchorType,
      addressUsed: CANONICAL.addressUsed,
    },
    inputP2Count: snap.p2Total,
    uniqueSourceBusinesses: collected.uniqueIds,
    pointCount,
    offsetArrayLength: offsetsM.length,
    within1000m: within1000,
    outside1000m: outside1000,
    maxActualDistM: Number(maxActualDist.toFixed(3)),
    maxReconstructedDistM: Number(maxReconstructedDist.toFixed(3)),
    radiusToleranceM: RADIUS_TOLERANCE_M,
    nonFiniteOffsets: nonFinite,
    syntheticPoints: 0,
    businessMetadataEmbedded: false,
    timingMs: Date.now() - t0,
    sourceRows: collected.sourceRows,
    sourceFile: "소상공인시장진흥공단_상가(상권)정보_서울_202606.csv",
    mapPoints,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_POINTS, JSON.stringify(pointsArtifact) + "\n");

  const appPayload = {
    complexId: mapPoints.complexId,
    origin: mapPoints.origin,
    encoding: mapPoints.encoding,
    pointCount: mapPoints.pointCount,
    radiusM: mapPoints.radiusM,
    offsetsM: mapPoints.offsetsM,
    stage: "C4",
    coordinateSource: CANONICAL.coordinateSource,
  };
  mkdirSync(dirname(OUT_APP_POINTS), { recursive: true });
  writeFileSync(OUT_APP_POINTS, JSON.stringify(appPayload) + "\n");

  const report = {
    stage: "C4",
    purpose: "jamsil-els-commerce-center-correction",
    generatedAt: new Date().toISOString(),
    decision: "CENTER_MISMATCH",
    evidence: {
      commerceAggregationCenter: { lat: LEGACY.lat, lng: LEGACY.lng },
      mapPointOrigin: { lat: LEGACY.lat, lng: LEGACY.lng },
      productMapAnchor: { lat: CANONICAL.lat, lng: CANONICAL.lng },
      complexMarker: { lat: CANONICAL.lat, lng: CANONICAL.lng },
      referenceCircle: {
        note: "uses fitAnchor=coords (=mapAnchor) at runtime",
        lat: CANONICAL.lat,
        lng: CANONICAL.lng,
      },
      aggregationToMarkerOffsetM: offsetM,
      aggregationToMapAnchorOffsetM: offsetM,
      mapPointOriginToMarkerOffsetM: offsetM,
      referenceCircleToMarkerOffsetM: 0,
      materialToleranceM: 30,
    },
    oldCenter: LEGACY,
    canonicalProductCenter: {
      lat: CANONICAL.lat,
      lng: CANONICAL.lng,
      coordinateSource: CANONICAL.coordinateSource,
      anchorType: CANONICAL.anchorType,
      addressUsed: CANONICAL.addressUsed,
      legacyPilotOffsetM: offsetM,
    },
    oldMetrics: {
      P0: LEGACY.p0,
      P2: LEGACY.p2,
      label: "LEGACY_PILOT_CENTER_RESULT",
    },
    correctedMetrics: {
      P0: snap.p0Total,
      P2: snap.p2Total,
      P0delta: snap.p0Total - LEGACY.p0,
      P2delta: snap.p2Total - LEGACY.p2,
      p2ToP0Ratio: snap.p2ToP0Ratio,
      composition: snap.composition,
      facilities: snap.facilities,
      topCategories: snap.topCategories,
    },
    radiusIntegrity: {
      totalP2: snap.p2Total,
      within1000m: within1000,
      outside1000m: outside1000,
      maxActualDistM: Number(maxActualDist.toFixed(3)),
      maxReconstructedDistM: Number(maxReconstructedDist.toFixed(3)),
      synthetic: 0,
      integrity: pointsIntegrity,
    },
    recomputationRequired: true,
    taxonomyUnchanged: true,
    populationVersion: POPULATION_VERSION,
    sourcePeriod: SOURCE_PERIOD,
    mapPointsArtifact: "data/poc/commerce/stage-c4-jamsil-els-map-points.json",
    appMapPoints: "src/lib/complex-detail/jamsil-els-commerce-map-points.json",
    aggregationTiming: agg.timing,
    sourceRows: agg.sourceRows,
  };

  writeFileSync(OUT_REPORT, JSON.stringify(report, null, 2) + "\n");

  // Fixture values for commerce-snapshot.ts (human-readable side file)
  const fixtureHint = {
    p0Total: snap.p0Total,
    p2Total: snap.p2Total,
    composition: snap.composition,
    topCategories: snap.topCategories,
    facilities: snap.facilities,
    origin: { lat: oLat, lng: oLng },
    pointCount,
    coordinateSource: CANONICAL.coordinateSource,
    computedAt: snap.computedAt,
  };
  writeFileSync(
    join(OUT_DIR, "stage-c4-jamsil-els-fixture-values.json"),
    JSON.stringify(fixtureHint, null, 2) + "\n",
  );

  const rawBytes = statSync(OUT_POINTS).size;
  const gzipBytes = gzipSync(JSON.stringify(pointsArtifact)).length;
  console.error(
    `[c4] wrote ${OUT_REPORT}\n[c4] wrote ${OUT_POINTS} integrity=${pointsIntegrity} points=${pointCount} raw=${rawBytes} gzip~${gzipBytes}`,
  );
  console.error(
    `[c4] CORRECTED P0=${snap.p0Total} P2=${snap.p2Total} deltaP0=${snap.p0Total - LEGACY.p0} deltaP2=${snap.p2Total - LEGACY.p2}`,
  );

  if (pointsIntegrity !== "PASS") process.exit(2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

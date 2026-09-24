#!/usr/bin/env node
/**
 * Commerce Stage U3 — 잠실엘스 SEMAS P2 actual map points (compact encoding).
 *
 * Reuses collectJamsilElsP2Points (same P2 filter as U2/C3).
 * Output: meter-offset-int-v1 flattened array — no business identity.
 *
 * Usage:
 *   SEMAS_SEOUL_CSV=/path/to/서울_202606.csv \
 *     node scripts/poc-commerce-stage-u3-jamsil-els-map-points.mjs
 */

import {
  existsSync,
  mkdirSync,
  writeFileSync,
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
  haversineMeters,
} from "./lib/commerce-semas-snapshot-transform.mjs";
import {
  JAMSIL_ELS_P2_CENTER,
  collectJamsilElsP2Points,
  toLocalMeters,
  fromLocalMeters,
} from "./lib/commerce-semas-p2-points.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "data/poc/commerce");
const OUT = join(OUT_DIR, "stage-u3-jamsil-els-map-points.json");
const OUT_SRC = join(
  ROOT,
  "src/lib/complex-detail/jamsil-els-commerce-map-points.json",
);

const EXPECTED_P2 = JAMSIL_ELS_P2_CENTER.expectedP2;
const ENCODING = "meter-offset-int-v1";
/** Rounding reconstruction must stay within radius + this tolerance (m). */
const RADIUS_TOLERANCE_M = 1.5;

async function main() {
  const csvPath = resolve(process.argv[2] || process.env.SEMAS_SEOUL_CSV || "");
  if (!csvPath || !existsSync(csvPath)) {
    console.error(
      "Usage: SEMAS_SEOUL_CSV=/path/to/서울.csv node scripts/poc-commerce-stage-u3-jamsil-els-map-points.mjs",
    );
    console.error("SEMAS_SOURCE_REQUIRED");
    process.exit(1);
  }

  console.error(`[u3] collecting P2 points for ${JAMSIL_ELS_P2_CENTER.name}…`);
  const t0 = Date.now();
  const { points, sourceRows, uniqueIds } =
    await collectJamsilElsP2Points(csvPath);
  const inputP2Count = points.length;
  console.error(
    `[u3] points=${inputP2Count} uniqueIds=${uniqueIds} sourceRows=${sourceRows}`,
  );

  if (inputP2Count !== EXPECTED_P2 || uniqueIds !== EXPECTED_P2) {
    const hold = {
      stage: "U3",
      integrity: "HOLD",
      reason: `P2 points ${inputP2Count} / unique ${uniqueIds} != ${EXPECTED_P2}`,
      complexId: JAMSIL_ELS_P2_CENTER.complexId,
      inputP2Count,
      uniqueIds,
      expectedP2: EXPECTED_P2,
    };
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(OUT, JSON.stringify(hold, null, 2) + "\n");
    console.error("[u3] HOLD — P2 count mismatch");
    process.exit(2);
  }

  const { lat: oLat, lng: oLng } = JAMSIL_ELS_P2_CENTER;
  /** @type {number[]} */
  const offsetsM = [];
  let maxReconstructedDist = 0;
  let nonFinite = 0;

  for (const p of points) {
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
  const arrayLength = offsetsM.length;
  const radiusOk = maxReconstructedDist <= RADIUS_M + RADIUS_TOLERANCE_M;
  const integrity =
    pointCount === EXPECTED_P2 &&
    arrayLength === EXPECTED_P2 * 2 &&
    nonFinite === 0 &&
    radiusOk
      ? "PASS"
      : "HOLD";

  if (integrity !== "PASS") {
    console.error("[u3] HOLD — encoding integrity failed", {
      pointCount,
      arrayLength,
      nonFinite,
      maxReconstructedDist,
      radiusOk,
    });
  }

  const mapPoints = {
    complexId: JAMSIL_ELS_P2_CENTER.complexId,
    complexName: JAMSIL_ELS_P2_CENTER.name,
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

  const artifact = {
    stage: "U3",
    purpose: "jamsil-els-semas-p2-actual-map-points",
    generatedAt: new Date().toISOString(),
    integrity,
    inputP2Count,
    uniqueSourceBusinesses: uniqueIds,
    pointCount,
    offsetArrayLength: arrayLength,
    maxReconstructedDistM: Number(maxReconstructedDist.toFixed(3)),
    radiusToleranceM: RADIUS_TOLERANCE_M,
    nonFiniteOffsets: nonFinite,
    syntheticPoints: 0,
    businessMetadataEmbedded: false,
    timingMs: Date.now() - t0,
    sourceRows,
    sourceFile: "소상공인시장진흥공단_상가(상권)정보_서울_202606.csv",
    mapPoints,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT, JSON.stringify(artifact) + "\n");

  // App import source of truth (same offsets; no duplicate generation path).
  const appPayload = {
    complexId: mapPoints.complexId,
    origin: mapPoints.origin,
    encoding: mapPoints.encoding,
    pointCount: mapPoints.pointCount,
    radiusM: mapPoints.radiusM,
    offsetsM: mapPoints.offsetsM,
  };
  mkdirSync(dirname(OUT_SRC), { recursive: true });
  writeFileSync(OUT_SRC, JSON.stringify(appPayload) + "\n");

  const rawBytes = statSync(OUT).size;
  const gzipBytes = gzipSync(JSON.stringify(artifact)).length;
  const appBytes = statSync(OUT_SRC).size;
  console.error(
    `[u3] wrote ${OUT} integrity=${integrity} points=${pointCount} raw=${rawBytes} gzip~${gzipBytes} app=${appBytes} bytes/pt~${(appBytes / pointCount).toFixed(1)}`,
  );

  if (integrity !== "PASS") process.exit(2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

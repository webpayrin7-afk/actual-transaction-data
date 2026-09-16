#!/usr/bin/env node
/**
 * Commerce Stage U2 / Density D1 — 잠실엘스 P2 → 150m density cells.
 *
 * Reuses C3 frozen P2 taxonomy + haversine 1km filter from
 * scripts/lib/commerce-semas-snapshot-transform.mjs.
 *
 * Output:
 *   data/poc/commerce/stage-u2-jamsil-els-density.json
 *
 * No Production DB. No raw businesses in artifact.
 *
 * Usage:
 *   SEMAS_SEOUL_CSV=/path/to/서울_202606.csv \
 *     node scripts/poc-commerce-stage-u2-jamsil-els-density.mjs
 */

import {
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SOURCE,
  SOURCE_PERIOD,
  SOURCE_DATE,
  RADIUS_M,
  POPULATION_VERSION,
  POPULATION_RULE_VERSION,
} from "./lib/commerce-semas-snapshot-transform.mjs";
import {
  JAMSIL_ELS_P2_CENTER,
  collectJamsilElsP2Points,
  toLocalMeters,
} from "./lib/commerce-semas-p2-points.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "data/poc/commerce");
const OUT = join(OUT_DIR, "stage-u2-jamsil-els-density.json");

const GRID_SIZE_M = 150;
const EXPECTED_P2 = JAMSIL_ELS_P2_CENTER.expectedP2;

const JAMSIL_ELS = {
  complexId: JAMSIL_ELS_P2_CENTER.complexId,
  name: JAMSIL_ELS_P2_CENTER.name,
  lat: JAMSIL_ELS_P2_CENTER.lat,
  lng: JAMSIL_ELS_P2_CENTER.lng,
  coordinateSource: JAMSIL_ELS_P2_CENTER.coordinateSource,
};

function cellCenterLatLng(gridX, gridY, originLat, originLng) {
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos((originLat * Math.PI) / 180);
  const xMeters = (gridX + 0.5) * GRID_SIZE_M;
  const yMeters = (gridY + 0.5) * GRID_SIZE_M;
  return {
    lat: originLat + yMeters / mPerDegLat,
    lng: originLng + xMeters / mPerDegLng,
  };
}

function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return 0;
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1),
  );
  return sortedAsc[idx];
}

function aggregateDensity(points) {
  const { lat: oLat, lng: oLng } = JAMSIL_ELS;
  /** @type {Map<string, {gridX:number,gridY:number,count:number}>} */
  const cells = new Map();

  for (const p of points) {
    const { x, y } = toLocalMeters(p.lat, p.lng, oLat, oLng);
    const gridX = Math.floor(x / GRID_SIZE_M);
    const gridY = Math.floor(y / GRID_SIZE_M);
    const key = `${gridX}:${gridY}`;
    const existing = cells.get(key);
    if (existing) existing.count += 1;
    else cells.set(key, { gridX, gridY, count: 1 });
  }

  const cellList = [...cells.values()]
    .map((c) => {
      const center = cellCenterLatLng(c.gridX, c.gridY, oLat, oLng);
      return {
        lat: Number(center.lat.toFixed(6)),
        lng: Number(center.lng.toFixed(6)),
        count: c.count,
        gridX: c.gridX,
        gridY: c.gridY,
      };
    })
    .sort((a, b) => b.count - a.count || a.gridY - b.gridY || a.gridX - b.gridX);

  const counts = cellList.map((c) => c.count).sort((a, b) => a - b);
  const sumCellCount = cellList.reduce((s, c) => s + c.count, 0);
  const p95Count = percentile(counts, 95);
  const maxCellCount = counts.length ? counts[counts.length - 1] : 0;

  return {
    cells: cellList.map(({ lat, lng, count }) => ({ lat, lng, count })),
    cellCount: cellList.length,
    sumCellCount,
    p95Count,
    maxCellCount,
  };
}

async function main() {
  const csvPath = resolve(process.argv[2] || process.env.SEMAS_SEOUL_CSV || "");
  if (!csvPath || !existsSync(csvPath)) {
    console.error(
      "Usage: SEMAS_SEOUL_CSV=/path/to/서울.csv node scripts/poc-commerce-stage-u2-jamsil-els-density.mjs",
    );
    process.exit(1);
  }

  console.error(`[u2] streaming SEMAS → P2 1km points for ${JAMSIL_ELS.name}…`);
  const t0 = Date.now();
  const { points, sourceRows } = await collectJamsilElsP2Points(csvPath);
  const inputP2Count = points.length;
  console.error(
    `[u2] input P2 points=${inputP2Count} (expected ${EXPECTED_P2}) sourceRows=${sourceRows}`,
  );

  if (inputP2Count !== EXPECTED_P2) {
    const report = {
      stage: "U2",
      integrity: "HOLD",
      reason: `input P2 points ${inputP2Count} != expected ${EXPECTED_P2}`,
      complexId: JAMSIL_ELS.complexId,
      inputP2Count,
      expectedP2: EXPECTED_P2,
    };
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n");
    console.error("[u2] HOLD — P2 count mismatch; density not emitted.");
    process.exit(2);
  }

  const density = aggregateDensity(points);
  const difference = density.sumCellCount - EXPECTED_P2;
  const integrity = difference === 0 ? "PASS" : "HOLD";

  if (integrity !== "PASS") {
    console.error(
      `[u2] HOLD — sumCellCount ${density.sumCellCount} != ${EXPECTED_P2}`,
    );
  }

  const artifact = {
    stage: "U2",
    purpose: "jamsil-els-p2-density-cells-150m",
    generatedAt: new Date().toISOString(),
    complexId: JAMSIL_ELS.complexId,
    complexName: JAMSIL_ELS.name,
    source: SOURCE,
    sourcePeriod: SOURCE_PERIOD,
    sourceDate: SOURCE_DATE,
    populationVersion: POPULATION_VERSION,
    populationRuleVersion: POPULATION_RULE_VERSION,
    radiusM: RADIUS_M,
    distanceMetric: "straight-line-haversine",
    gridSizeM: GRID_SIZE_M,
    center: {
      lat: JAMSIL_ELS.lat,
      lng: JAMSIL_ELS.lng,
      coordinateSource: JAMSIL_ELS.coordinateSource,
    },
    inputP2Count,
    cellCount: density.cellCount,
    sumCellCount: density.sumCellCount,
    differenceFromP2: difference,
    p95Count: density.p95Count,
    maxCellCount: density.maxCellCount,
    integrity,
    cells: density.cells,
    notes: {
      rawBusinessesEmbedded: false,
      individualCoordinatesEmbedded: false,
      gridOrigin: "apartment center local meter offsets",
      timingMs: Date.now() - t0,
      sourceFile: "소상공인시장진흥공단_상가(상권)정보_서울_202606.csv",
    },
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT, JSON.stringify(artifact, null, 2) + "\n");
  console.error(
    `[u2] wrote ${OUT} cells=${density.cellCount} sum=${density.sumCellCount} p95=${density.p95Count} max=${density.maxCellCount} integrity=${integrity}`,
  );

  if (integrity !== "PASS") process.exit(2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

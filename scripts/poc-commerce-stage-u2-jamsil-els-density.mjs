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
  createReadStream,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SOURCE,
  SOURCE_PERIOD,
  SOURCE_DATE,
  RADIUS_M,
  POPULATION_VERSION,
  POPULATION_RULE_VERSION,
  inP2,
  haversineMeters,
  parseCsvLine,
} from "./lib/commerce-semas-snapshot-transform.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "data/poc/commerce");
const OUT = join(OUT_DIR, "stage-u2-jamsil-els-density.json");

const GRID_SIZE_M = 150;
const EXPECTED_P2 = 4381;

const JAMSIL_ELS = {
  complexId: "cx_4c63d9a100973c60",
  name: "잠실엘스",
  lat: 37.5133,
  lng: 127.1028,
  coordinateSource: "c1_verified_pilot_center",
};

/** Local ENU-ish meter offsets from apartment center (equirectangular). */
function toLocalMeters(lat, lng, originLat, originLng) {
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos((originLat * Math.PI) / 180);
  return {
    x: (lng - originLng) * mPerDegLng,
    y: (lat - originLat) * mPerDegLat,
  };
}

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

async function collectP2Points(csvPath) {
  const { lat: oLat, lng: oLng } = JAMSIL_ELS;
  const dlat = 1.2 / 111;
  const dlng = 1.2 / (111 * Math.cos((oLat * Math.PI) / 180));
  const bbox = [oLat - dlat, oLat + dlat, oLng - dlng, oLng + dlng];

  const seen = new Set();
  const points = [];
  let header = null;
  const idx = {};
  let rows = 0;

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
    if (haversineMeters(oLat, oLng, lat, lng) > RADIUS_M) continue;
    const id = cols[idx["상가업소번호"]];
    if (seen.has(id)) continue;
    seen.add(id);
    points.push({ lat, lng });
  }

  return { points, sourceRows: rows };
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
  const { points, sourceRows } = await collectP2Points(csvPath);
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

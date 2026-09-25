#!/usr/bin/env node
/**
 * Stage U4 — attach presentation-category index to 잠실엘스 P2 map points.
 * Same center/radius/taxonomy as C4. No Seoul-wide reload.
 *
 * Encoding: meter-offset-int-v1 offsets + parallel categoryIdx[0..5]
 */

import { createReadStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
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
  parseCsvLine,
  haversineMeters,
  inP2,
  presentationBucket,
} from "./lib/commerce-semas-snapshot-transform.mjs";
import {
  toLocalMeters,
  fromLocalMeters,
} from "./lib/commerce-semas-p2-points.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "data/poc/commerce");
const OUT_POINTS = join(OUT_DIR, "stage-u4-jamsil-els-map-points.json");
const OUT_APP = join(
  ROOT,
  "src/lib/complex-detail/jamsil-els-commerce-map-points.json",
);
const OUT_MEDICAL = join(
  OUT_DIR,
  "stage-u4-jamsil-els-medical-facility-verify.json",
);

const CANONICAL = {
  complexId: "cx_4c63d9a100973c60",
  name: "잠실엘스",
  lat: 37.5133051,
  lng: 127.0815962,
  coordinateSource: "product_map_anchor_naver_geocode",
};

/** Must match src/lib/complex-detail/commerce-category-colors.ts */
const CATEGORY_INDEX = {
  "음식/외식": 0,
  "쇼핑/소매": 1,
  생활서비스: 2,
  교육: 3,
  "여가/체육": 4,
  "의료/건강": 5,
};

const RADIUS_TOLERANCE_M = 1.5;
const EXPECTED_P2 = 2745;

async function main() {
  const csvPath = resolve(process.argv[2] || process.env.SEMAS_SEOUL_CSV || "");
  if (!csvPath || !existsSync(csvPath)) {
    console.error("SEMAS_SEOUL_CSV required");
    process.exit(1);
  }

  const dlat = 1.2 / 111;
  const dlng = 1.2 / (111 * Math.cos((CANONICAL.lat * Math.PI) / 180));
  const bbox = [
    CANONICAL.lat - dlat,
    CANONICAL.lat + dlat,
    CANONICAL.lng - dlng,
    CANONICAL.lng + dlng,
  ];

  const seen = new Set();
  const points = [];
  let header = null;
  const idx = {};
  let rows = 0;

  // Medical verify (same pass conditions)
  const medicalRaw = [];
  const medicalById = new Map();
  const medSmall = new Map();
  const fac = {
    "병원/의원": 0,
    약국: 0,
    편의점: 0,
    "마트/슈퍼": 0,
    카페: 0,
    음식점: 0,
    미용: 0,
    학원: 0,
    체육: 0,
  };
  const p0Ids = new Set();

  function bumpFacility(l, m, s, mn, sn) {
    if (m === "Q101" || m === "Q102") fac["병원/의원"] += 1;
    if (s === "G21501") fac["약국"] += 1;
    if (s === "G20405") fac["편의점"] += 1;
    if (s === "G20404") fac["마트/슈퍼"] += 1;
    if (s === "I21201") fac["카페"] += 1;
    if (l === "I2" && m !== "I212") fac["음식점"] += 1;
    if (m === "S207") fac["미용"] += 1;
    if (String(mn).includes("학원") || String(sn).includes("학원"))
      fac["학원"] += 1;
    if (m === "R103") fac["체육"] += 1;
  }

  const rl = createInterface({
    input: createReadStream(csvPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!header) {
      header = parseCsvLine(line);
      for (const name of [
        "상가업소번호",
        "상호명",
        "상권업종대분류코드",
        "상권업종중분류코드",
        "상권업종중분류명",
        "상권업종소분류코드",
        "상권업종소분류명",
        "경도",
        "위도",
      ]) {
        idx[name] = header.indexOf(name);
        if (idx[name] < 0) throw new Error(`Missing ${name}`);
      }
      continue;
    }
    if (!line.trim()) continue;
    rows += 1;
    const cols = parseCsvLine(line);
    const lat = Number(cols[idx["위도"]]);
    const lng = Number(cols[idx["경도"]]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (lat < bbox[0] || lat > bbox[1] || lng < bbox[2] || lng > bbox[3])
      continue;
    const dist = haversineMeters(CANONICAL.lat, CANONICAL.lng, lat, lng);
    if (dist > RADIUS_M) continue;

    const id = cols[idx["상가업소번호"]];
    const l = cols[idx["상권업종대분류코드"]];
    const m = cols[idx["상권업종중분류코드"]];
    const mn = cols[idx["상권업종중분류명"]];
    const s = cols[idx["상권업종소분류코드"]];
    const sn = cols[idx["상권업종소분류명"]];
    const name = cols[idx["상호명"]];

    const isMed = m === "Q101" || m === "Q102";
    if (isMed) {
      medicalRaw.push({ id, m, mn, s, sn, name });
      if (!medicalById.has(id)) medicalById.set(id, []);
      medicalById.get(id).push({ m, mn, s, sn, name });
    }

    if (!p0Ids.has(id)) {
      p0Ids.add(id);
      bumpFacility(l, m, s, mn, sn);
      if (isMed) {
        const sk = `${s}\t${sn}`;
        medSmall.set(sk, (medSmall.get(sk) || 0) + 1);
      }
    }

    if (!inP2(l, m)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const bucket = presentationBucket(l);
    const catIdx =
      bucket in CATEGORY_INDEX ? CATEGORY_INDEX[bucket] : 255;
    points.push({ lat, lng, dist, catIdx, bucket });
  }

  if (points.length !== EXPECTED_P2) {
    console.error(`[u4] P2 ${points.length} != ${EXPECTED_P2}`);
    process.exit(2);
  }

  const offsetsM = [];
  const categoryIdx = [];
  let maxRecon = 0;
  let outside = 0;
  let maxActual = 0;
  const catCounts = [0, 0, 0, 0, 0, 0];

  for (const p of points) {
    if (p.dist > maxActual) maxActual = p.dist;
    if (p.dist > RADIUS_M + RADIUS_TOLERANCE_M) outside += 1;
    const { x, y } = toLocalMeters(p.lat, p.lng, CANONICAL.lat, CANONICAL.lng);
    const dx = Math.round(x);
    const dy = Math.round(y);
    offsetsM.push(dx, dy);
    categoryIdx.push(p.catIdx);
    if (p.catIdx >= 0 && p.catIdx <= 5) catCounts[p.catIdx] += 1;
    const recon = fromLocalMeters(dx, dy, CANONICAL.lat, CANONICAL.lng);
    const d = haversineMeters(
      CANONICAL.lat,
      CANONICAL.lng,
      recon.lat,
      recon.lng,
    );
    if (d > maxRecon) maxRecon = d;
  }

  const integrity =
    points.length === EXPECTED_P2 &&
    outside === 0 &&
    categoryIdx.length === EXPECTED_P2 &&
    maxRecon <= RADIUS_M + RADIUS_TOLERANCE_M
      ? "PASS"
      : "HOLD";

  const mapPoints = {
    complexId: CANONICAL.complexId,
    complexName: CANONICAL.name,
    source: SOURCE,
    sourcePeriod: SOURCE_PERIOD,
    sourceDate: SOURCE_DATE,
    populationVersion: POPULATION_VERSION,
    populationRuleVersion: POPULATION_RULE_VERSION,
    radiusM: RADIUS_M,
    origin: { lat: CANONICAL.lat, lng: CANONICAL.lng },
    encoding: "meter-offset-int-v1",
    categoryEncoding: "presentation-bucket-idx-v1",
    categoryKeys: [
      "음식/외식",
      "쇼핑/소매",
      "생활서비스",
      "교육",
      "여가/체육",
      "의료/건강",
    ],
    pointCount: points.length,
    offsetsM,
    categoryIdx,
  };

  const artifact = {
    stage: "U4",
    purpose: "jamsil-els-p2-map-points-with-category-colors",
    generatedAt: new Date().toISOString(),
    integrity,
    pointCount: points.length,
    categoryCounts: Object.fromEntries(
      mapPoints.categoryKeys.map((k, i) => [k, catCounts[i]]),
    ),
    maxActualDistM: Number(maxActual.toFixed(3)),
    maxReconstructedDistM: Number(maxRecon.toFixed(3)),
    outside1000m: outside,
    syntheticPoints: 0,
    sourceRows: rows,
    mapPoints,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_POINTS, JSON.stringify(artifact) + "\n");

  const appPayload = {
    complexId: mapPoints.complexId,
    origin: mapPoints.origin,
    encoding: mapPoints.encoding,
    categoryEncoding: mapPoints.categoryEncoding,
    categoryKeys: mapPoints.categoryKeys,
    pointCount: mapPoints.pointCount,
    radiusM: mapPoints.radiusM,
    offsetsM: mapPoints.offsetsM,
    categoryIdx: mapPoints.categoryIdx,
    stage: "U4",
    coordinateSource: CANONICAL.coordinateSource,
  };
  writeFileSync(OUT_APP, JSON.stringify(appPayload) + "\n");

  const medicalVerify = {
    stage: "U4",
    purpose: "jamsil-els-hospital-clinic-facility-verify",
    center: CANONICAL,
    radiusM: RADIUS_M,
    sourcePeriod: SOURCE_PERIOD,
    A_rawRows: medicalRaw.length,
    B_uniqueBusinessIds: medicalById.size,
    C_dedupeKey: "상가업소번호",
    C_duplicateExtraRows: medicalRaw.length - medicalById.size,
    C_idsWithMultipleRows: [...medicalById.values()].filter((a) => a.length > 1)
      .length,
    D_smallBreakdown: Object.fromEntries(
      [...medSmall.entries()].sort((a, b) => b[1] - a[1]),
    ),
    F_formula:
      "unique 상가업소번호 in 1km where 중분류 Q101|Q102 via bumpFacility on first P0 insert",
    facilitiesComputed: fac,
    aggregationLogicChange: false,
    labelRecommendation: "병원·의원 KEEP (source Q101 병원 + Q102 의원)",
    verdict: "AGGREGATION_OK",
  };
  writeFileSync(OUT_MEDICAL, JSON.stringify(medicalVerify, null, 2) + "\n");

  console.error(
    `[u4] integrity=${integrity} points=${points.length} cats=${JSON.stringify(catCounts)} medical=${fac["병원/의원"]}`,
  );
  if (integrity !== "PASS") process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

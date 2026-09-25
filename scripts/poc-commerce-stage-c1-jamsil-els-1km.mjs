#!/usr/bin/env node
/**
 * Commerce Stage C1 PoC — 잠실엘스 반경 1km census from SEMAS store file.
 *
 * Input: local 소상공인시장진흥공단 상가(상권)정보 Seoul CSV only
 *   SEMAS_SEOUL_CSV=/path/to/서울_202606.csv
 *   or: node scripts/poc-commerce-stage-c1-jamsil-els-1km.mjs /path/to/서울.csv
 *
 * Does NOT:
 * - call production DB / Turso
 * - ingest full Seoul into repo
 * - modify nearby UI/API
 * - hardcode 잠실엘스 into production paths (PoC-only center)
 *
 * Output: data/poc/commerce/stage-c1-jamsil-els-1km-commerce.json
 */

import { createReadStream, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "data/poc/commerce");
const OUT = join(OUT_DIR, "stage-c1-jamsil-els-1km-commerce.json");

/** Same center as data/poc/nearby-transport/jamsil-els.json (PoC only). */
const CENTER = {
  complexKey: "jamsil-els",
  complexName: "잠실엘스",
  lat: 37.5133,
  lng: 127.1028,
  coordinateSource: "data/poc/nearby-transport/jamsil-els.json",
};

const RADIUS_M = 1000;

function haversineMeters(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function topN(counter, n) {
  return [...counter.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([key, count]) => {
      const [code, category] = key.split("\t");
      return { code, category, count };
    });
}

async function main() {
  const csvPath = resolve(
    process.argv[2] || process.env.SEMAS_SEOUL_CSV || "",
  );
  if (!csvPath || !existsSync(csvPath)) {
    console.error(
      "Usage: SEMAS_SEOUL_CSV=/path/to/서울.csv node scripts/poc-commerce-stage-c1-jamsil-els-1km.mjs",
    );
    process.exit(1);
  }

  const degLat = 1.2 / 111;
  const degLng = 1.2 / (111 * Math.cos((CENTER.lat * Math.PI) / 180));
  const minLat = CENTER.lat - degLat;
  const maxLat = CENTER.lat + degLat;
  const minLng = CENTER.lng - degLng;
  const maxLng = CENTER.lng + degLng;

  const rl = createInterface({
    input: createReadStream(csvPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  let header = null;
  const idx = {};
  let sourceRowsConsidered = 0;
  let missingCoords = 0;
  let invalidCoords = 0;
  const byId = new Map();
  let withinRaw = 0;

  for await (const line of rl) {
    if (!header) {
      header = parseCsvLine(line);
      for (const name of [
        "상가업소번호",
        "상호명",
        "상권업종대분류코드",
        "상권업종대분류명",
        "상권업종중분류코드",
        "상권업종중분류명",
        "상권업종소분류코드",
        "상권업종소분류명",
        "경도",
        "위도",
      ]) {
        idx[name] = header.indexOf(name);
        if (idx[name] < 0) throw new Error(`Missing column: ${name}`);
      }
      continue;
    }
    if (!line.trim()) continue;
    sourceRowsConsidered += 1;
    const cols = parseCsvLine(line);
    const latRaw = cols[idx["위도"]];
    const lngRaw = cols[idx["경도"]];
    if (!latRaw || !lngRaw) {
      missingCoords += 1;
      continue;
    }
    const lat = Number(latRaw);
    const lng = Number(lngRaw);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      invalidCoords += 1;
      continue;
    }
    if (lat < minLat || lat > maxLat || lng < minLng || lng > maxLng) continue;
    const distanceM = haversineMeters(CENTER.lat, CENTER.lng, lat, lng);
    if (distanceM > RADIUS_M) continue;
    withinRaw += 1;
    const id = cols[idx["상가업소번호"]];
    const rec = {
      id,
      name: cols[idx["상호명"]],
      lclsCd: cols[idx["상권업종대분류코드"]],
      lclsNm: cols[idx["상권업종대분류명"]],
      mclsCd: cols[idx["상권업종중분류코드"]],
      mclsNm: cols[idx["상권업종중분류명"]],
      sclsCd: cols[idx["상권업종소분류코드"]],
      sclsNm: cols[idx["상권업종소분류명"]],
      lat,
      lng,
      distanceM: Math.round(distanceM * 10) / 10,
    };
    const prev = byId.get(id);
    if (!prev || rec.distanceM < prev.distanceM) byId.set(id, rec);
  }

  const unique = [...byId.values()];
  const duplicatesRemoved = withinRaw - unique.length;
  const total = unique.length;

  const lcls = new Map();
  const mcls = new Map();
  for (const r of unique) {
    const lk = `${r.lclsCd}\t${r.lclsNm}`;
    const mk = `${r.mclsCd}\t${r.mclsNm}`;
    lcls.set(lk, (lcls.get(lk) || 0) + 1);
    mcls.set(mk, (mcls.get(mk) || 0) + 1);
  }

  const lclsTop3 = topN(lcls, 3).map((x) => ({
    ...x,
    sharePct: total ? Math.round((10000 * x.count) / total) / 100 : 0,
  }));
  const mclsTop5 = topN(mcls, 5);

  const facility = {
    "병원/의원": {
      count: unique.filter((r) => r.mclsCd === "Q101" || r.mclsCd === "Q102")
        .length,
      mapping: "mcls Q101 병원 + Q102 의원",
    },
    약국: {
      count: unique.filter((r) => r.sclsCd === "G21501").length,
      mapping: "scls G21501 약국",
    },
    편의점: {
      count: unique.filter((r) => r.sclsCd === "G20405").length,
      mapping: "scls G20405 편의점",
    },
    "마트/슈퍼": {
      count: unique.filter((r) => r.sclsCd === "G20404").length,
      mapping: "scls G20404 슈퍼마켓 only (G20499 not forced)",
    },
    카페: {
      count: unique.filter((r) => r.sclsCd === "I21201").length,
      mapping: "scls I21201 카페 (스터디카페 excluded)",
    },
    음식점: {
      count: unique.filter(
        (r) => r.lclsCd === "I2" && r.mclsCd !== "I212",
      ).length,
      mapping: "lcls I2 음식 minus mcls I212 비알코올(카페)",
    },
    미용: {
      count: unique.filter((r) => r.mclsCd === "S207").length,
      mapping: "mcls S207 이용·미용",
    },
    학원: {
      count: unique.filter(
        (r) => r.mclsNm.includes("학원") || r.sclsNm.includes("학원"),
      ).length,
      mapping: "mcls/scls name contains 학원",
    },
    체육시설: {
      count: unique.filter((r) => r.mclsCd === "R103").length,
      mapping: "mcls R103 스포츠 서비스",
    },
  };

  const artifact = {
    stage: "C1",
    purpose: "commerce-census-source-validation-poc",
    generatedAt: new Date().toISOString(),
    center: CENTER,
    radiusM: RADIUS_M,
    distanceMetric: "straight-line-haversine",
    source: {
      name: "소상공인시장진흥공단_상가(상권)정보",
      provider: "소상공인시장진흥공단",
      datasetDate: "2026-06-30",
      fileLabel: "소상공인시장진흥공단_상가(상권)정보_20260630",
      portalUrl: "https://www.data.go.kr/data/15083033/fileData.do",
      accessUsed: "bulk-download-seoul-csv-stream-filter",
      populationMeaning:
        "소상공인시장진흥공단이 제공하는 영업 중 상가업소 레코드(국세청/카드사 기반). '실시간 현장 확인된 현재 영업 중 전체 점포'와 동일하다고 단정하지 않음.",
      identity: "provider=SEMAS + 상가업소번호",
      taxonomyNative: "대/중/소분류 (상권업종분류) + 표준산업분류",
    },
    counts: {
      sourceRowsConsideredSeoulCsv: sourceRowsConsidered,
      missingCoordsInSeoulCsv: missingCoords,
      invalidCoordsInSeoulCsv: invalidCoords,
      within1kmRaw: withinRaw,
      duplicatesRemoved,
      uniqueBusinesses: total,
    },
    categoryComposition: {
      largeClassTop3: lclsTop3,
      midClassTop5: mclsTop5,
      allLargeClasses: topN(lcls, 20).map((x) => ({
        ...x,
        sharePct: total ? Math.round((10000 * x.count) / total) / 100 : 0,
      })),
    },
    majorFacilities: facility,
    unsupportedFacilities: [],
    naver: {
      usedAsCensus: false,
      role: "POI / map marker / representative businesses only",
    },
    sizeLabel: "DEFER",
    polygon: {
      officialPolygonAvailable: true,
      note: "SEMAS API provides designated commercial-area (상권) polygons via storeZone* endpoints; not used in this 1km apartment-radius PoC.",
      used: false,
    },
    presentationTaxonomyProposal: [
      "음식/외식",
      "쇼핑/소매",
      "생활서비스",
      "의료/건강",
      "교육",
      "여가/체육",
      "기타",
    ],
    notes: [
      "NAVER Local Search must not be used for total/store-ratio/facility census.",
      "PoC does not write production DB/Turso/schema.",
      "Raw Seoul/nationwide dumps are not stored in the repository.",
    ],
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT, JSON.stringify(artifact, null, 2) + "\n", "utf8");
  console.log(
    JSON.stringify(
      {
        out: OUT,
        uniqueBusinesses: total,
        within1kmRaw: withinRaw,
        duplicatesRemoved,
        lclsTop3,
        mclsTop5,
        facility: Object.fromEntries(
          Object.entries(facility).map(([k, v]) => [k, v.count]),
        ),
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

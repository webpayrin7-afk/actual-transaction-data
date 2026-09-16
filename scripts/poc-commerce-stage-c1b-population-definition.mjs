#!/usr/bin/env node
/**
 * Commerce Stage C1B — define ZIPLAB commerce populations from SEMAS taxonomy.
 *
 * Reuses Stage C1 SEMAS Seoul CSV + same 잠실엘스 center/radius.
 * No new source research. No DB/UI/NAVER.
 *
 * Usage:
 *   SEMAS_SEOUL_CSV=/path/to/서울_202606.csv \
 *     node scripts/poc-commerce-stage-c1b-population-definition.mjs
 */

import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(
  ROOT,
  "data/poc/commerce/stage-c1b-commerce-population-definition.json",
);

const CENTER = { complexKey: "jamsil-els", lat: 37.5133, lng: 127.1028 };
const RADIUS_M = 1000;
const EXPECTED_P0 = 5904;

/** P1: resident-facing broad */
const P1_INCLUDE_LCLS = new Set([
  "I1",
  "I2",
  "G2",
  "S2",
  "P1",
  "R1",
  "Q1",
  "L1",
]);
const P1_M1_INCLUDE_MCLS = new Set(["M111", "M113"]);
const P1_N1_INCLUDE_MCLS = new Set(["N105", "N109", "N110"]);
const P1_EXCLUDE_MCLS = new Set(["P107"]);

/** P2: daily commerce core */
const P2_INCLUDE_LCLS = new Set(["I2", "G2", "Q1", "R1"]);
const P2_INCLUDE_MCLS = new Set([
  "P105",
  "P106",
  "S201",
  "S202",
  "S203",
  "S204",
  "S205",
  "S206",
  "S207",
  "S208",
  "S209",
]);

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
        } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function inP1(r) {
  if (P1_EXCLUDE_MCLS.has(r.m)) return false;
  if (P1_INCLUDE_LCLS.has(r.l)) return true;
  if (r.l === "M1" && P1_M1_INCLUDE_MCLS.has(r.m)) return true;
  if (r.l === "N1" && P1_N1_INCLUDE_MCLS.has(r.m)) return true;
  return false;
}

function inP2(r) {
  return P2_INCLUDE_LCLS.has(r.l) || P2_INCLUDE_MCLS.has(r.m);
}

function facilities(rows) {
  return {
    "병원/의원": rows.filter((r) => r.m === "Q101" || r.m === "Q102").length,
    약국: rows.filter((r) => r.s === "G21501").length,
    편의점: rows.filter((r) => r.s === "G20405").length,
    "마트/슈퍼": rows.filter((r) => r.s === "G20404").length,
    카페: rows.filter((r) => r.s === "I21201").length,
    음식점: rows.filter((r) => r.l === "I2" && r.m !== "I212").length,
    미용: rows.filter((r) => r.m === "S207").length,
    학원: rows.filter((r) => r.mn.includes("학원") || r.sn.includes("학원"))
      .length,
    체육: rows.filter((r) => r.m === "R103").length,
  };
}

function topCounter(map, n) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([key, count]) => {
      const [code, name] = key.split("\t");
      return { code, name, count };
    });
}

async function loadRows(csvPath) {
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
  const byId = new Map();

  for await (const line of rl) {
    if (!header) {
      header = parseCsvLine(line);
      for (const name of [
        "상가업소번호",
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
    const cols = parseCsvLine(line);
    const lat = Number(cols[idx["위도"]]);
    const lng = Number(cols[idx["경도"]]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (lat < minLat || lat > maxLat || lng < minLng || lng > maxLng) continue;
    if (haversineMeters(CENTER.lat, CENTER.lng, lat, lng) > RADIUS_M) continue;
    const id = cols[idx["상가업소번호"]];
    byId.set(id, {
      id,
      l: cols[idx["상권업종대분류코드"]],
      ln: cols[idx["상권업종대분류명"]],
      m: cols[idx["상권업종중분류코드"]],
      mn: String(cols[idx["상권업종중분류명"]] || "").trim(),
      s: cols[idx["상권업종소분류코드"]],
      sn: cols[idx["상권업종소분류명"]],
    });
  }
  return [...byId.values()];
}

async function main() {
  const csvPath = resolve(process.argv[2] || process.env.SEMAS_SEOUL_CSV || "");
  if (!csvPath || !existsSync(csvPath)) {
    console.error(
      "Usage: SEMAS_SEOUL_CSV=/path/to/서울.csv node scripts/poc-commerce-stage-c1b-population-definition.mjs",
    );
    process.exit(1);
  }

  const p0 = await loadRows(csvPath);
  if (p0.length !== EXPECTED_P0) {
    console.warn(
      `WARNING: P0=${p0.length} expected ${EXPECTED_P0}. Report legitimate reason; do not silently change denominator.`,
    );
  }
  const p1 = p0.filter(inP1);
  const p2 = p0.filter(inP2);

  const lcls = new Map();
  for (const r of p0) {
    const k = `${r.l}\t${r.ln}`;
    lcls.set(k, (lcls.get(k) || 0) + 1);
  }

  const summary = {
    stage: "C1B",
    baseline: {
      expected: EXPECTED_P0,
      actual: p0.length,
      match: p0.length === EXPECTED_P0,
    },
    counts: { P0: p0.length, P1: p1.length, P2: p2.length },
    facilities: {
      P0: facilities(p0),
      P1: facilities(p1),
      P2: facilities(p2),
    },
    sourceLargeCategories: topCounter(lcls, 20).map((x) => ({
      ...x,
      sharePct: Math.round((10000 * x.count) / p0.length) / 100,
    })),
    recommendation: {
      primaryPopulation: "DAILY_COMMERCE_CORE",
      dualMetric: true,
      userFacingLabel: "생활 상권",
    },
    taxonomyRules: {
      P1_INCLUDE_LCLS: [...P1_INCLUDE_LCLS],
      P1_M1_INCLUDE_MCLS: [...P1_M1_INCLUDE_MCLS],
      P1_N1_INCLUDE_MCLS: [...P1_N1_INCLUDE_MCLS],
      P1_EXCLUDE_MCLS: [...P1_EXCLUDE_MCLS],
      P2_INCLUDE_LCLS: [...P2_INCLUDE_LCLS],
      P2_INCLUDE_MCLS: [...P2_INCLUDE_MCLS],
    },
    note: "Full narrative artifact is maintained at data/poc/commerce/stage-c1b-commerce-population-definition.json; this script reprints core counts for regeneration checks.",
  };

  // Curated narrative JSON is maintained separately at OUT.
  // This script verifies reproducible P0/P1/P2 counts only.
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * Commerce Stage C2 — Seoul 25-complex P2 distribution pilot (read-only).
 *
 * Inputs:
 *   SEMAS_SEOUL_CSV=/path/to/서울_202606.csv
 *   data/poc/commerce/stage-c2-coordinate-cache.json  (pilot coords; no DB write)
 *
 * Recomputes P0/P1/P2 with frozen C1B taxonomy for cached centers.
 * Does not geocode, does not call NAVER Local, does not write Turso.
 *
 * Usage:
 *   SEMAS_SEOUL_CSV=/path/to/서울.csv node scripts/poc-commerce-stage-c2-seoul-25-distribution.mjs
 */

import { createReadStream, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = join(ROOT, "data/poc/commerce/stage-c2-coordinate-cache.json");
const OUT = join(
  ROOT,
  "data/poc/commerce/stage-c2-seoul-25-complex-distribution.counts-check.json",
);

const RADIUS_M = 1000;
const P1_INCLUDE_LCLS = new Set(["I1", "I2", "G2", "S2", "P1", "R1", "Q1", "L1"]);
const P1_M1 = new Set(["M111", "M113"]);
const P1_N1 = new Set(["N105", "N109", "N110"]);
const P1_EXCLUDE_M = new Set(["P107"]);
const P2_INCLUDE_LCLS = new Set(["I2", "G2", "Q1", "R1"]);
const P2_INCLUDE_M = new Set([
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

function inP1(l, m) {
  if (P1_EXCLUDE_M.has(m)) return false;
  if (P1_INCLUDE_LCLS.has(l)) return true;
  if (l === "M1" && P1_M1.has(m)) return true;
  if (l === "N1" && P1_N1.has(m)) return true;
  return false;
}
function inP2(l, m) {
  return P2_INCLUDE_LCLS.has(l) || P2_INCLUDE_M.has(m);
}

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

async function main() {
  const csvPath = resolve(process.argv[2] || process.env.SEMAS_SEOUL_CSV || "");
  if (!csvPath || !existsSync(csvPath)) {
    console.error(
      "Usage: SEMAS_SEOUL_CSV=/path/to/서울.csv node scripts/poc-commerce-stage-c2-seoul-25-distribution.mjs",
    );
    process.exit(1);
  }
  if (!existsSync(CACHE)) {
    console.error("Missing coordinate cache:", CACHE);
    process.exit(1);
  }
  const cache = JSON.parse(readFileSync(CACHE, "utf8"));
  const centers = cache.items;
  const stats = centers.map(() => ({
    p0: new Set(),
    p1: new Set(),
    p2: new Set(),
  }));
  const bboxes = centers.map((c) => {
    const dlat = 1.2 / 111;
    const dlng = 1.2 / (111 * Math.cos((c.lat * Math.PI) / 180));
    return [c.lat - dlat, c.lat + dlat, c.lng - dlng, c.lng + dlng];
  });

  const rl = createInterface({
    input: createReadStream(csvPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  let header = null;
  const idx = {};
  let rows = 0;
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
    const id = cols[idx["상가업소번호"]];
    const l = cols[idx["상권업종대분류코드"]];
    const m = cols[idx["상권업종중분류코드"]];
    const p1 = inP1(l, m);
    const p2 = inP2(l, m);
    for (let i = 0; i < centers.length; i++) {
      const [minLat, maxLat, minLng, maxLng] = bboxes[i];
      if (lat < minLat || lat > maxLat || lng < minLng || lng > maxLng) continue;
      if (haversineMeters(centers[i].lat, centers[i].lng, lat, lng) > RADIUS_M)
        continue;
      stats[i].p0.add(id);
      if (p1) stats[i].p1.add(id);
      if (p2) stats[i].p2.add(id);
    }
  }

  const summary = {
    seoulRows: rows,
    complexes: centers.map((c, i) => ({
      complex_id: c.complex_id,
      name: c.name,
      sigungu: c.sigungu,
      P0: stats[i].p0.size,
      P1: stats[i].p1.size,
      P2: stats[i].p2.size,
    })),
  };
  writeFileSync(OUT, JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * Offline SEMAS → complex commerce snapshot transform (reusable).
 *
 * Single-pass Seoul CSV stream → bounding-box prefilter → haversine 1km
 * → P0 / P2 / presentation / TOP5 / facilities aggregates.
 *
 * No Production DB writes. No NAVER. No GIS framework.
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";

export const SOURCE = "semas";
export const SOURCE_PERIOD = "2026Q2";
export const SOURCE_DATE = "2026-06-30";
export const RADIUS_M = 1000;
export const POPULATION_VERSION = "daily_commerce_core_v1";
export const POPULATION_RULE_VERSION = "c1b_frozen_p2_v1";

/** Frozen P2 DAILY_COMMERCE_CORE (C1B/C2 — do not reopen). */
export const P2_INCLUDE_LCLS = new Set(["I2", "G2", "Q1", "R1"]);
export const P2_INCLUDE_MCLS = new Set([
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

export const PRESENTATION_BUCKETS = [
  "음식/외식",
  "쇼핑/소매",
  "생활서비스",
  "의료/건강",
  "교육",
  "여가/체육",
  "기타",
];

export function inP2(l, m) {
  return P2_INCLUDE_LCLS.has(l) || P2_INCLUDE_MCLS.has(m);
}

export function presentationBucket(l) {
  switch (l) {
    case "I2":
      return "음식/외식";
    case "G2":
      return "쇼핑/소매";
    case "S2":
      return "생활서비스";
    case "Q1":
      return "의료/건강";
    case "P1":
      return "교육";
    case "R1":
      return "여가/체육";
    default:
      return "기타";
  }
}

export function haversineMeters(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function parseCsvLine(line) {
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

function emptyFacilityCounts() {
  return {
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
}

function bumpFacility(fac, l, m, s, mn, sn) {
  if (m === "Q101" || m === "Q102") fac["병원/의원"] += 1;
  if (s === "G21501") fac["약국"] += 1;
  if (s === "G20405") fac["편의점"] += 1;
  if (s === "G20404") fac["마트/슈퍼"] += 1;
  if (s === "I21201") fac["카페"] += 1;
  if (l === "I2" && m !== "I212") fac["음식점"] += 1;
  if (m === "S207") fac["미용"] += 1;
  if (String(mn).includes("학원") || String(sn).includes("학원")) fac["학원"] += 1;
  if (m === "R103") fac["체육"] += 1;
}

function makeCenterState(center) {
  const dlat = 1.2 / 111;
  const dlng = 1.2 / (111 * Math.cos((center.lat * Math.PI) / 180));
  return {
    center,
    bbox: [
      center.lat - dlat,
      center.lat + dlat,
      center.lng - dlng,
      center.lng + dlng,
    ],
    p0Ids: new Set(),
    p2Ids: new Set(),
    mid: new Map(), // code\tname → count (P2 only)
    composition: Object.fromEntries(PRESENTATION_BUCKETS.map((b) => [b, 0])),
    facilities: emptyFacilityCounts(),
  };
}

/**
 * @param {string} csvPath
 * @param {Array<{complex_id:string,name?:string,sigungu?:string,lat:number,lng:number,coordinateSource?:string}>} centers
 * @param {{onProgress?: (rows:number)=>void}} [opts]
 */
export async function aggregateCommerceSnapshots(csvPath, centers, opts = {}) {
  const states = centers.map(makeCenterState);
  const t0 = Date.now();
  let rows = 0;
  let header = null;
  const idx = {};

  const rl = createInterface({
    input: createReadStream(csvPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  const tStream0 = Date.now();
  for await (const line of rl) {
    if (!header) {
      header = parseCsvLine(line);
      for (const name of [
        "상가업소번호",
        "상권업종대분류코드",
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
    rows += 1;
    const cols = parseCsvLine(line);
    const lat = Number(cols[idx["위도"]]);
    const lng = Number(cols[idx["경도"]]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const id = cols[idx["상가업소번호"]];
    const l = cols[idx["상권업종대분류코드"]];
    const m = cols[idx["상권업종중분류코드"]];
    const mn = cols[idx["상권업종중분류명"]];
    const s = cols[idx["상권업종소분류코드"]];
    const sn = cols[idx["상권업종소분류명"]];
    const p2 = inP2(l, m);

    for (let i = 0; i < states.length; i++) {
      const st = states[i];
      const [minLat, maxLat, minLng, maxLng] = st.bbox;
      if (lat < minLat || lat > maxLat || lng < minLng || lng > maxLng) continue;
      if (
        haversineMeters(st.center.lat, st.center.lng, lat, lng) > RADIUS_M
      )
        continue;
      if (st.p0Ids.has(id)) continue;
      st.p0Ids.add(id);
      bumpFacility(st.facilities, l, m, s, mn, sn);
      if (p2) {
        st.p2Ids.add(id);
        st.composition[presentationBucket(l)] += 1;
        const key = `${m}\t${String(mn || "").trim()}`;
        st.mid.set(key, (st.mid.get(key) || 0) + 1);
      }
    }
    if (opts.onProgress && rows % 100000 === 0) opts.onProgress(rows);
  }
  const streamWallMs = Date.now() - tStream0;
  // Single-pass: I/O + CSV parse + spatial aggregate are inseparable in wall clock.
  const sourceReadMs = streamWallMs;
  const aggregationMs = streamWallMs;

  const computedAt = new Date().toISOString();
  const tSer0 = Date.now();
  const snapshots = states.map((st) => {
    const p0Total = st.p0Ids.size;
    const p2Total = st.p2Ids.size;
    const composition = {};
    for (const b of PRESENTATION_BUCKETS) {
      const count = st.composition[b];
      composition[b] = {
        count,
        share: p2Total ? Number(((count / p2Total) * 100).toFixed(2)) : 0,
      };
    }
    const topCategories = [...st.mid.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([key, count]) => {
        const [code, name] = key.split("\t");
        return { code, name, count };
      });

    return {
      complexId: st.center.complex_id,
      name: st.center.name ?? null,
      sigungu: st.center.sigungu ?? null,
      source: SOURCE,
      sourcePeriod: SOURCE_PERIOD,
      sourceDate: SOURCE_DATE,
      radiusM: RADIUS_M,
      populationVersion: POPULATION_VERSION,
      populationRuleVersion: POPULATION_RULE_VERSION,
      p0Total,
      p2Total,
      p2ToP0Ratio: p0Total
        ? Number(((p2Total / p0Total) * 100).toFixed(2))
        : 0,
      composition,
      topCategories,
      facilities: { ...st.facilities },
      sourceUpdatedDate: SOURCE_DATE,
      computedAt,
      coordinateSource: st.center.coordinateSource ?? "pilot_cache",
      lat: st.center.lat,
      lng: st.center.lng,
    };
  });
  const serializationMs = Date.now() - tSer0;

  return {
    sourceRows: rows,
    snapshots,
    timing: {
      sourceReadMs,
      aggregationMs,
      streamWallMs,
      serializationMs,
      totalMs: Date.now() - t0,
      note: "sourceReadMs and aggregationMs both equal streamWallMs (single-pass coupled).",
    },
  };
}

/** Canonical payload for Production contract (no lat/lng / pilot fields). */
export function toProductionSnapshotPayload(snap) {
  return {
    complexId: snap.complexId,
    source: snap.source,
    sourcePeriod: snap.sourcePeriod,
    radiusM: snap.radiusM,
    populationVersion: snap.populationVersion,
    p0Total: snap.p0Total,
    p2Total: snap.p2Total,
    p2ToP0Ratio: snap.p2ToP0Ratio,
    composition: snap.composition,
    topCategories: snap.topCategories,
    facilities: snap.facilities,
    sourceDate: snap.sourceDate,
    sourceUpdatedDate: snap.sourceUpdatedDate,
    computedAt: snap.computedAt,
    coordinateSource: snap.coordinateSource,
    populationRuleVersion: snap.populationRuleVersion,
  };
}

export function hashCanonicalSnapshots(payloads) {
  const canonical = payloads
    .map((p) => {
      const { computedAt, ...rest } = p;
      return rest;
    })
    .sort((a, b) => String(a.complexId).localeCompare(String(b.complexId)));
  return createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex");
}

/** Recommended Production schema draft (not applied). */
export const SCHEMA_DRAFT_SQL = `
-- DRAFT ONLY — Stage C3 does not apply migrations.
CREATE TABLE IF NOT EXISTS apt_commerce_snapshots (
  complex_id TEXT NOT NULL,
  source TEXT NOT NULL,
  source_period TEXT NOT NULL,
  radius_m INTEGER NOT NULL,
  population_version TEXT NOT NULL,
  p0_total INTEGER NOT NULL,
  p2_total INTEGER NOT NULL,
  summary_json TEXT NOT NULL,
  source_updated_at TEXT NOT NULL,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (complex_id, source_period, radius_m, population_version)
);
CREATE INDEX IF NOT EXISTS idx_commerce_snap_complex
  ON apt_commerce_snapshots(complex_id);
CREATE INDEX IF NOT EXISTS idx_commerce_snap_period
  ON apt_commerce_snapshots(source_period);
`.trim();

/**
 * Shared SEMAS P2 point collection for 잠실엘스 (U2/U3).
 * Single P2 filter implementation — do not fork taxonomy/radius logic.
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import {
  RADIUS_M,
  inP2,
  haversineMeters,
  parseCsvLine,
} from "./commerce-semas-snapshot-transform.mjs";

export const JAMSIL_ELS_P2_CENTER = {
  complexId: "cx_4c63d9a100973c60",
  name: "잠실엘스",
  lat: 37.5133,
  lng: 127.1028,
  coordinateSource: "c1_verified_pilot_center",
  expectedP2: 4381,
};

/** Local ENU-ish meter offsets from apartment center (equirectangular). */
export function toLocalMeters(lat, lng, originLat, originLng) {
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos((originLat * Math.PI) / 180);
  return {
    x: (lng - originLng) * mPerDegLng,
    y: (lat - originLat) * mPerDegLat,
  };
}

export function fromLocalMeters(dxM, dyM, originLat, originLng) {
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos((originLat * Math.PI) / 180);
  return {
    lat: originLat + dyM / mPerDegLat,
    lng: originLng + dxM / mPerDegLng,
  };
}

/**
 * Stream SEMAS Seoul CSV → unique P2 businesses within 1km of 잠실엘스.
 * @param {string} csvPath
 * @returns {Promise<{points: Array<{lat:number,lng:number}>, sourceRows:number, uniqueIds:number}>}
 */
export async function collectJamsilElsP2Points(csvPath) {
  const { lat: oLat, lng: oLng } = JAMSIL_ELS_P2_CENTER;
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

  return { points, sourceRows: rows, uniqueIds: seen.size };
}

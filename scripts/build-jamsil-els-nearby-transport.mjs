#!/usr/bin/env node
/**
 * Build tiny 잠실엘스 nearby-transport pilot artifact from official files.
 *
 * Subway: data/seoul-metro/서울교통공사_1-8호선 역사 좌표(위경도) 정보_*.csv
 * Bus:    data/bus-stops/*전국버스정류소표준데이터* (CSV/XLSX) if present
 *
 * Does NOT commit/copy the full national bus file — only nearby rows.
 * No external API calls. No DB writes.
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "data/poc/nearby-transport/jamsil-els.json");

/** NAVER_GEOCODE ADDRESS_POINT used by Complex Detail for 잠실엘스. */
const CENTER = {
  lat: 37.5133,
  lng: 127.1028,
  source: "NAVER_GEOCODE",
  accuracy: "ADDRESS_POINT",
};

const SUBWAY_RADIUS_M = 1500;
const BUS_RADIUS_M = 700;

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

function straightDistanceLabel(meters) {
  if (!Number.isFinite(meters) || meters < 0) return "—";
  if (meters < 1000) return `직선거리 ${Math.round(meters)}m`;
  const km = meters / 1000;
  return `직선거리 ${km < 10 ? km.toFixed(1) : Math.round(km)}km`;
}

function decodeMaybeKorean(buf) {
  for (const enc of ["utf-8", "euc-kr"]) {
    try {
      const text = new TextDecoder(enc, { fatal: enc === "utf-8" }).decode(buf);
      if (/위도|경도|정류|역명|호선/.test(text.slice(0, 500))) return text;
      if (enc === "euc-kr") return text;
    } catch {
      /* try next */
    }
  }
  return buf.toString("utf8");
}

function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function findSubwayCsv() {
  const dir = join(ROOT, "data/seoul-metro");
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith(".csv"));
  const preferred = files.find((f) => f.includes("1-8호선") || f.includes("역사"));
  return preferred ? join(dir, preferred) : files[0] ? join(dir, files[0]) : null;
}

function findBusFile() {
  const candidates = [
    join(ROOT, "data/bus-stops"),
    join(ROOT, "data/bus"),
    join(ROOT, "data/national-bus-stops"),
    join(ROOT, "data"),
    join(ROOT, "tmp"),
    "/tmp",
  ];
  const patterns = [
    /전국버스정류소표준데이터/i,
    /버스정류소표준/i,
    /national.?bus.?stop/i,
  ];
  for (const dir of candidates) {
    if (!existsSync(dir)) continue;
    let files = [];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!/\.(csv|tsv|xlsx|xls)$/i.test(f)) continue;
      if (patterns.some((re) => re.test(f))) return join(dir, f);
    }
  }
  return null;
}

function parseSubway(filePath) {
  const buf = readFileSync(filePath);
  const text = decodeMaybeKorean(buf).replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) {
    return { rowsParsed: 0, valid: [], coverage: null, error: "empty csv" };
  }
  const header = splitCsvLine(lines[0]).map((h) => h.trim());
  const idx = {
    line: header.indexOf("호선"),
    code: header.indexOf("고유역번호(외부역코드)"),
    name: header.indexOf("역명"),
    lat: header.indexOf("위도"),
    lng: header.indexOf("경도"),
  };
  if (idx.name < 0 || idx.lat < 0 || idx.lng < 0) {
    return {
      rowsParsed: 0,
      valid: [],
      coverage: null,
      error: `missing required columns: ${header.join("|")}`,
    };
  }

  const valid = [];
  for (const line of lines.slice(1)) {
    const cols = splitCsvLine(line);
    const name = (cols[idx.name] ?? "").trim();
    const lat = Number(cols[idx.lat]);
    const lng = Number(cols[idx.lng]);
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (lat === 0 && lng === 0) continue;
    const code = idx.code >= 0 ? (cols[idx.code] ?? "").trim() : "";
    const lineNo = idx.line >= 0 ? (cols[idx.line] ?? "").trim() : null;
    valid.push({
      id: `metro-${code || `${lat},${lng}`}-${name}`,
      name,
      line: lineNo || null,
      stationCode: code || null,
      lat,
      lng,
      source: "SEOUL_METRO_STATION_FILE",
    });
  }

  const linesPresent = [
    ...new Set(valid.map((s) => s.line).filter(Boolean)),
  ].sort((a, b) => Number(a) - Number(b));

  return {
    rowsParsed: lines.length - 1,
    valid,
    coverage: linesPresent.length
      ? `서울교통공사 ${linesPresent.join(",")}호선`
      : "서울교통공사 역사 좌표 (호선 미기재)",
    error: null,
  };
}

function headerIndex(header, names) {
  for (const n of names) {
    const i = header.findIndex((h) => h.replace(/\s/g, "") === n.replace(/\s/g, ""));
    if (i >= 0) return i;
  }
  // fuzzy contains
  for (const n of names) {
    const i = header.findIndex((h) => h.includes(n));
    if (i >= 0) return i;
  }
  return -1;
}

function parseBusCsv(filePath) {
  const buf = readFileSync(filePath);
  const text = decodeMaybeKorean(buf).replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) {
    return { rowsParsed: 0, valid: [], error: "empty csv", routeMetadataAvailable: false };
  }
  const header = splitCsvLine(lines[0]).map((h) => h.trim());
  const idx = {
    id: headerIndex(header, [
      "정류장번호",
      "정류소번호",
      "정류장ID",
      "정류소ID",
      "NODE_ID",
      "노드ID",
      "정류장식별자",
    ]),
    name: headerIndex(header, [
      "정류장명",
      "정류소명",
      "정류장이름",
      "정류소이름",
      "STOP_NM",
    ]),
    lat: headerIndex(header, ["위도", "Y좌표", "GPS_Y", "LAT", "lat"]),
    lng: headerIndex(header, ["경도", "X좌표", "GPS_X", "LNG", "lng", "LON"]),
  };
  if (idx.name < 0 || idx.lat < 0 || idx.lng < 0) {
    return {
      rowsParsed: 0,
      valid: [],
      error: `missing required columns: ${header.join("|")}`,
      routeMetadataAvailable: false,
      header,
    };
  }

  const routeCol = headerIndex(header, ["노선", "노선번호", "버스노선"]);
  const valid = [];
  for (const line of lines.slice(1)) {
    const cols = splitCsvLine(line);
    const name = (cols[idx.name] ?? "").trim();
    const lat = Number(cols[idx.lat]);
    const lng = Number(cols[idx.lng]);
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    if (lat === 0 && lng === 0) continue;
    const idRaw =
      idx.id >= 0 ? (cols[idx.id] ?? "").trim() : `${lat},${lng}`;
    valid.push({
      id: `bus-${idRaw}-${name}`,
      name,
      lat,
      lng,
      source: "NATIONAL_BUS_STOP_STANDARD_FILE",
    });
  }

  return {
    rowsParsed: lines.length - 1,
    valid,
    error: null,
    routeMetadataAvailable: routeCol >= 0,
    header,
  };
}

function nearbyOf(rows, radiusM) {
  return rows
    .map((r) => {
      const distanceMeters = Math.round(
        haversineMeters(CENTER.lat, CENTER.lng, r.lat, r.lng),
      );
      return {
        ...r,
        distanceMeters,
        distanceLabel: straightDistanceLabel(distanceMeters),
      };
    })
    .filter((r) => r.distanceMeters <= radiusM)
    .sort((a, b) => a.distanceMeters - b.distanceMeters);
}

function main() {
  const subwayPath = findSubwayCsv();
  let subwayMeta = {
    file: null,
    origin: "서울 열린데이터광장 OA-22534",
    coverage: null,
    rowsParsed: 0,
    validCoordinates: 0,
    status: "HOLD",
    reason: "subway file missing",
  };
  let subwayNearby = [];

  if (subwayPath) {
    const parsed = parseSubway(subwayPath);
    subwayMeta = {
      file: basename(subwayPath),
      origin: "서울 열린데이터광장 OA-22534",
      coverage: parsed.coverage,
      rowsParsed: parsed.rowsParsed,
      validCoordinates: parsed.valid.length,
      status: parsed.valid.length ? "PASS" : "HOLD",
      reason: parsed.error,
    };
    subwayNearby = nearbyOf(parsed.valid, SUBWAY_RADIUS_M);
  }

  const busPath = findBusFile();
  let busMeta = {
    file: null,
    status: "HOLD",
    reason: "official national bus-stop file not present in workspace",
    rowsParsed: 0,
    validCoordinates: 0,
    routeMetadataAvailable: false,
  };
  let busNearby = [];

  if (busPath) {
    if (/\.xlsx?$/i.test(busPath)) {
      busMeta = {
        file: basename(busPath),
        status: "HOLD",
        reason: "xlsx present but parser expects CSV export of 전국버스정류소표준데이터",
        rowsParsed: 0,
        validCoordinates: 0,
        routeMetadataAvailable: false,
      };
    } else {
      const parsed = parseBusCsv(busPath);
      busMeta = {
        file: basename(busPath),
        status: parsed.valid.length ? "PASS" : "HOLD",
        reason: parsed.error,
        rowsParsed: parsed.rowsParsed,
        validCoordinates: parsed.valid.length,
        routeMetadataAvailable: !!parsed.routeMetadataAvailable,
      };
      // IMPORTANT: never invent route counts even if a route column exists in some dumps.
      // v1 display uses name + 버스정류장 + straight distance only.
      busNearby = nearbyOf(parsed.valid, BUS_RADIUS_M).map((b) => ({
        id: b.id,
        name: b.name,
        lat: b.lat,
        lng: b.lng,
        distanceMeters: b.distanceMeters,
        distanceLabel: b.distanceLabel,
        source: b.source,
      }));
    }
  }

  const artifact = {
    complex: {
      name: "잠실엘스",
      center: CENTER,
    },
    sources: {
      subway: subwayMeta,
      bus: busMeta,
    },
    subway: subwayNearby.map((s) => ({
      id: s.id,
      name: s.name.endsWith("역") ? s.name : `${s.name}역`,
      line: s.line,
      stationCode: s.stationCode,
      lat: s.lat,
      lng: s.lng,
      distanceMeters: s.distanceMeters,
      distanceLabel: s.distanceLabel,
      source: s.source,
    })),
    bus: busNearby,
    radiiMeters: {
      subway: SUBWAY_RADIUS_M,
      bus: BUS_RADIUS_M,
    },
    generatedAt: new Date().toISOString(),
    note: "Pilot extract only — not a nationwide transport master. No VWorld. No route invention.",
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  console.log(
    JSON.stringify(
      {
        out: OUT,
        subway: {
          status: subwayMeta.status,
          nearby: artifact.subway.length,
          coverage: subwayMeta.coverage,
        },
        bus: {
          status: busMeta.status,
          nearby: artifact.bus.length,
          reason: busMeta.reason,
        },
      },
      null,
      2,
    ),
  );
}

main();

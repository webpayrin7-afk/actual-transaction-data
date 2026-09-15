/**
 * Official Seoul Metro station coordinates (lines 1–8 + line 9 phase 2/3).
 * Sources:
 * - 서울교통공사_1-8호선 역사 좌표(위경도) 정보_20250814.csv (OA-22534)
 * - 서울교통공사_9호선 2_3단계 역사 좌표(위경도) 정보_20260131.csv
 * Runtime CSV read only. No DB writes. No invented lines.
 */

import { readFileSync } from "fs";
import path from "path";
import { haversineMeters, type LatLng } from "@/lib/complex-detail/geo";

export type SeoulMetroStation = {
  sourceId: string;
  line: string;
  stationCode: string;
  name: string;
  lat: number;
  lng: number;
  source: "SEOUL_METRO_1_8" | "SEOUL_METRO_9_PHASE23";
};

export type NearbyMetroStationGroup = {
  id: string;
  name: string;
  lines: string[];
  lat: number;
  lng: number;
  distanceMeters: number;
  distanceLabel: string;
  members: SeoulMetroStation[];
};

const CSV_1_8 =
  "서울교통공사_1-8호선 역사 좌표(위경도) 정보_20250814.csv";
const CSV_9 =
  "서울교통공사_9호선 2_3단계 역사 좌표(위경도) 정보_20260131.csv";

/** Same-name hubs merge only when coordinates are this close (meters). */
const MERGE_MAX_METERS = 400;

let cache: SeoulMetroStation[] | null = null;

function straightDistanceLabel(meters: number): string {
  if (!Number.isFinite(meters) || meters < 0) return "—";
  if (meters < 1000) return `직선거리 ${Math.round(meters)}m`;
  const km = meters / 1000;
  return `직선거리 ${km < 10 ? km.toFixed(1) : Math.round(km)}km`;
}

export function normalizeMetroStationName(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, "")
    .replace(/역$/u, "")
    .replace(/\(.*?\)/g, "");
}

function displayMetroStationName(name: string): string {
  const base = name.trim().replace(/역$/u, "");
  return `${base}역`;
}

function normalizeLineNumber(raw: string): string {
  const t = raw.trim();
  const m = t.match(/(\d+)/);
  return m ? m[1] : t.replace(/호선$/u, "");
}

function parseCsv1to8(text: string): SeoulMetroStation[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map((h) => h.trim());
  const idx = {
    line: header.indexOf("호선"),
    code: header.findIndex((h) => h.includes("고유역번호") || h.includes("외부역코드")),
    name: header.indexOf("역명"),
    lat: header.indexOf("위도"),
    lng: header.indexOf("경도"),
  };
  if (idx.line < 0 || idx.name < 0 || idx.lat < 0 || idx.lng < 0) return [];

  const out: SeoulMetroStation[] = [];
  for (const row of lines.slice(1)) {
    const cols = row.split(",");
    const name = (cols[idx.name] ?? "").trim();
    const lat = Number(cols[idx.lat]);
    const lng = Number(cols[idx.lng]);
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const line = normalizeLineNumber(cols[idx.line] ?? "");
    const stationCode = idx.code >= 0 ? (cols[idx.code] ?? "").trim() : "";
    out.push({
      sourceId: `1-8:${stationCode || name}:${line}`,
      line,
      stationCode,
      name,
      lat,
      lng,
      source: "SEOUL_METRO_1_8",
    });
  }
  return out;
}

function parseCsvLine9(text: string): SeoulMetroStation[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map((h) => h.trim());
  const idx = {
    line: header.indexOf("호선"),
    code: header.indexOf("역번호"),
    name: header.indexOf("역명"),
    lat: header.indexOf("위도"),
    lng: header.indexOf("경도"),
  };
  if (idx.name < 0 || idx.lat < 0 || idx.lng < 0) return [];

  const out: SeoulMetroStation[] = [];
  for (const row of lines.slice(1)) {
    const cols = row.split(",");
    const name = (cols[idx.name] ?? "").trim();
    const lat = Number(cols[idx.lat]);
    const lng = Number(cols[idx.lng]);
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const line =
      idx.line >= 0 ? normalizeLineNumber(cols[idx.line] ?? "9") : "9";
    const stationCode = idx.code >= 0 ? (cols[idx.code] ?? "").trim() : "";
    out.push({
      sourceId: `9:${stationCode || name}:${line}`,
      line,
      stationCode,
      name,
      lat,
      lng,
      source: "SEOUL_METRO_9_PHASE23",
    });
  }
  return out;
}

function readCsvFile(fileName: string): string | null {
  const filePath = path.join(process.cwd(), "data", "seoul-metro", fileName);
  try {
    const buf = readFileSync(filePath);
    return new TextDecoder("euc-kr").decode(buf);
  } catch {
    try {
      return readFileSync(filePath, "utf8");
    } catch {
      return null;
    }
  }
}

export function loadSeoulMetroStations(): SeoulMetroStation[] {
  if (cache) return cache;
  const out: SeoulMetroStation[] = [];
  const t18 = readCsvFile(CSV_1_8);
  if (t18) out.push(...parseCsv1to8(t18));
  const t9 = readCsvFile(CSV_9);
  if (t9) out.push(...parseCsvLine9(t9));
  cache = out;
  return cache;
}

function mergeNearbyStations(
  ranked: Array<SeoulMetroStation & { distanceMeters: number }>,
): NearbyMetroStationGroup[] {
  const groups: NearbyMetroStationGroup[] = [];

  for (const s of ranked) {
    const key = normalizeMetroStationName(s.name);
    let matched: NearbyMetroStationGroup | null = null;
    for (const g of groups) {
      if (normalizeMetroStationName(g.name) !== key) continue;
      const dist = haversineMeters(g.lat, g.lng, s.lat, s.lng);
      if (dist <= MERGE_MAX_METERS) {
        matched = g;
        break;
      }
    }

    if (!matched) {
      groups.push({
        id: `metro-${key}-${s.stationCode || s.sourceId}`,
        name: displayMetroStationName(s.name),
        lines: [s.line],
        lat: s.lat,
        lng: s.lng,
        distanceMeters: s.distanceMeters,
        distanceLabel: straightDistanceLabel(s.distanceMeters),
        members: [s],
      });
      continue;
    }

    matched.members.push(s);
    if (!matched.lines.includes(s.line)) {
      matched.lines.push(s.line);
      matched.lines.sort((a, b) => Number(a) - Number(b));
    }
    if (s.distanceMeters < matched.distanceMeters) {
      matched.lat = s.lat;
      matched.lng = s.lng;
      matched.distanceMeters = s.distanceMeters;
      matched.distanceLabel = straightDistanceLabel(s.distanceMeters);
    }
  }

  return groups;
}

/**
 * Nearest distinct Seoul Metro stations (1–8 + 9 phase2/3), merged by
 * normalized name + coordinate proximity. Distances from live complex center.
 */
export function nearestSeoulMetroStations(
  center: LatLng,
  opts?: { limit?: number; maxMeters?: number },
): NearbyMetroStationGroup[] {
  const limit = opts?.limit ?? 3;
  const maxMeters = opts?.maxMeters ?? 3000;
  const stations = loadSeoulMetroStations();
  if (!stations.length) return [];

  const ranked = stations
    .map((s) => {
      const distanceMeters = Math.round(
        haversineMeters(center.lat, center.lng, s.lat, s.lng),
      );
      return { ...s, distanceMeters };
    })
    .filter((s) => s.distanceMeters <= maxMeters)
    .sort((a, b) => a.distanceMeters - b.distanceMeters);

  return mergeNearbyStations(ranked).slice(0, limit);
}

export function seoulMetroCsvFileNames(): string[] {
  return [CSV_1_8, CSV_9];
}

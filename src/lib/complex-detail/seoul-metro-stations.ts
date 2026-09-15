/**
 * Official Seoul Metro (lines 1–8) station coordinates.
 * Source: 서울 열린데이터광장 OA-22534
 * File: 서울교통공사_1-8호선 역사 좌표(위경도) 정보_20250814.csv
 * No DB writes — runtime CSV read only.
 */

import { readFileSync } from "fs";
import path from "path";
import { haversineMeters, type LatLng } from "@/lib/complex-detail/geo";

export type SeoulMetroStation = {
  line: string;
  stationCode: string;
  name: string;
  lat: number;
  lng: number;
};

export type NearbyMetroStation = SeoulMetroStation & {
  distanceMeters: number;
  distanceLabel: string;
};

const OFFICIAL_CSV =
  "서울교통공사_1-8호선 역사 좌표(위경도) 정보_20250814.csv";

let cache: SeoulMetroStation[] | null = null;

function straightDistanceLabel(meters: number): string {
  if (!Number.isFinite(meters) || meters < 0) return "—";
  if (meters < 1000) return `직선거리 ${Math.round(meters)}m`;
  const km = meters / 1000;
  return `직선거리 ${km < 10 ? km.toFixed(1) : Math.round(km)}km`;
}

function parseCsv(text: string): SeoulMetroStation[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map((h) => h.trim());
  const idx = {
    line: header.indexOf("호선"),
    code: header.indexOf("고유역번호(외부역코드)"),
    name: header.indexOf("역명"),
    lat: header.indexOf("위도"),
    lng: header.indexOf("경도"),
  };
  if (
    idx.line < 0 ||
    idx.name < 0 ||
    idx.lat < 0 ||
    idx.lng < 0
  ) {
    return [];
  }

  const out: SeoulMetroStation[] = [];
  for (const line of lines.slice(1)) {
    const cols = line.split(",");
    const name = (cols[idx.name] ?? "").trim();
    const lat = Number(cols[idx.lat]);
    const lng = Number(cols[idx.lng]);
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    out.push({
      line: (cols[idx.line] ?? "").trim(),
      stationCode: idx.code >= 0 ? (cols[idx.code] ?? "").trim() : "",
      name,
      lat,
      lng,
    });
  }
  return out;
}

export function loadSeoulMetroStations(): SeoulMetroStation[] {
  if (cache) return cache;
  const filePath = path.join(process.cwd(), "data", "seoul-metro", OFFICIAL_CSV);
  try {
    const buf = readFileSync(filePath);
    // Official portal CSV is CP949/EUC-KR.
    const text = new TextDecoder("euc-kr").decode(buf);
    cache = parseCsv(text);
  } catch {
    cache = [];
  }
  return cache;
}

/**
 * Nearest Seoul Metro 1–8 stations by straight-line distance.
 * Caps results — not a metro-wide UI dump.
 * Do not merge same-name hubs: distinguish by station code / line from file.
 */
export function nearestSeoulMetroStations(
  center: LatLng,
  opts?: { limit?: number; maxMeters?: number },
): NearbyMetroStation[] {
  const limit = opts?.limit ?? 5;
  const maxMeters = opts?.maxMeters ?? 1500;
  const stations = loadSeoulMetroStations();
  if (!stations.length) return [];

  return stations
    .map((s) => {
      const distanceMeters = Math.round(
        haversineMeters(center.lat, center.lng, s.lat, s.lng),
      );
      return {
        ...s,
        distanceMeters,
        distanceLabel: straightDistanceLabel(distanceMeters),
      };
    })
    .filter((s) => s.distanceMeters <= maxMeters)
    .sort((a, b) => a.distanceMeters - b.distanceMeters)
    .slice(0, limit);
}

export function seoulMetroCsvFileName(): string {
  return OFFICIAL_CSV;
}

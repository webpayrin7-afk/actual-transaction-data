/**
 * Official Seoul Metro station coordinates (lines 1–8 + line 9 phase 2/3).
 * Sources:
 * - 서울교통공사_1-8호선 역사 좌표(위경도) 정보_20250814.csv (OA-22534)
 * - 서울교통공사_9호선 2_3단계 역사 좌표(위경도) 정보_20260131.csv
 * - 서울교통공사_역주소_및_전화번호 (anomaly address fallback only)
 *
 * Coordinate priority:
 *   1. SEOUL_METRO_OFFICIAL — official CSV when not anomalous
 *   2. NAVER_GEOCODE_OFFICIAL_STATION_ADDRESS — duplicate-coord anomaly →
 *      official station address (stationCode + line) → NAVER Geocode
 *   3. HOLD — omit station (never midpoint / line-order interpolation)
 *
 * Runtime file read only. No DB writes. No invented lines / hardcoded lat·lng.
 */

import { readFileSync } from "fs";
import path from "path";
import { haversineMeters, type LatLng } from "@/lib/complex-detail/geo";

export type MetroCoordinateSource =
  | "SEOUL_METRO_OFFICIAL"
  | "NAVER_GEOCODE_OFFICIAL_STATION_ADDRESS";

export type SeoulMetroStation = {
  sourceId: string;
  line: string;
  stationCode: string;
  name: string;
  lat: number;
  lng: number;
  source: "SEOUL_METRO_1_8" | "SEOUL_METRO_9_PHASE23";
  /** Provenance of lat/lng. Not shown in UI. */
  coordinateSource: MetroCoordinateSource;
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

type StationAddressRow = {
  line: string;
  stationCode: string;
  name: string;
  roadAddress: string;
  jibunAddress: string;
};

type GeocodeCacheEntry = {
  line: string;
  stationCode: string;
  name?: string;
  lat: number;
  lng: number;
  queryUsed?: string;
  officialRoadAddress?: string;
  officialJibunAddress?: string;
};

const CSV_1_8 =
  "서울교통공사_1-8호선 역사 좌표(위경도) 정보_20250814.csv";
const CSV_9 =
  "서울교통공사_9호선 2_3단계 역사 좌표(위경도) 정보_20260131.csv";
const CSV_ADDRESS = "서울교통공사_역주소_및_전화번호_20260212.csv";
const GEOCODE_CACHE_FILE = "station-address-geocode-cache.json";

/** Same-name hubs merge only when coordinates are this close (meters). */
const MERGE_MAX_METERS = 400;

/**
 * Official CSV sometimes repeats another station’s coordinates for a different
 * name (e.g. 잠실새내 ≈ 잠실나루). Detect for address + NAVER geocode fallback.
 */
const DUPLICATE_COORD_METERS = 30;

let cache: SeoulMetroStation[] | null = null;
let addressCache: Map<string, StationAddressRow> | null = null;
let geocodeCache: Map<string, GeocodeCacheEntry> | null = null;

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

function identityKey(line: string, stationCode: string): string {
  return `${normalizeLineNumber(line)}:${stationCode.trim()}`;
}

function parseCsv1to8(text: string): SeoulMetroStation[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map((h) => h.trim());
  const idx = {
    line: header.indexOf("호선"),
    code: header.findIndex(
      (h) => h.includes("고유역번호") || h.includes("외부역코드"),
    ),
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
      coordinateSource: "SEOUL_METRO_OFFICIAL",
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
      coordinateSource: "SEOUL_METRO_OFFICIAL",
    });
  }
  return out;
}

function readDataFile(fileName: string): Buffer | null {
  const filePath = path.join(process.cwd(), "data", "seoul-metro", fileName);
  try {
    return readFileSync(filePath);
  } catch {
    return null;
  }
}

function readCsvFile(fileName: string): string | null {
  const buf = readDataFile(fileName);
  if (!buf) return null;
  try {
    return new TextDecoder("euc-kr").decode(buf);
  } catch {
    return buf.toString("utf8");
  }
}

function loadStationAddresses(): Map<string, StationAddressRow> {
  if (addressCache) return addressCache;
  const map = new Map<string, StationAddressRow>();
  const text = readCsvFile(CSV_ADDRESS);
  if (!text) {
    addressCache = map;
    return map;
  }
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) {
    addressCache = map;
    return map;
  }
  const header = lines[0].split(",").map((h) => h.trim());
  const idx = {
    code: header.indexOf("역번호"),
    line: header.indexOf("호선"),
    name: header.indexOf("역명"),
    road: header.indexOf("도로명주소"),
    jibun: header.indexOf("지번주소"),
  };
  if (idx.code < 0 || idx.line < 0) {
    addressCache = map;
    return map;
  }
  for (const row of lines.slice(1)) {
    const cols = row.split(",");
    const stationCode = (cols[idx.code] ?? "").trim();
    const line = normalizeLineNumber(cols[idx.line] ?? "");
    if (!stationCode || !line) continue;
    map.set(identityKey(line, stationCode), {
      line,
      stationCode,
      name: (cols[idx.name] ?? "").trim(),
      roadAddress: idx.road >= 0 ? (cols[idx.road] ?? "").trim() : "",
      jibunAddress: idx.jibun >= 0 ? (cols[idx.jibun] ?? "").trim() : "",
    });
  }
  addressCache = map;
  return map;
}

function loadGeocodeCache(): Map<string, GeocodeCacheEntry> {
  if (geocodeCache) return geocodeCache;
  const map = new Map<string, GeocodeCacheEntry>();
  const buf = readDataFile(GEOCODE_CACHE_FILE);
  if (!buf) {
    geocodeCache = map;
    return map;
  }
  try {
    const json = JSON.parse(buf.toString("utf8")) as Record<
      string,
      GeocodeCacheEntry | string
    >;
    for (const [key, value] of Object.entries(json)) {
      if (!value || typeof value !== "object") continue;
      if (!Number.isFinite(value.lat) || !Number.isFinite(value.lng)) continue;
      map.set(key, value);
    }
  } catch {
    // fail closed — anomalies without cache become HOLD
  }
  geocodeCache = map;
  return map;
}

/**
 * Resolve duplicate-coordinate anomalies:
 * detect → keep geographically consistent official row → for others,
 * official address (code+line) + NAVER geocode. Never midpoint interpolate.
 * Unresolved anomalies are HOLD (omitted).
 */
function resolveAnomalousCoordinates(
  stations: SeoulMetroStation[],
): SeoulMetroStation[] {
  if (stations.length < 2) return stations;

  const clusters: string[][] = [];
  const seen = new Set<string>();
  for (let i = 0; i < stations.length; i++) {
    const a = stations[i];
    if (seen.has(a.sourceId)) continue;
    const cluster = [a.sourceId];
    for (let j = i + 1; j < stations.length; j++) {
      const b = stations[j];
      if (
        normalizeMetroStationName(a.name) ===
        normalizeMetroStationName(b.name)
      ) {
        continue;
      }
      if (
        haversineMeters(a.lat, a.lng, b.lat, b.lng) <= DUPLICATE_COORD_METERS
      ) {
        cluster.push(b.sourceId);
      }
    }
    if (cluster.length > 1) {
      for (const id of cluster) seen.add(id);
      clusters.push(cluster);
    }
  }
  if (clusters.length === 0) return stations;

  const byLine = new Map<string, SeoulMetroStation[]>();
  for (const s of stations) {
    const list = byLine.get(s.line) ?? [];
    list.push(s);
    byLine.set(s.line, list);
  }
  for (const list of byLine.values()) {
    list.sort(
      (a, b) =>
        Number(a.stationCode || 0) - Number(b.stationCode || 0) ||
        a.name.localeCompare(b.name, "ko"),
    );
  }

  const byId = new Map(stations.map((s) => [s.sourceId, s]));
  const addresses = loadStationAddresses();
  const geocodes = loadGeocodeCache();

  const neighborsOf = (
    s: SeoulMetroStation,
    excludeIds: Set<string>,
  ): { prev: SeoulMetroStation | null; next: SeoulMetroStation | null } => {
    const lineStations = byLine.get(s.line) ?? [];
    const idx = lineStations.findIndex((x) => x.sourceId === s.sourceId);
    if (idx < 0) return { prev: null, next: null };
    let prev: SeoulMetroStation | null = null;
    let next: SeoulMetroStation | null = null;
    for (let i = idx - 1; i >= 0; i--) {
      if (!excludeIds.has(lineStations[i].sourceId)) {
        prev = lineStations[i];
        break;
      }
    }
    for (let i = idx + 1; i < lineStations.length; i++) {
      if (!excludeIds.has(lineStations[i].sourceId)) {
        next = lineStations[i];
        break;
      }
    }
    return { prev, next };
  };

  /** Chooses which duplicate keeps official CSV — never invents coordinates. */
  const orderError = (
    s: SeoulMetroStation,
    excludeIds: Set<string>,
  ): number => {
    const { prev, next } = neighborsOf(s, excludeIds);
    if (!prev || !next) return Number.POSITIVE_INFINITY;
    const expLat = (prev.lat + next.lat) / 2;
    const expLng = (prev.lng + next.lng) / 2;
    return haversineMeters(s.lat, s.lng, expLat, expLng);
  };

  const repairIds = new Set<string>();
  for (const cluster of clusters) {
    const exclude = new Set(cluster);
    let keepId = cluster[0];
    let best = Number.POSITIVE_INFINITY;
    for (const id of cluster) {
      const s = byId.get(id);
      if (!s) continue;
      const err = orderError(s, exclude);
      if (err < best) {
        best = err;
        keepId = id;
      }
    }
    for (const id of cluster) {
      if (id !== keepId) repairIds.add(id);
    }
  }

  const holdIds = new Set<string>();
  const repaired = new Map<string, SeoulMetroStation>();

  for (const id of repairIds) {
    const s = byId.get(id);
    if (!s) continue;
    const key = identityKey(s.line, s.stationCode);
    const addr = addresses.get(key);
    const geo = geocodes.get(key);
    // Identity join: stationCode + line must exist in official address file.
    if (
      !addr ||
      !geo ||
      !Number.isFinite(geo.lat) ||
      !Number.isFinite(geo.lng)
    ) {
      holdIds.add(id);
      continue;
    }
    repaired.set(id, {
      ...s,
      lat: geo.lat,
      lng: geo.lng,
      coordinateSource: "NAVER_GEOCODE_OFFICIAL_STATION_ADDRESS",
    });
  }

  return stations
    .filter((s) => !holdIds.has(s.sourceId))
    .map((s) => repaired.get(s.sourceId) ?? s);
}

export function loadSeoulMetroStations(): SeoulMetroStation[] {
  if (cache) return cache;
  const out: SeoulMetroStation[] = [];
  const t18 = readCsvFile(CSV_1_8);
  if (t18) out.push(...parseCsv1to8(t18));
  const t9 = readCsvFile(CSV_9);
  if (t9) out.push(...parseCsvLine9(t9));
  cache = resolveAnomalousCoordinates(out);
  return cache;
}

/** Test helper — clears module caches between QA runs. */
export function __resetSeoulMetroStationCacheForTests(): void {
  cache = null;
  addressCache = null;
  geocodeCache = null;
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
 * Default: all stations within ≤800m (no count cap). Optional `limit` still
 * available for callers that need a hard cap.
 */
export function nearestSeoulMetroStations(
  center: LatLng,
  opts?: { limit?: number; maxMeters?: number },
): NearbyMetroStationGroup[] {
  /** UI display radius: keep ≤800m; never pad with farther stations. */
  const maxMeters = opts?.maxMeters ?? 800;
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

  const merged = mergeNearbyStations(ranked);
  if (opts?.limit != null && opts.limit >= 0) {
    return merged.slice(0, opts.limit);
  }
  return merged;
}

export function seoulMetroCsvFileNames(): string[] {
  return [CSV_1_8, CSV_9, CSV_ADDRESS];
}

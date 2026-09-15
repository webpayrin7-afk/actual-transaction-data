#!/usr/bin/env node
/**
 * Build tiny 잠실엘스 nearby-transport pilot artifact.
 *
 * Subway: official Seoul Metro 1–8 CSV (local file already in repo)
 * Bus:    공공데이터포털 전국버스정류소표준데이터 → TAGO BusSttnInfoInqireService
 *         OpenAPI getCrdntPrxmtSttnList (server-side; uses MOLIT_API_KEY)
 *
 * Does NOT commit national dumps. No VWorld. No DB writes. No route invention.
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

const TAGO_BASE =
  "https://apis.data.go.kr/1613000/BusSttnInfoInqireService";
const TAGO_OP = "getCrdntPrxmtSttnList";

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

function molitServiceKey() {
  const raw = (process.env.MOLIT_API_KEY || "").trim();
  if (!raw) return null;
  return raw.includes("%") ? raw : encodeURIComponent(raw);
}

async function fetchTagoBusNearby() {
  const key = molitServiceKey();
  const serviceMeta = {
    service: "국토교통부_(TAGO)_버스정류소정보",
    dataset: "전국버스정류소표준데이터",
    datasetId: "15096280",
    operation: TAGO_OP,
    accessMethod: "OpenAPI",
    responseFormat: "JSON",
    serviceKeyEnv: "MOLIT_API_KEY",
  };

  if (!key) {
    return {
      ...serviceMeta,
      file: null,
      status: "HOLD",
      reason: "MOLIT_API_KEY missing (server-only 공공데이터포털 ServiceKey)",
      rowsReceived: 0,
      validCoordinates: 0,
      routeMetadataAvailable: false,
      nearby: [],
    };
  }

  const qs = new URLSearchParams({
    pageNo: "1",
    numOfRows: "100",
    _type: "json",
    gpsLati: String(CENTER.lat),
    gpsLong: String(CENTER.lng),
  });
  const url = `${TAGO_BASE}/${TAGO_OP}?serviceKey=${key}&${qs.toString()}`;

  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      return {
        ...serviceMeta,
        file: null,
        status: "HOLD",
        reason: `TAGO HTTP ${res.status}`,
        rowsReceived: 0,
        validCoordinates: 0,
        routeMetadataAvailable: false,
        nearby: [],
      };
    }
    const json = await res.json();
    const header = json?.response?.header || {};
    const code = String(header.resultCode ?? "");
    if (code && code !== "00" && code !== "0") {
      return {
        ...serviceMeta,
        file: null,
        status: "HOLD",
        reason: `TAGO resultCode=${code} ${header.resultMsg || ""}`,
        rowsReceived: 0,
        validCoordinates: 0,
        routeMetadataAvailable: false,
        nearby: [],
      };
    }

    const rawItems = json?.response?.body?.items;
    let list = [];
    if (rawItems && rawItems !== "" && typeof rawItems === "object") {
      const item = rawItems.item;
      list = Array.isArray(item) ? item : item ? [item] : [];
    }
    const rowsReceived =
      typeof json?.response?.body?.totalCount === "number"
        ? json.response.body.totalCount
        : list.length;

    const valid = [];
    for (const raw of list) {
      const name = String(raw.nodenm ?? raw.nodeNm ?? "").trim();
      const id = String(raw.nodeid ?? raw.nodeId ?? "").trim();
      const lat = Number(raw.gpslati ?? raw.gpsLati);
      const lng = Number(raw.gpslong ?? raw.gpsLong);
      if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      if (Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
      if (lat === 0 && lng === 0) continue;
      valid.push({
        id: id || `bus-${lat},${lng}-${name}`,
        name,
        lat,
        lng,
        source: "NATIONAL_BUS_STOP_STANDARD",
      });
    }

    const nearby = nearbyOf(valid, BUS_RADIUS_M).map((b) => ({
      id: b.id,
      name: b.name,
      lat: b.lat,
      lng: b.lng,
      distanceMeters: b.distanceMeters,
      distanceLabel: b.distanceLabel,
      source: b.source,
    }));

    if (nearby.length > 0) {
      return {
        ...serviceMeta,
        file: null,
        status: "PASS",
        reason: null,
        rowsReceived,
        validCoordinates: valid.length,
        routeMetadataAvailable: false,
        nearby,
      };
    }

    return {
      ...serviceMeta,
      file: null,
      status: "HOLD",
      reason:
        rowsReceived === 0
          ? "TAGO getCrdntPrxmtSttnList returned 0 stops near 잠실엘스 (서울 coverage gap in this service)"
          : `TAGO returned ${rowsReceived} rows but none within ${BUS_RADIUS_M}m`,
      rowsReceived,
      validCoordinates: valid.length,
      routeMetadataAvailable: false,
      nearby: [],
    };
  } catch (e) {
    return {
      ...serviceMeta,
      file: null,
      status: "HOLD",
      reason: `TAGO fetch failed: ${e instanceof Error ? e.message : String(e)}`,
      rowsReceived: 0,
      validCoordinates: 0,
      routeMetadataAvailable: false,
      nearby: [],
    };
  }
}

async function main() {
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

  const bus = await fetchTagoBusNearby();

  const artifact = {
    complex: {
      name: "잠실엘스",
      center: CENTER,
    },
    sources: {
      subway: subwayMeta,
      bus: {
        file: null,
        service: bus.service,
        dataset: bus.dataset,
        datasetId: bus.datasetId,
        operation: bus.operation,
        accessMethod: bus.accessMethod,
        responseFormat: bus.responseFormat,
        serviceKeyEnv: bus.serviceKeyEnv,
        status: bus.status,
        reason: bus.reason,
        rowsReceived: bus.rowsReceived,
        validCoordinates: bus.validCoordinates,
        routeMetadataAvailable: false,
      },
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
    bus: bus.nearby,
    radiiMeters: {
      subway: SUBWAY_RADIUS_M,
      bus: BUS_RADIUS_M,
    },
    generatedAt: new Date().toISOString(),
    note: "Pilot extract only. Subway=official CSV. Bus=공공데이터포털 TAGO OpenAPI (not local file). No VWorld. No route invention.",
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
          status: bus.status,
          nearby: artifact.bus.length,
          reason: bus.reason,
          rowsReceived: bus.rowsReceived,
        },
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

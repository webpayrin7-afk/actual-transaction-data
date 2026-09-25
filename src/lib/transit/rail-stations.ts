/**
 * 전국 도시철도 역 (rail_stations, 공공데이터포털 전국도시철도역사정보표준데이터). 읽기 전용.
 * 좌표는 원천 역위도·역경도 그대로. 같은 이름 역은 400m 안이면 한 역으로 묶어 노선을 합친다.
 */
import type { Client, InStatement } from "@libsql/client";
import { haversineMeters, type LatLng } from "@/lib/complex-detail/geo";

export type NearbyRailStation = {
  id: string;
  /** "잠실역" */
  name: string;
  /** 흔히 부르는 노선 이름 ("2호선", "수인분당선", "부산1호선") */
  lines: string[];
  lat: number;
  lng: number;
  distanceMeters: number;
  distanceLabel: string;
};

const MERGE_MAX_METERS = 400;

/**
 * 원천 노선명 → 흔히 부르는 이름. 코레일 구간 이름(경부선·경원선…)은 수도권 전철 노선 번호로 부른다.
 * 목록에 없으면 원천 이름 그대로.
 */
const LINE_ALIAS: Record<string, string> = {
  경부선: "1호선",
  경원선: "1호선",
  경인선: "1호선",
  장항선: "1호선",
  일산선: "3호선",
  안산과천선: "4호선",
  진접선: "4호선",
  분당선: "수인분당선",
  수인선: "수인분당선",
  "도시철도 7호선": "7호선",
  "수도권 광역철도 8호선": "8호선",
  "서울 도시철도 9호선": "9호선",
  "수도권 도시철도 9호선": "9호선",
  "수도권 경량도시철도 신림선": "신림선",
  "인천지하철 1호선": "인천1호선",
  "인천지하철 2호선": "인천2호선",
  "부산 경량도시철도 4호선": "부산4호선",
  "광주도시철도 1호선": "광주1호선",
  김포도시철도: "김포골드라인",
  의정부: "의정부경전철",
  에버라인: "용인에버라인",
  자기부상철도: "인천자기부상철도",
};

/**
 * 경원선 중 용산~왕십리 구간(이촌·서빙고·한남·옥수·응봉·왕십리)은 1호선이 아니라 경의중앙선이 다닌다.
 * 원천은 이 역들도 노선명을 "경원선"으로 적어 두어, 역 이름으로 가른다.
 */
const GYEONGUI_JUNGANG_ON_GYEONGWON = new Set(["이촌", "서빙고", "한남", "옥수", "응봉", "왕십리"]);

export function railLineLabel(raw: string, stationName?: string): string {
  const t = raw.trim().replace(/\s+/g, " ");
  if (t === "경원선" && stationName && GYEONGUI_JUNGANG_ON_GYEONGWON.has(baseName(stationName))) return "경의중앙선";
  if (LINE_ALIAS[t]) return LINE_ALIAS[t];
  const city = t.match(/^(부산|대구|대전) 도시철도 (\d+)호선$/);
  if (city) return `${city[1]}${city[2]}호선`;
  return t;
}

/** "잠실(송파구청)" → "잠실", "광운대역" → "광운대" */
function baseName(name: string): string {
  return name.trim().replace(/\(.*?\)/g, "").replace(/\s+/g, "").replace(/역$/u, "");
}

function distanceLabel(m: number): string {
  if (m < 1000) return `직선거리 ${Math.round(m)}m`;
  const km = m / 1000;
  return `직선거리 ${km < 10 ? km.toFixed(1) : Math.round(km)}km`;
}

function lineOrder(a: string, b: string): number {
  const na = /^\d+호선$/.test(a) ? Number.parseInt(a, 10) : 100;
  const nb = /^\d+호선$/.test(b) ? Number.parseInt(b, 10) : 100;
  return na - nb || a.localeCompare(b, "ko");
}

let tableChecked: boolean | null = null;

/** 반경 안 역을 찾는 사각형 조회 문장 — 다른 조회와 한 번에(batch) 보낼 수 있다. 결과는 {@link rankNearbyRailStations}로. */
export function railStationsBoxStatement(center: LatLng, maxMeters: number): InStatement {
  const dLat = maxMeters / 111_320;
  const dLng = maxMeters / (111_320 * Math.cos((center.lat * Math.PI) / 180));
  return {
    sql: `SELECT station_key, name, line_name, lat, lng FROM rail_stations
            WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?`,
    args: [center.lat - dLat, center.lat + dLat, center.lng - dLng, center.lng + dLng],
  };
}

/** 사각형 조회 행 → 반경 안 역 (가까운 순, 같은 이름 400m 안은 한 역으로). */
export function rankNearbyRailStations(
  rows: ReadonlyArray<Record<string, unknown>>,
  center: LatLng,
  maxMeters: number,
  limit?: number,
): NearbyRailStation[] {
  const ranked = rows
    .map((r) => {
      const lat = Number(r.lat);
      const lng = Number(r.lng);
      return {
        key: String(r.station_key),
        name: String(r.name),
        line: railLineLabel(String(r.line_name), String(r.name)),
        lat,
        lng,
        d: Math.round(haversineMeters(center.lat, center.lng, lat, lng)),
      };
    })
    .filter((s) => s.d <= maxMeters)
    .sort((a, b) => a.d - b.d);

  const groups: Array<NearbyRailStation & { base: string }> = [];
  for (const s of ranked) {
    const base = baseName(s.name);
    const g = groups.find(
      (x) => x.base === base && haversineMeters(x.lat, x.lng, s.lat, s.lng) <= MERGE_MAX_METERS,
    );
    if (g) {
      if (!g.lines.includes(s.line)) g.lines.push(s.line);
      continue;
    }
    groups.push({
      id: `rail-${s.key}`,
      base,
      name: `${base}역`,
      lines: [s.line],
      lat: s.lat,
      lng: s.lng,
      distanceMeters: s.d,
      distanceLabel: distanceLabel(s.d),
    });
  }
  const out: NearbyRailStation[] = groups.map((g) => ({
    id: g.id,
    name: g.name,
    lines: [...g.lines].sort(lineOrder),
    lat: g.lat,
    lng: g.lng,
    distanceMeters: g.distanceMeters,
    distanceLabel: g.distanceLabel,
  }));
  return limit != null ? out.slice(0, limit) : out;
}

/** 반경 안 역 (가까운 순). 테이블이 없거나 실패하면 빈 목록 — 실패는 onFailure로 알린다. */
export async function readNearbyRailStations(
  db: Client,
  center: LatLng,
  opts?: { maxMeters?: number; limit?: number; onFailure?: (source: string) => void },
): Promise<NearbyRailStation[]> {
  const maxMeters = opts?.maxMeters ?? 800;
  try {
    if (tableChecked == null) {
      tableChecked =
        (await db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='rail_stations'")).rows.length > 0;
    }
    if (!tableChecked) return [];
    const res = await db.execute(railStationsBoxStatement(center, maxMeters));
    return rankNearbyRailStations(res.rows, center, maxMeters, opts?.limit);
  } catch {
    opts?.onFailure?.("rail-stations");
    return [];
  }
}

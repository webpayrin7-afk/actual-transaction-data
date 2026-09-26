/**
 * 단지 → 역 출구·학교·버스정류장 걷기 경로 (서버 전용, 읽기만 — DB에 쓰지 않는다).
 *
 * 길: OpenStreetMap (Overpass API, 단지 중심 ±1.1km 한 번 조회, 메모리 캐시) — © OpenStreetMap contributors, ODbL.
 * 경사: terrain.ts 표고 원천 (고해상도가 있으면 그것) + Tobler 보행 함수 (평지 4.5km/h로 맞춤).
 * 횡단: OSM 횡단보도·신호 태그 + (활용신청 되어 있으면) 전국횡단보도표준데이터 신호 시간 → 기대 신호 대기 = 적색² / (2 × 주기).
 * 출발: 동마다 — 동 외곽선에 붙은 OSM 출입구(entrance)가 있으면 그 점, 없으면 동 가운데에서 가장 가까운 보행 길.
 *       단지 안 사유 도로(access=private)는 단지 경계 안에서만 걷는다. 단지 문(barrier=gate 등)은 길 그래프에 그대로 있다.
 */
import type { Ring } from "@/lib/complex-3d/read";
import { bboxAround, elevationSampler, type Bbox, type ElevationInfo, type Sampler } from "@/lib/complex-3d/terrain";
import { loadCrosswalks, type Crosswalk } from "@/lib/complex-3d/crosswalks";
import type { WalkerId } from "@/lib/complex-3d/walker-profiles";

export const WALK_HALF_M = 1100;
const STATION_MAX_M = 1000;
const BASE_MPS = 4.5 / 3.6;
const DENSIFY_M = 15;
/** 거울 서버를 차례로 — 한 곳당 짧게 기다려 함수 제한(60초) 안에 끝낸다 */
const OVERPASS_MIRRORS: Array<{ url: string; ms: number }> = [
  { url: "https://overpass.kumi.systems/api/interpreter", ms: 14_000 },
  { url: "https://overpass.private.coffee/api/interpreter", ms: 12_000 },
  { url: "https://overpass-api.de/api/interpreter", ms: 14_000 },
];
const UA = "ZIPLAB-3d-walk/0.1 (apartment walking-route prototype; low volume, cached)";

// ── 입력·출력 ────────────────────────────────────────────────────────────────
export type WalkInput = {
  complexId: string;
  center: { lat: number; lng: number };
  sigungu: string | null;
  buildings: Array<{ id: string; dong: string | null; residential: boolean; rings: Ring[] | null }>;
  schools: Array<{ name: string; level: string | null; lat: number; lng: number }>;
  stations: Array<{ name: string; lines: string[]; lat: number; lng: number }>;
};

export type WalkMark = { lng: number; lat: number; kind: "crossing" | "gate" | "steps" | "underpass" | "overpass"; major?: boolean; signal?: boolean };

export type WalkDestination = {
  id: string;
  kind: "subway" | "school" | "bus";
  name: string;
  sub: string | null;
  target: { lng: number; lat: number };
  straightM: number;
  distanceM: number;
  walkSec: number;
  waitSec: number;
  totalMin: number;
  walkMin: number;
  gainM: number;
  lossM: number;
  maxGradePct: number;
  crossings: number;
  signalCrossings: number;
  majorCrossing: boolean;
  steps: boolean;
  /** 다른 단지 안 길(사유지)로 지나간 거리 */
  throughPrivateM: number;
  underpasses: number;
  overpasses: number;
  gate: string | null;
  /** 동별 걸리는 시간(분, 신호 대기 포함) */
  perDong: Array<{ buildingId: string; min: number }>;
  range: [number, number] | null;
  points: Array<[number, number]>;
  marks: WalkMark[];
};

export type WalkPayload = {
  complexId: string;
  mode: "walk" | "wheel";
  from: { buildingId: string; dong: string | null; door: "entrance" | "building"; accessM: number };
  dongs: Array<{ buildingId: string; dong: string }>;
  destinations: WalkDestination[];
  terrain: ElevationInfo | null;
  crosswalkData: { status: string; note: string };
  network: { ways: number; nodes: number; crossingNodes: number; signalNodes: number; fetchedAt: string };
  assumptions: string[];
  attribution: string;
  /** 걷는 사람을 고른 요청 — 시간은 평지 속도 비율로 바꿔 두었다. timeScale = 기본(4.5km/h) 걷는 시간 대비 */
  walker?: { id: WalkerId; mps: number; timeScale: number };
};

// ── 걷는 사람별 속도 ─────────────────────────────────────────────────────────
/**
 * 평지 보행 속도 (m/s) — 경로 계산의 기본값(4.5km/h = 1.25 m/s)에 곱할 비율로 쓴다.
 *  - 성인 남성 1.35 / 성인 여성 1.27: 편한 걸음 속도 메타분석 (Bohannon & Andrews 2011, Physiotherapy 97(3)) 20~50대 범위,
 *    한 걸음 남 0.75m·여 0.66m (키 × 약 0.41~0.43).
 *  - 어르신 1.0: 경찰청 「교통신호기 설치·관리 매뉴얼」 보행 신호 시간 산정 보행속도 1.0 m/s (노인·어린이 보호구역은 0.8 m/s),
 *    Knoblauch et al. 1996 (TRR 1538) 고령 보행자 하위 15% 약 0.97 m/s 와 맞다.
 *  - 어린이(초등) 1.1: 보호구역 설계 속도(0.8)와 성인 사이 — 초등 저·고학년 편한 걸음 평균 범위.
 * 기울기(Tobler)·계단 배율·신호 대기는 그대로 — 평지 속도만 달라서 걷는 시간이 속도 비율만큼 늘거나 준다.
 */
export const WALKER_MPS: Record<WalkerId, number> = { male: 1.35, female: 1.27, child: 1.1, elder: 1.0 };

/**
 * 저장된 기본 결과(평지 1.25 m/s)를 걷는 사람 속도로 바꾼다 — 보행망을 다시 계산하지 않는다.
 * 걷는 시간은 모든 구간이 평지 속도에 반비례하므로 정확히 비율만 곱하면 된다. 신호 대기는 그대로.
 * 동별 시간(perDong)은 걷기·대기가 합쳐져 있어 대표 경로의 걷기 비중으로 나눠 근사한다.
 * 고른 경로 자체는 기본 속도로 찾은 길 그대로 (느린 걸음이라 다른 길이 더 빠른 경우는 드물고 차이가 작다).
 */
export function applyWalker(p: WalkPayload, id: WalkerId): WalkPayload {
  const mps = WALKER_MPS[id];
  const r = BASE_MPS / mps;
  const min = (s: number) => Math.max(1, Math.round(s / 60));
  return {
    ...p,
    walker: { id, mps, timeScale: Math.round(r * 10000) / 10000 },
    destinations: p.destinations.map((d) => {
      const walkSec = Math.round(d.walkSec * r);
      const total0 = Math.max(1, d.walkSec + d.waitSec);
      const k = (walkSec + d.waitSec) / total0;
      const perDong = d.perDong.map((x) => ({ ...x, min: Math.max(1, Math.round(x.min * k)) }));
      const mins = perDong.map((x) => x.min);
      return {
        ...d,
        walkSec,
        totalMin: min(walkSec + d.waitSec),
        walkMin: min(walkSec),
        perDong,
        range: mins.length ? [Math.min(...mins), Math.max(...mins)] : null,
      };
    }),
    assumptions: [`평지 속도 ${mps.toFixed(2)} m/s (걷는 사람: ${id}) — 기본 4.5km/h 결과의 걷는 시간에 ${r.toFixed(3)}배`, ...p.assumptions],
  };
}

// ── OSM ──────────────────────────────────────────────────────────────────────
export type Tags = Record<string, string>;
export type OsmEl =
  | { type: "node"; id: number; lat: number; lon: number; tags?: Tags }
  | { type: "way"; id: number; nodes: number[]; tags?: Tags; center?: { lat: number; lon: number } }
  | { type: "relation"; id: number; tags?: Tags; center?: { lat: number; lon: number } };

export const WALK_HW = new Set([
  "footway", "path", "pedestrian", "steps", "living_street", "residential", "service", "tertiary", "tertiary_link",
  "secondary", "secondary_link", "primary", "primary_link", "unclassified", "track", "cycleway", "corridor", "road",
  "trunk", "trunk_link", "bridleway",
]);
const ROAD_RANK: Record<string, number> = {
  trunk: 4, trunk_link: 4, primary: 3, primary_link: 3, secondary: 3, secondary_link: 3,
  tertiary: 2, tertiary_link: 2, unclassified: 1, residential: 1, living_street: 1, road: 1,
};

function overpassQuery(b: Bbox): string {
  const bb = `${b.south.toFixed(6)},${b.west.toFixed(6)},${b.north.toFixed(6)},${b.east.toFixed(6)}`;
  return `[out:json][timeout:25][bbox:${bb}];
way[highway]->.w;
(.w;>;)->.wn;
(node[railway=subway_entrance];node[railway~"^(station|halt)$"];node[public_transport=station];node[highway=bus_stop];node[entrance];node[highway=traffic_signals];)->.p;
.w out body qt;
.wn out qt;
.p out body qt;`;
}

/** 거울 서버 주소 (미리 만들기 스크립트가 돌려 가며 쓴다) */
export const OVERPASS_MIRROR_URLS = OVERPASS_MIRRORS.map((m) => m.url);

/** Overpass 실패 — HTTP 상태(429·504 등)를 붙여 부르는 쪽이 쉬었다 갈지 정하게 */
export class OverpassError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
  }
}

/** 거울 한 곳에 한 번만 묻는다 */
export async function fetchOverpassOnce(b: Bbox, url: string, ms: number): Promise<{ elements: OsmEl[]; source: string }> {
  const res = await fetch(url, {
    method: "POST",
    body: new URLSearchParams({ data: overpassQuery(b) }),
    headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(ms),
  });
  if (!res.ok) throw new OverpassError(`overpass ${res.status}`, res.status);
  const json = (await res.json()) as { elements?: OsmEl[]; remark?: string };
  if (!json.elements?.length) throw new OverpassError(`overpass empty ${json.remark ?? ""}`.trim(), null);
  return { elements: json.elements, source: new URL(url).host };
}

export async function fetchOverpass(b: Bbox): Promise<{ elements: OsmEl[]; source: string }> {
  let last: unknown = null;
  for (const { url, ms } of OVERPASS_MIRRORS) {
    try {
      return await fetchOverpassOnce(b, url, ms);
    } catch (e) {
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error("overpass failed");
}

// ── 그래프 ───────────────────────────────────────────────────────────────────
const F_STEPS = 1;
const F_CROSSWAY = 2;
const F_TUNNEL = 4;
const F_BRIDGE = 8;
const F_FOOT = 16;
/** 다른 단지 안 사유 통로 — 실제로 걸어 지나가는 일이 많아 막지는 않고 1.4배 비용 + 표시 */
const F_PRIVATE = 32;
const PRIVATE_FACTOR = 1.4;

type Graph = {
  center: { lat: number; lng: number };
  mPerLng: number;
  x: Float64Array;
  z: Float64Array;
  h: Float32Array;
  osmId: Float64Array; // 0 = 나눈 점
  nodeTags: Map<number, Tags>;
  nodeRoadWays: Map<number, number[]>; // 노드 → 지나는 차도 way (서비스 도로 제외)
  eu: Int32Array;
  ev: Int32Array;
  elen: Float32Array;
  eway: Int32Array;
  eflag: Uint8Array;
  adjStart: Int32Array;
  adjEdge: Int32Array;
  ways: Array<{ id: number; tags: Tags; rank: number }>;
  blocked: Uint8Array; // 지나갈 수 없는 노드 (담·펜스·잠긴 문)
  wheelHard: Uint8Array; // 휠체어 곤란 (높은 턱·회전문)
  crossingNode: Uint8Array;
  signalNode: Uint8Array;
  grid: Map<string, number[]>;
  pois: OsmEl[];
  sampler: Sampler | null;
  hull: Array<{ x: number; z: number }>;
  fetchedAt: string;
  wayCount: number;
};

const CELL = 40;
const cellKey = (x: number, z: number) => `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;

function convexHull(pts: Array<{ x: number; z: number }>): Array<{ x: number; z: number }> {
  const p = [...pts].sort((a, b) => a.x - b.x || a.z - b.z);
  if (p.length < 3) return p;
  const cross = (o: { x: number; z: number }, a: { x: number; z: number }, b: { x: number; z: number }) =>
    (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
  const lower: typeof p = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: typeof p = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

function segDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz || 1)));
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

function inPoly(x: number, z: number, poly: Array<{ x: number; z: number }>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

function nearHull(x: number, z: number, hull: Array<{ x: number; z: number }>, buffer: number): boolean {
  if (hull.length < 3) return false;
  if (inPoly(x, z, hull)) return true;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i]!;
    const b = hull[(i + 1) % hull.length]!;
    if (segDist(x, z, a.x, a.z, b.x, b.z) <= buffer) return true;
  }
  return false;
}

const FOOT_OK = new Set(["yes", "designated", "permissive"]);

function wayUsable(t: Tags): boolean {
  if (!WALK_HW.has(t.highway ?? "")) return false;
  if (t.foot === "no" || t.foot === "use_sidepath") return false;
  if ((t.highway === "trunk" || t.highway === "trunk_link") && (t.motorroad === "yes" || !FOOT_OK.has(t.foot ?? "") && t.sidewalk === "no"))
    return false;
  // 보도가 따로 그려진 큰길은 차도 가운데를 걷지 않게 뺀다 (따로 그린 보도로 걷는다)
  if ((ROAD_RANK[t.highway ?? ""] ?? 0) >= 2 && (t.sidewalk === "separate" || t["sidewalk:both"] === "separate")) return false;
  if (t.area === "yes" && t.highway !== "pedestrian" && t.highway !== "footway") return false;
  if (t.construction || t.highway === "construction") return false;
  return true;
}

function isPrivate(t: Tags): boolean {
  return (t.access === "private" || t.access === "no" || t.access === "customers") && !FOOT_OK.has(t.foot ?? "");
}

/** 걷기 그래프 원천 — 저장본(DB)이 있으면 그것, 없으면 Overpass (성공하면 저장). 부르는 쪽이 정한다. */
export type OsmLoader = (bbox: Bbox) => Promise<OsmEl[]>;

async function buildGraph(input: WalkInput, loadOsm: OsmLoader): Promise<Graph> {
  const { center } = input;
  const bbox = bboxAround(center, WALK_HALF_M);
  const [elements, sampler] = await Promise.all([loadOsm(bbox), elevationSampler(bbox).catch(() => null)]);
  const mPerLng = 111_320 * Math.cos((center.lat * Math.PI) / 180);
  const toX = (lng: number) => (lng - center.lng) * mPerLng;
  const toZ = (lat: number) => -(lat - center.lat) * 111_320;

  // 단지 경계 (주거동 외곽선의 볼록 껍질)
  const hullPts: Array<{ x: number; z: number }> = [];
  for (const b of input.buildings) for (const r of b.rings ?? []) for (const [lng, lat] of r) hullPts.push({ x: toX(lng), z: toZ(lat) });
  const hull = convexHull(hullPts);

  const osmNodes = new Map<number, { lat: number; lon: number; tags?: Tags }>();
  const osmWays: Array<Extract<OsmEl, { type: "way" }>> = [];
  const pois: OsmEl[] = [];
  for (const el of elements) {
    if (el.type === "node") {
      const prev = osmNodes.get(el.id);
      osmNodes.set(el.id, { lat: el.lat, lon: el.lon, tags: el.tags ?? prev?.tags });
      if (el.tags && (el.tags.railway || el.tags.highway === "bus_stop" || el.tags.public_transport || el.tags.entrance)) pois.push(el);
    } else if (el.type === "way" && el.nodes) osmWays.push(el);
  }

  const xs: number[] = [];
  const zs: number[] = [];
  const ids: number[] = [];
  const idx = new Map<number, number>();
  const nodeOf = (osm: number): number => {
    let i = idx.get(osm);
    if (i == null) {
      const n = osmNodes.get(osm)!;
      i = xs.length;
      xs.push(toX(n.lon));
      zs.push(toZ(n.lat));
      ids.push(osm);
      idx.set(osm, i);
    }
    return i;
  };
  const eu: number[] = [];
  const ev: number[] = [];
  const elen: number[] = [];
  const eway: number[] = [];
  const eflag: number[] = [];
  const ways: Graph["ways"] = [];
  const nodeRoadWays = new Map<number, number[]>();

  for (const w of osmWays) {
    const t = w.tags ?? {};
    if (!wayUsable(t)) continue;
    const coords = w.nodes.filter((n) => osmNodes.has(n));
    if (coords.length < 2) continue;
    let foreignPrivate = false;
    if (isPrivate(t)) {
      const own = coords.every((n) => {
        const p = osmNodes.get(n)!;
        return nearHull(toX(p.lon), toZ(p.lat), hull, 25);
      });
      // 우리 단지 안은 그대로. 밖의 access=no는 못 지나가고, private(다른 단지 안 길)은 비용을 올려 둔다
      if (!own) {
        if (t.access === "no") continue;
        foreignPrivate = true;
      }
    }
    const wi = ways.length;
    const rank = t.highway === "service" ? 0 : (ROAD_RANK[t.highway ?? ""] ?? 0);
    ways.push({ id: w.id, tags: t, rank });
    let flag = 0;
    if (t.highway === "steps") flag |= F_STEPS;
    if (t.footway === "crossing" || t.path === "crossing" || t.cycleway === "crossing") flag |= F_CROSSWAY;
    const foot = ["footway", "path", "steps", "pedestrian", "corridor", "cycleway", "bridleway"].includes(t.highway ?? "");
    if (foot) flag |= F_FOOT;
    if (foot && (t.tunnel === "yes" || t.tunnel === "building_passage" || (t.layer && Number(t.layer) < 0 && t.indoor !== "yes"))) flag |= F_TUNNEL;
    if (foot && t.bridge && t.bridge !== "no") flag |= F_BRIDGE;
    if (foreignPrivate) flag |= F_PRIVATE;
    let prev = nodeOf(coords[0]!);
    if (rank >= 1) nodeRoadWays.set(prev, [...(nodeRoadWays.get(prev) ?? []), wi]);
    for (let k = 1; k < coords.length; k++) {
      const cur = nodeOf(coords[k]!);
      if (rank >= 1) nodeRoadWays.set(cur, [...(nodeRoadWays.get(cur) ?? []), wi]);
      const len = Math.hypot(xs[cur]! - xs[prev]!, zs[cur]! - zs[prev]!);
      const parts = Math.max(1, Math.ceil(len / DENSIFY_M));
      let a = prev;
      for (let s = 1; s <= parts; s++) {
        let b: number;
        if (s === parts) b = cur;
        else {
          b = xs.length;
          xs.push(xs[prev]! + ((xs[cur]! - xs[prev]!) * s) / parts);
          zs.push(zs[prev]! + ((zs[cur]! - zs[prev]!) * s) / parts);
          ids.push(0);
        }
        eu.push(a);
        ev.push(b);
        elen.push(len / parts);
        eway.push(wi);
        eflag.push(flag);
        a = b;
      }
      prev = cur;
    }
  }

  const n = xs.length;
  const x = Float64Array.from(xs);
  const z = Float64Array.from(zs);
  const h = new Float32Array(n);
  if (sampler) {
    // 거친 원천(30m 급)은 건물·나무가 섞인 표면이라 한 점씩 튀는 값이 많다 — 원천 해상도 반경의 다섯 점 평균으로 누른다
    const r = sampler.info.resolutionM >= 20 ? sampler.info.resolutionM : 0;
    const at = (px: number, pz: number) => sampler.at(center.lat - pz / 111_320, center.lng + px / mPerLng);
    for (let i = 0; i < n; i++) {
      const px = x[i]!;
      const pz = z[i]!;
      const vals = r ? [at(px, pz), at(px + r, pz), at(px - r, pz), at(px, pz + r), at(px, pz - r)] : [at(px, pz)];
      const ok = vals.filter(Number.isFinite);
      h[i] = ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : 0;
    }
  }
  const deg = new Int32Array(n + 1);
  for (let e = 0; e < eu.length; e++) {
    deg[eu[e]! + 1]!++;
    deg[ev[e]! + 1]!++;
  }
  for (let i = 0; i < n; i++) deg[i + 1]! += deg[i]!;
  const adjStart = Int32Array.from(deg);
  const fill = Int32Array.from(deg);
  const adjEdge = new Int32Array(eu.length * 2);
  for (let e = 0; e < eu.length; e++) {
    adjEdge[fill[eu[e]!]!++] = e;
    adjEdge[fill[ev[e]!]!++] = e;
  }

  const nodeTags = new Map<number, Tags>();
  const blocked = new Uint8Array(n);
  const wheelHard = new Uint8Array(n);
  const crossingNode = new Uint8Array(n);
  const signalNode = new Uint8Array(n);
  const grid = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const k = cellKey(x[i]!, z[i]!);
    const list = grid.get(k);
    if (list) list.push(i);
    else grid.set(k, [i]);
    if (!ids[i]) continue;
    const t = osmNodes.get(ids[i]!)?.tags;
    if (!t) continue;
    nodeTags.set(i, t);
    const barrier = t.barrier;
    if (barrier && ["wall", "fence", "hedge", "retaining_wall", "city_wall"].includes(barrier)) blocked[i] = 1;
    if (barrier && (t.locked === "yes" || t.access === "no" || t.foot === "no") && !FOOT_OK.has(t.foot ?? "")) blocked[i] = 1;
    if (t.kerb === "raised" || barrier === "turnstile" || barrier === "stile" || barrier === "kissing_gate" || t.wheelchair === "no") wheelHard[i] = 1;
    if (t.highway === "crossing" || (t.crossing && t.crossing !== "no") || t.railway === "crossing") crossingNode[i] = 1;
    if (t.crossing === "traffic_signals" || t["crossing:signals"] === "yes" || t.highway === "traffic_signals" || t.crossing_ref === "pelican")
      signalNode[i] = 1;
  }

  return {
    center,
    mPerLng,
    x,
    z,
    h,
    osmId: Float64Array.from(ids),
    nodeTags,
    nodeRoadWays,
    eu: Int32Array.from(eu),
    ev: Int32Array.from(ev),
    elen: Float32Array.from(elen),
    eway: Int32Array.from(eway),
    eflag: Uint8Array.from(eflag),
    adjStart,
    adjEdge,
    ways,
    blocked,
    wheelHard,
    crossingNode,
    signalNode,
    grid,
    pois,
    sampler,
    hull,
    fetchedAt: new Date().toISOString(),
    wayCount: ways.length,
  };
}

function nearestNode(g: Graph, px: number, pz: number, maxM: number, accept?: (i: number) => boolean): { i: number; d: number } | null {
  let best: { i: number; d: number } | null = null;
  const r = Math.ceil(maxM / CELL);
  const cx = Math.floor(px / CELL);
  const cz = Math.floor(pz / CELL);
  for (let dx = -r; dx <= r; dx++)
    for (let dz = -r; dz <= r; dz++) {
      for (const i of g.grid.get(`${cx + dx},${cz + dz}`) ?? []) {
        if (g.blocked[i] || g.adjStart[i + 1] === g.adjStart[i]) continue;
        if (accept && !accept(i)) continue;
        const d = Math.hypot(g.x[i]! - px, g.z[i]! - pz);
        if (d <= maxM && (!best || d < best.d)) best = { i, d };
      }
    }
  return best;
}

/**
 * 한 점 둘레의 길 점들 — 가장 가까운 길에서 extra m 더 먼 곳까지 (최대 maxM, 가까운 순 80개).
 * 단지·학교 안 길이 OSM에 없거나 한쪽으로만 이어질 때, 어느 쪽으로 나가도(들어가도) 되게 여러 점을 후보로 둔다.
 */
function nodesAround(
  g: Graph,
  px: number,
  pz: number,
  maxM: number,
  extra: number,
  accept?: (i: number) => boolean,
): Array<{ i: number; d: number }> {
  const first = nearestNode(g, px, pz, maxM, accept);
  if (!first) return [];
  const r = Math.min(maxM, first.d + extra);
  const out: Array<{ i: number; d: number }> = [];
  const cr = Math.ceil(r / CELL);
  const cx = Math.floor(px / CELL);
  const cz = Math.floor(pz / CELL);
  for (let dx = -cr; dx <= cr; dx++)
    for (let dz = -cr; dz <= cr; dz++)
      for (const i of g.grid.get(`${cx + dx},${cz + dz}`) ?? []) {
        if (g.blocked[i] || g.adjStart[i + 1] === g.adjStart[i] || (accept && !accept(i))) continue;
        const d = Math.hypot(g.x[i]! - px, g.z[i]! - pz);
        if (d <= r) out.push({ i, d });
      }
  return out.sort((a, b) => a.d - b.d).slice(0, 80);
}

/** 길 밖(단지·학교 안) 걷는 거리 보정 — 직선의 1.25배 */
const OFFNET = 1.25;

// ── 비용 ─────────────────────────────────────────────────────────────────────
type Mode = "walk" | "wheel";

/** Tobler 보행 함수 — 평지(약 -2.9% 내리막이 가장 빠름) 4.5km/h 기준 속도(m/s) */
function toblerMps(grade: number): number {
  return (BASE_MPS * Math.exp(-3.5 * Math.abs(grade + 0.05))) / Math.exp(-3.5 * 0.05);
}

function edgeSec(g: Graph, e: number, from: number, to: number, mode: Mode, plain = false): number {
  const len = g.elen[e]!;
  const flag = g.eflag[e]!;
  const dh = g.h[to]! - g.h[from]!;
  // 짧은 구간 경사는 원천 잡음이 크다 — 계단이 아니면 ±25%(서울 가파른 길 수준)로 자른다
  const cap = flag & F_STEPS ? 0.6 : 0.25;
  const grade = len > 1 ? Math.max(-cap, Math.min(cap, dh / len)) : 0;
  let t = len / toblerMps(grade);
  if (flag & F_STEPS) t /= 0.55;
  if (flag & F_PRIVATE && !plain) t *= PRIVATE_FACTOR;
  if (mode === "wheel") {
    if (flag & F_STEPS) t += 900;
    if (Math.abs(grade) > 0.083) t *= 1.6;
  }
  return t;
}

type CrossInfo = { waitSec: number; signal: boolean; major: boolean; cw: Crosswalk | null };

class Heap {
  private d: number[] = [];
  private n: number[] = [];
  get size() {
    return this.d.length;
  }
  push(dist: number, node: number) {
    const d = this.d;
    const nn = this.n;
    d.push(dist);
    nn.push(node);
    let i = d.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (d[p]! <= d[i]!) break;
      [d[p], d[i]] = [d[i]!, d[p]!];
      [nn[p], nn[i]] = [nn[i]!, nn[p]!];
      i = p;
    }
  }
  pop(): [number, number] {
    const d = this.d;
    const nn = this.n;
    const top: [number, number] = [d[0]!, nn[0]!];
    const ld = d.pop()!;
    const ln = nn.pop()!;
    if (d.length) {
      d[0] = ld;
      nn[0] = ln;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < d.length && d[l]! < d[m]!) m = l;
        if (r < d.length && d[r]! < d[m]!) m = r;
        if (m === i) break;
        [d[m], d[i]] = [d[i]!, d[m]!];
        [nn[m], nn[i]] = [nn[i]!, nn[m]!];
        i = m;
      }
    }
    return top;
  }
}

/** reverse=false: sources에서 나가는 시간, reverse=true: sources로 들어오는 시간 */
function dijkstra(
  g: Graph,
  sources: Array<[number, number]>,
  reverse: boolean,
  mode: Mode,
  nodeWait: Float32Array,
  cutoff = 3600,
): { dist: Float64Array; pred: Int32Array } {
  const n = g.x.length;
  const dist = new Float64Array(n).fill(Infinity);
  const pred = new Int32Array(n).fill(-1);
  const heap = new Heap();
  for (const [s, c] of sources) {
    if (c < dist[s]!) {
      dist[s] = c;
      heap.push(c, s);
    }
  }
  while (heap.size) {
    const [d, u] = heap.pop();
    if (d > dist[u]! || d > cutoff) continue;
    for (let k = g.adjStart[u]!; k < g.adjStart[u + 1]!; k++) {
      const e = g.adjEdge[k]!;
      const v = g.eu[e] === u ? g.ev[e]! : g.eu[e]!;
      if (g.blocked[v]) continue;
      // 걷는 방향: forward u→v, reverse v→u
      const cost = reverse ? edgeSec(g, e, v, u, mode) + nodeWait[u]! : edgeSec(g, e, u, v, mode) + nodeWait[v]!;
      const wheel = mode === "wheel" && g.wheelHard[v] ? 300 : 0;
      const nd = d + cost + wheel;
      if (nd < dist[v]!) {
        dist[v] = nd;
        pred[v] = e;
        heap.push(nd, v);
      }
    }
  }
  return { dist, pred };
}

// ── 경로 정리 ────────────────────────────────────────────────────────────────
function simplify(pts: Array<{ x: number; z: number }>, tol: number): number[] {
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let best = -1;
    let bd = tol;
    for (let i = a + 1; i < b; i++) {
      const d = segDist(pts[i]!.x, pts[i]!.z, pts[a]!.x, pts[a]!.z, pts[b]!.x, pts[b]!.z);
      if (d > bd) {
        bd = d;
        best = i;
      }
    }
    if (best > 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  return [...keep.keys()].filter((i) => keep[i]);
}

function expectedWait(signal: boolean, rank: number, cw: Crosswalk | null): number {
  if (cw && cw.signal !== false && cw.greenSec && cw.redSec) {
    const c = cw.greenSec + cw.redSec;
    return (cw.redSec * cw.redSec) / (2 * c);
  }
  if (signal || (cw && cw.signal)) {
    // 가정 주기: 큰길 120초(녹색 30), 중간 길 90초(녹색 25), 작은 길 60초(녹색 20)
    const [gs, c] = rank >= 3 ? [30, 120] : rank === 2 ? [25, 90] : [20, 60];
    const r = c - gs;
    return (r * r) / (2 * c);
  }
  return rank >= 2 ? 5 : 2;
}

type Ctx = {
  g: Graph;
  mode: Mode;
  nodeWait: Float32Array;
  crossAt: (i: number) => CrossInfo | null;
};

function describePath(ctx: Ctx, nodes: number[], edges: number[], accessM: number) {
  const { g } = ctx;
  const toLngLat = (px: number, pz: number): [number, number] => [
    Math.round((g.center.lng + px / g.mPerLng) * 1e6) / 1e6,
    Math.round((g.center.lat - pz / 111_320) * 1e6) / 1e6,
  ];
  let dist = accessM;
  let walk = accessM / BASE_MPS;
  let steps = false;
  let throughPrivateM = 0;
  for (let k = 0; k < edges.length; k++) {
    const e = edges[k]!;
    dist += g.elen[e]!;
    walk += edgeSec(g, e, nodes[k]!, nodes[k + 1]!, "walk", true);
    if (g.eflag[e]! & F_STEPS) steps = true;
    if (g.eflag[e]! & F_PRIVATE) throughPrivateM += g.elen[e]!;
  }
  // 횡단 — 횡단 태그 노드, 또는 경로가 타지 않는 차도와 만나는 점. 30m 안의 연속 횡단은 하나로.
  type Ev = { at: number; i: number; info: CrossInfo };
  const events: Ev[] = [];
  let along = 0;
  for (let k = 1; k < nodes.length - 1; k++) {
    along += g.elen[edges[k - 1]!]!;
    const i = nodes[k]!;
    const ein = edges[k - 1]!;
    const eout = edges[k]!;
    if ((g.eflag[ein]! | g.eflag[eout]!) & (F_TUNNEL | F_BRIDGE)) continue;
    const routeWays = new Set([g.eway[ein]!, g.eway[eout]!]);
    // 가로지르는 차도 = 이 점에서 만나는, 경로가 타지 않는 차도 가지. 한쪽으로만 붙은 곁길(T자)은 보도 반대편일 수 있어 세지 않는다.
    let branches = 0;
    let rank = 0;
    for (let k2 = g.adjStart[i]!; k2 < g.adjStart[i + 1]!; k2++) {
      const w = g.eway[g.adjEdge[k2]!]!;
      if (routeWays.has(w) || g.ways[w]!.rank < 1) continue;
      branches++;
      rank = Math.max(rank, g.ways[w]!.rank);
    }
    const tagged = g.crossingNode[i] === 1;
    // 태그 없는 교차로는 2차로급(tertiary) 이상 길만 — 골목 교차까지 세면 "횡단보도" 수가 부풀려진다
    if (!tagged && (branches < 2 || rank < 2)) continue;
    // 단지 안 도로는 횡단으로 세지 않는다
    if (!tagged && g.hull.length >= 3 && inPoly(g.x[i]!, g.z[i]!, g.hull)) continue;
    if (tagged && !rank) rank = Math.max(0, ...(g.nodeRoadWays.get(i) ?? []).filter((w) => !routeWays.has(w)).map((w) => g.ways[w]!.rank));
    const base = ctx.crossAt(i);
    const info: CrossInfo = base
      ? { ...base, major: rank >= 3, waitSec: base.signal ? expectedWait(true, rank, base.cw) : expectedWait(false, rank, null) }
      : { waitSec: expectedWait(false, rank, null), signal: false, major: rank >= 3, cw: null };
    events.push({ at: along, i, info });
  }
  const merged: Ev[] = [];
  for (const ev of events) {
    const last = merged[merged.length - 1];
    if (last && ev.at - last.at < 30) {
      if (ev.info.waitSec > last.info.waitSec) merged[merged.length - 1] = { ...ev, at: last.at };
      else last.info = { ...last.info, major: last.info.major || ev.info.major, signal: last.info.signal || ev.info.signal };
    } else merged.push({ ...ev });
  }
  const wait = merged.reduce((s, e) => s + e.info.waitSec, 0);

  // 표고 — 10m 간격으로 다시 재서 1m 넘게 변할 때만 오르내림으로 센다
  const res = Math.max(30, g.sampler?.info.resolutionM ?? 30);
  const prof: Array<{ s: number; h: number }> = [];
  let s = 0;
  for (let k = 0; k < edges.length; k++) {
    const a = nodes[k]!;
    const b = nodes[k + 1]!;
    const len = g.elen[edges[k]!]!;
    const parts = Math.max(1, Math.round(len / 10));
    for (let p = k === 0 ? 0 : 1; p <= parts; p++) prof.push({ s: s + (len * p) / parts, h: g.h[a]! + ((g.h[b]! - g.h[a]!) * p) / parts });
    s += len;
  }
  let gain = 0;
  let loss = 0;
  let ref = prof[0]?.h ?? 0;
  for (const p of prof) {
    if (p.h - ref >= 1) {
      gain += p.h - ref;
      ref = p.h;
    } else if (ref - p.h >= 1) {
      loss += ref - p.h;
      ref = p.h;
    }
  }
  let maxGrade = 0;
  for (let i = 0, j = 0; i < prof.length; i++) {
    while (j < prof.length && prof[j]!.s - prof[i]!.s < res) j++;
    if (j >= prof.length) break;
    maxGrade = Math.max(maxGrade, Math.abs(prof[j]!.h - prof[i]!.h) / (prof[j]!.s - prof[i]!.s));
  }

  // 표시용 선 — 1.5m 허용 오차로 줄임
  const pts = nodes.map((i) => ({ x: g.x[i]!, z: g.z[i]! }));
  const keep = simplify(pts, 1.5);
  const marks: WalkMark[] = merged.map((e) => ({
    ...(() => {
      const [lng, lat] = toLngLat(g.x[e.i]!, g.z[e.i]!);
      return { lng, lat };
    })(),
    kind: "crossing" as const,
    major: e.info.major,
    signal: e.info.signal,
  }));
  let underpasses = 0;
  let overpasses = 0;
  let gate: string | null = null;
  for (let k = 0; k < edges.length; k++) {
    const f = g.eflag[edges[k]!]!;
    const pf = k ? g.eflag[edges[k - 1]!]! : 0;
    const mid = (): { lng: number; lat: number } => {
      const [lng, lat] = toLngLat(g.x[nodes[k]!]!, g.z[nodes[k]!]!);
      return { lng, lat };
    };
    if (f & F_TUNNEL && !(pf & F_TUNNEL)) {
      underpasses++;
      marks.push({ ...mid(), kind: "underpass" });
    }
    if (f & F_BRIDGE && !(pf & F_BRIDGE)) {
      overpasses++;
      marks.push({ ...mid(), kind: "overpass" });
    }
    if (f & F_STEPS && !(pf & F_STEPS)) marks.push({ ...mid(), kind: "steps" });
    const t = g.nodeTags.get(nodes[k]!);
    if (!gate && t && (t.barrier === "gate" || t.entrance === "main" || t.entrance === "yes" || t.barrier === "entrance") && nearHull(g.x[nodes[k]!]!, g.z[nodes[k]!]!, g.hull, 30)) {
      gate = t.name ?? t.ref ?? "단지 출입구";
      marks.push({ ...mid(), kind: "gate" });
    }
  }
  return {
    distanceM: Math.round(dist),
    walkSec: Math.round(walk),
    waitSec: Math.round(wait),
    gainM: Math.round(gain),
    lossM: Math.round(loss),
    maxGradePct: Math.round(maxGrade * 1000) / 10,
    crossings: merged.length,
    signalCrossings: merged.filter((e) => e.info.signal).length,
    majorCrossing: merged.some((e) => e.info.major),
    steps,
    throughPrivateM: Math.round(throughPrivateM),
    underpasses,
    overpasses,
    gate,
    points: keep.map((i) => toLngLat(pts[i]!.x, pts[i]!.z)),
    marks,
  };
}

// ── 캐시 ─────────────────────────────────────────────────────────────────────
// 개발 서버 코드 교체(HMR)에도 Overpass를 다시 부르지 않게 전역에 둔다
const graphCache: Map<string, { at: number; p: Promise<Graph> }> = ((globalThis as Record<string, unknown>).__ziplabWalkGraphs ??= new Map()) as Map<
  string,
  { at: number; p: Promise<Graph> }
>;
const GRAPH_TTL = 12 * 3600_000;
const GRAPH_CAP = 6;

/** 그래프 만드는 규칙이 바뀌면 올린다 (메모리 캐시 무효화) */
const GRAPH_VERSION = 4;

function getGraph(input: WalkInput, loadOsm: OsmLoader): Promise<Graph> {
  const key = `${GRAPH_VERSION}|${input.complexId}`;
  const hit = graphCache.get(key);
  if (hit && Date.now() - hit.at < GRAPH_TTL) {
    graphCache.delete(key);
    graphCache.set(key, hit);
    return hit.p;
  }
  const p = buildGraph(input, loadOsm);
  graphCache.set(key, { at: Date.now(), p });
  p.catch(() => graphCache.delete(key));
  while (graphCache.size > GRAPH_CAP) graphCache.delete(graphCache.keys().next().value!);
  return p;
}

// ── 본체 ─────────────────────────────────────────────────────────────────────
function ringCentroid(r: Ring, toX: (lng: number) => number, toZ: (lat: number) => number) {
  let x = 0;
  let z = 0;
  const pts = r.slice(0, -1).length ? r.slice(0, -1) : r;
  for (const [lng, lat] of pts) {
    x += toX(lng);
    z += toZ(lat);
  }
  return { x: x / pts.length, z: z / pts.length };
}

const SCHOOL_LABEL: Record<string, string> = { elementary: "초등학교", middle: "중학교", high: "고등학교" };

export async function computeWalkRoutes(
  input: WalkInput,
  opts: { from?: string | null; mode?: Mode; loadOsm?: OsmLoader } = {},
): Promise<WalkPayload> {
  const mode: Mode = opts.mode === "wheel" ? "wheel" : "walk";
  const [g, cw] = await Promise.all([
    getGraph(input, opts.loadOsm ?? (async (b) => (await fetchOverpass(b)).elements)),
    input.sigungu ? loadCrosswalks(input.sigungu) : Promise.resolve({ status: "unavailable" as const, note: "시군구 없음", items: [] }),
  ]);
  const { center, mPerLng } = g;
  const toX = (lng: number) => (lng - center.lng) * mPerLng;
  const toZ = (lat: number) => -(lat - center.lat) * 111_320;

  // 횡단 정보 — 노드별 (횡단 태그 노드 + 차도끼리 만나는 점)
  const cwNear = cw.items
    .map((c) => ({ ...c, x: toX(c.lng), z: toZ(c.lat) }))
    .filter((c) => Math.abs(c.x) < WALK_HALF_M + 50 && Math.abs(c.z) < WALK_HALF_M + 50);
  const signalIdx: number[] = [];
  for (let i = 0; i < g.x.length; i++) if (g.signalNode[i]) signalIdx.push(i);
  const crossCache = new Map<number, CrossInfo | null>();
  const crossAt = (i: number): CrossInfo | null => {
    if (crossCache.has(i)) return crossCache.get(i)!;
    const rank = Math.max(0, ...(g.nodeRoadWays.get(i) ?? []).map((w) => g.ways[w]!.rank));
    const tagged = g.crossingNode[i] === 1;
    let info: CrossInfo | null = null;
    if (tagged || rank >= 1) {
      const px = g.x[i]!;
      const pz = g.z[i]!;
      let signal = g.signalNode[i] === 1;
      if (!signal) for (const s of signalIdx) if (Math.hypot(g.x[s]! - px, g.z[s]! - pz) < 18) signal = true;
      let best: (typeof cwNear)[number] | null = null;
      let bd = 20;
      for (const c of cwNear) {
        const d = Math.hypot(c.x - px, c.z - pz);
        if (d < bd) {
          bd = d;
          best = c;
        }
      }
      if (best?.signal) signal = true;
      info = { waitSec: expectedWait(signal, rank, best), signal, major: rank >= 3, cw: best };
    }
    crossCache.set(i, info);
    return info;
  };
  // 경로 탐색에 쓰는 노드 대기 — 횡단 태그가 있는 점만 (교차로 통과는 방향을 알아야 해서 뒤에 센다)
  const nodeWait = new Float32Array(g.x.length);
  for (let i = 0; i < g.x.length; i++) if (g.crossingNode[i]) nodeWait[i] = crossAt(i)?.waitSec ?? 2;
  const ctx: Ctx = { g, mode, nodeWait, crossAt };

  // 동별 출발점
  const entrances = g.pois.filter(
    (p): p is Extract<OsmEl, { type: "node" }> => p.type === "node" && !!p.tags?.entrance && p.tags.railway !== "subway_entrance",
  );
  const inside = (i: number) => nearHull(g.x[i]!, g.z[i]!, g.hull, 25);
  type Start = {
    buildingId: string;
    dong: string;
    sources: Array<{ i: number; d: number }>;
    door: "entrance" | "building";
    cx: number;
    cz: number;
  };
  const starts: Start[] = [];
  const sourcesAt = (px: number, pz: number) => {
    const inner = nodesAround(g, px, pz, 120, 50, inside);
    return inner.length ? inner : nodesAround(g, px, pz, 300, 50);
  };
  for (const b of input.buildings) {
    if (!b.residential || !b.dong || !b.rings?.[0]) continue;
    const ring = b.rings[0];
    const c = ringCentroid(ring, toX, toZ);
    let door: { x: number; z: number } | null = null;
    for (const e of entrances) {
      const ex = toX(e.lon);
      const ez = toZ(e.lat);
      let d = Infinity;
      for (let k = 1; k < ring.length; k++)
        d = Math.min(d, segDist(ex, ez, toX(ring[k - 1]![0]), toZ(ring[k - 1]![1]), toX(ring[k]![0]), toZ(ring[k]![1])));
      if (d < 4 && (!door || Math.hypot(ex - c.x, ez - c.z) < Math.hypot(door.x - c.x, door.z - c.z))) door = { x: ex, z: ez };
    }
    const p = door ?? c;
    const sources = sourcesAt(p.x, p.z);
    if (!sources.length) continue;
    starts.push({ buildingId: b.id, dong: b.dong, sources, door: door ? "entrance" : "building", cx: c.x, cz: c.z });
  }
  if (!starts.length) {
    // 동 모양이 없으면 단지 좌표에서 출발
    const sources = sourcesAt(0, 0);
    if (!sources.length) throw new Error("no start");
    starts.push({ buildingId: "center", dong: "단지 중심", sources, door: "building", cx: 0, cz: 0 });
  }
  const mx = starts.reduce((s, q) => s + q.cx, 0) / starts.length;
  const mz = starts.reduce((s, q) => s + q.cz, 0) / starts.length;
  const rep = [...starts].sort((a, b) => Math.hypot(a.cx - mx, a.cz - mz) - Math.hypot(b.cx - mx, b.cz - mz))[0]!;
  const from = starts.find((s) => s.buildingId === opts.from) ?? rep;
  const offSec = (d: number) => (d * OFFNET) / BASE_MPS;
  const fwd = dijkstra(g, from.sources.map((q) => [q.i, offSec(q.d)] as [number, number]), false, mode, nodeWait);
  const fromD = new Map(from.sources.map((q) => [q.i, q.d]));

  // 도착 후보
  type Cand = {
    id: string;
    kind: WalkDestination["kind"];
    name: string;
    sub: string | null;
    ends: Array<{ i: number; d: number }>;
    target: { lng: number; lat: number };
    group: string;
    node: number;
    snapM: number;
  };
  const cands: Cand[] = [];
  // 출구·정류장은 바로 옆 길로, 학교·역 좌표(건물 가운데)는 둘레 40m 안 길 어디로든 닿으면 된다
  const snapTo = (lng: number, lat: number, maxM: number) => {
    const ends = nodesAround(g, toX(lng), toZ(lat), maxM, maxM > 60 ? 40 : 8);
    return ends.length ? { ends, i: ends[0]!.i, d: ends[0]!.d } : null;
  };
  const stations = input.stations.filter((s) => Math.hypot(toX(s.lng), toZ(s.lat)) <= STATION_MAX_M);
  const osmEntr = g.pois.filter((p): p is Extract<OsmEl, { type: "node" }> => p.type === "node" && p.tags?.railway === "subway_entrance");
  const base = (n: string) => n.replace(/\(.*?\)/g, "").replace(/역$/u, "").trim();
  for (const st of stations) {
    const sx = toX(st.lng);
    const sz = toZ(st.lat);
    const mine = osmEntr.filter((e) => {
      const d = Math.hypot(toX(e.lon) - sx, toZ(e.lat) - sz);
      if (d > 450) return false;
      // 더 가까운 다른 역이 있으면 그 역 출구
      return !stations.some((o) => o !== st && Math.hypot(toX(e.lon) - toX(o.lng), toZ(e.lat) - toZ(o.lat)) < d);
    });
    const label = `${base(st.name)}역`;
    if (mine.length) {
      for (const e of mine) {
        const snap = snapTo(e.lon, e.lat, 60);
        if (!snap) continue;
        const ref = e.tags?.ref ?? /(\d+)\s*번/.exec(e.tags?.name ?? "")?.[1] ?? null;
        cands.push({
          id: `exit-${e.id}`,
          kind: "subway",
          name: ref ? `${label} ${ref}번 출구` : `${label} 출입구`,
          sub: st.lines.join("·") || null,
          ends: snap.ends,
          node: snap.i,
          target: { lng: e.lon, lat: e.lat },
          group: `st-${label}`,
          snapM: snap.d,
        });
      }
    } else {
      const snap = snapTo(st.lng, st.lat, 150);
      if (snap)
        cands.push({ id: `st-${label}`, kind: "subway", name: label, sub: st.lines.join("·") || null, ends: snap.ends, node: snap.i, target: { lng: st.lng, lat: st.lat }, group: `st-${label}`, snapM: snap.d });
    }
  }
  for (const level of ["elementary", "middle"]) {
    const s = input.schools
      .filter((x) => x.level === level)
      .sort((a, b) => Math.hypot(toX(a.lng), toZ(a.lat)) - Math.hypot(toX(b.lng), toZ(b.lat)))[0];
    if (!s) continue;
    const snap = snapTo(s.lng, s.lat, 150);
    if (snap)
      cands.push({ id: `school-${s.name}`, kind: "school", name: s.name, sub: SCHOOL_LABEL[level] ?? null, ends: snap.ends, node: snap.i, target: { lng: s.lng, lat: s.lat }, group: `school-${level}`, snapM: snap.d });
  }
  for (const p of g.pois) {
    if (p.type !== "node" || p.tags?.highway !== "bus_stop") continue;
    // 한강버스 선착장 등 배 정류장은 빼기
    if (p.tags.ferry || p.tags.amenity === "ferry_terminal" || /선착장|나루/.test(p.tags.name ?? "")) continue;
    if (Math.hypot(toX(p.lon), toZ(p.lat)) > 700) continue;
    const snap = snapTo(p.lon, p.lat, 40);
    if (snap)
      cands.push({ id: `bus-${p.id}`, kind: "bus", name: p.tags.name ?? "버스정류장", sub: "버스", ends: snap.ends, node: snap.i, target: { lng: p.lon, lat: p.lat }, group: "bus", snapM: snap.d });
  }
  // 묶음마다 가장 빨리 닿는 곳 하나
  const bestByGroup = new Map<string, Cand>();
  for (const c of cands) {
    // 가장 빨리 닿는 도착 점
    let best = Infinity;
    for (const e of c.ends) {
      const t = fwd.dist[e.i]! + offSec(e.d);
      if (t < best) {
        best = t;
        c.node = e.i;
        c.snapM = e.d;
      }
    }
    if (!Number.isFinite(best)) continue;
    const cur = bestByGroup.get(c.group);
    if (!cur || fwd.dist[c.node]! + c.snapM / BASE_MPS < fwd.dist[cur.node]! + cur.snapM / BASE_MPS) bestByGroup.set(c.group, c);
  }
  const chosen = [...bestByGroup.values()];
  const subways = chosen.filter((c) => c.kind === "subway").sort((a, b) => fwd.dist[a.node]! - fwd.dist[b.node]!).slice(0, 3);
  const others = chosen.filter((c) => c.kind !== "subway");

  const destinations: WalkDestination[] = [];
  let fromAccess: number | null = null;
  for (const c of [...subways, ...others]) {
    const nodes: number[] = [c.node];
    const edges: number[] = [];
    let cur = c.node;
    let guard = 0;
    while (guard++ < 200_000) {
      const e = fwd.pred[cur]!;
      if (e < 0) break;
      edges.push(e);
      cur = g.eu[e] === cur ? g.ev[e]! : g.eu[e]!;
      nodes.push(cur);
    }
    const startD = fromD.get(cur);
    if (startD == null) continue;
    fromAccess ??= startD;
    nodes.reverse();
    edges.reverse();
    const d = describePath(ctx, nodes, edges, (startD + c.snapM) * OFFNET);
    // 동별 — 도착 점들에서 거꾸로 한 번
    const rev = dijkstra(g, c.ends.map((e) => [e.i, offSec(e.d)] as [number, number]), true, mode, nodeWait);
    const perDong = starts
      .map((s) => ({ buildingId: s.buildingId, sec: Math.min(...s.sources.map((q) => rev.dist[q.i]! + offSec(q.d))) }))
      .filter((x) => Number.isFinite(x.sec))
      .map((x) => ({ buildingId: x.buildingId, min: Math.max(1, Math.round(x.sec / 60)) }));
    const mins = perDong.map((x) => x.min);
    const total = d.walkSec + d.waitSec;
    destinations.push({
      id: c.id,
      kind: c.kind,
      name: c.name,
      sub: c.sub,
      target: c.target,
      straightM: Math.round(Math.hypot(toX(c.target.lng) - from.cx, toZ(c.target.lat) - from.cz)),
      ...d,
      totalMin: Math.max(1, Math.round(total / 60)),
      walkMin: Math.max(1, Math.round(d.walkSec / 60)),
      perDong,
      range: mins.length ? [Math.min(...mins), Math.max(...mins)] : null,
    });
  }

  return {
    complexId: input.complexId,
    mode,
    from: { buildingId: from.buildingId, dong: from.dong, door: from.door, accessM: Math.round(fromAccess ?? from.sources[0]!.d) },
    dongs: starts
      .map((s) => ({ buildingId: s.buildingId, dong: s.dong }))
      .sort((a, b) => a.dong.localeCompare(b.dong, "ko", { numeric: true })),
    destinations,
    terrain: g.sampler?.info ?? null,
    crosswalkData: { status: cw.status, note: cw.note },
    network: {
      ways: g.wayCount,
      nodes: g.x.length,
      crossingNodes: g.crossingNode.reduce((a, b) => a + b, 0),
      signalNodes: signalIdx.length,
      fetchedAt: g.fetchedAt,
    },
    assumptions: [
      "평지 시속 4.5km, 경사는 Tobler 보행 함수, 계단은 0.55배 속도",
      "신호 대기 = 적색² ÷ (2 × 주기) 기대값. 신호 시간 원천이 없으면 큰길 120초·중간 90초·작은 길 60초 주기로 가정",
      "엘리베이터·역 안 승강장까지 시간은 포함하지 않음",
    ],
    attribution: "© OpenStreetMap contributors",
  };
}

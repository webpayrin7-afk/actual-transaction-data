"use client";

/**
 * 서울 3D 지도 (1단계) — 지도로 찾기에서 '3D'를 눌렀을 때만 불러온다 (MapLibre + PMTiles 건물 타일).
 * 2D(네이버) 지도와 따로 동작하며, 단지 값은 2D와 같은 /api/map/complexes(화면 범위, 서버 계산)만 쓴다.
 * 맨 위 줄(2D | 3D 전환 · 거래유형 · 조건 칩)은 MapSearchPage가 이 화면 위에 그대로 그린다.
 *
 * 단지를 고르면: 대지 경계(/api/complex-3d/[id]/boundary — 지적도 필지, 없으면 동 외곽 추정) + 단지 동 강조
 * (/api/complex-3d/[id]?shapes=1) + 나머지 건물은 옅게 + 카메라가 단지를 비스듬히 담는다. 고르기를 풀면 모두 지운다.
 * 소스·레이어는 지도가 뜰 때 한 번 만들고 데이터만 바꾼다 (지울 때는 빈 데이터 — 지도를 닫으면 map.remove()가 모두 정리).
 */
import "maplibre-gl/dist/maplibre-gl.css";
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import Link from "next/link";
import maplibregl, {
  type ExpressionSpecification,
  type GeoJSONSource,
  type Map as MlMap,
  type StyleSpecification,
} from "maplibre-gl";
import { Protocol } from "pmtiles";
import { ChevronDown, Compass, Satellite, X } from "lucide-react";
import { LabIndeterminateBar } from "@/components/ui/LabLoading";
import { ComplexCardMore } from "@/components/map/ComplexCardMore";
import { fitComplexCamera } from "@/components/map3d/fit-camera";
import {
  MAP3D_ATTRIBUTION,
  Map3dAttribution,
  SATELLITE_ATTRIBUTION,
  SCHOOL_ZONE_ATTRIBUTION,
} from "@/components/map3d/Map3dAttribution";
import { MARKER_METRICS, markerValue, shortEok, shortPerPyeong, type MarkerMetric } from "@/components/map/complex-marker";
import type { MapComplex, MapDealKind } from "@/lib/map/map-complexes";
import { activeCount, areaQuery, matches, type MapConditions } from "@/lib/map/map-filters";
import type { Complex3d, Ring } from "@/lib/complex-3d/read";
import type { SiteBoundary } from "@/lib/complex-3d/boundary";
import { formatDealDate, formatEok } from "@/lib/utils/format";
import { shouldJump, write3dSession, type Map3dCamera } from "@/lib/map/view-state";
import {
  BASEMAP_STYLE_URL,
  BUILDING_COLOR,
  BUILDING_COLOR_DIM,
  BUILDING_HEIGHT,
  BUILDINGS_ATTRIBUTION,
  CHANGE_STEPS,
  LOCALE_KO,
  NO_VALUE_COLOR,
  PER_PYEONG_STEPS,
  SELECTED_BUILDING_COLOR,
  SELECTED_SITE_FILL,
  SELECTED_SITE_LINE,
  SEOUL_BOUNDS,
  buildingsTilesUrl,
  calmBasemap,
  pillImage,
  stepColor,
  type Map3dMetric,
} from "@/components/map3d/seoul-3d-style";

/** 3D 시작 위치 — 기울기·방향이 있으면(뒤로 와서 되살릴 때) 그대로 연다 */
export type Map3dView = Map3dCamera;

const DEAL_LABEL: Record<MapDealKind, string> = { trade: "매매", jeonse: "전세" };
/** 단지를 불러오는 줌 — MapLibre 줌(512px 타일)이라 2D(네이버) 14와 같은 축척 */
const COMPLEX_ZOOM = 13;
/** 이 줌보다 멀면 단지를 부르지도, 그리지도 않는다 */
const COMPLEX_MIN_ZOOM = COMPLEX_ZOOM - 0.25;
/** 이름표 — 이 줌부터 이름, VALUE_ZOOM부터 이름 · 값 */
const LABEL_ZOOM = 13.5;
const VALUE_ZOOM = 15;
/**
 * 부르는 범위 = 지금 보이는 화면(map.getBounds). 기울이면 지평선 쪽이 아주 넓어지므로
 * 화면 가운데 기준으로 이만큼까지만 자른다 (API 한도 0.12° × 0.168° 안, 넓은 화면 1440px 폭도 들어감).
 */
const MAX_LAT_SPAN = 0.08;
const MAX_LNG_SPAN = 0.12;
/** 범위 끝을 바깥쪽으로 맞추는 칸(도) — 조금 움직여도 같은 주소 → 캐시가 맞게 */
const ROUND = 0.002;
const START_PITCH = 55;
/** 단지로 날아갈 때 기울기·최대 줌 */
/** 위성영상 켬·끔 기억 (브라우저) */
const SATELLITE_PREF = "ziplab:map3d-satellite:v1";
const FOCUS_PITCH = 58;
/** 점을 지붕보다 조금 더 위에 (m) */
const ROOF_GAP_M = 8;
const FOCUS_MAX_ZOOM = 18.5;
/** 고른 단지 도형 기억 (다시 골랐을 때 바로) — 많이 쌓지 않는다 */
const SHAPE_CACHE_MAX = 16;

let protocolAdded = false;

/** MapLibre 컨트롤 — 모바일 아래 탭 막대 위로, 손가락 크기(44px) */
const CONTROL_CSS = `
.seoul3d .maplibregl-ctrl-bottom-right{bottom:calc(env(safe-area-inset-bottom) + 76px + var(--map-sheet-peek, 0px))}
@media (min-width:640px){.seoul3d .maplibregl-ctrl-bottom-right{bottom:0}}
.seoul3d .maplibregl-ctrl-group button{width:40px;height:40px}
`;

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
/** 고른 단지의 초등학교 통학구역 — 대지·건물(청록)과 겹치지 않는 호박색, 옅게 */
const SCHOOL_ZONE_COLOR = "#d97706";
type SchoolZoneGeo = { geometry: GeoJSON.FeatureCollection };

function reducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function inSeoul(lat: number, lng: number): boolean {
  const b = SEOUL_BOUNDS;
  return lat >= b.south && lat <= b.north && lng >= b.west && lng <= b.east;
}

type Box = { s: number; w: number; n: number; e: number };

/** 보이는 범위(가운데 기준으로 한도까지 자름, 바깥쪽으로 반올림) */
function viewBox(map: MlMap): Box {
  const b = map.getBounds();
  const c = map.getCenter();
  let s = b.getSouth();
  let n = b.getNorth();
  let w = b.getWest();
  let e = b.getEast();
  if (n - s > MAX_LAT_SPAN) {
    s = Math.max(s, c.lat - MAX_LAT_SPAN / 2);
    n = Math.min(n, c.lat + MAX_LAT_SPAN / 2);
  }
  if (e - w > MAX_LNG_SPAN) {
    w = Math.max(w, c.lng - MAX_LNG_SPAN / 2);
    e = Math.min(e, c.lng + MAX_LNG_SPAN / 2);
  }
  const down = (v: number) => Math.floor(v / ROUND) * ROUND;
  const up = (v: number) => Math.ceil(v / ROUND) * ROUND;
  return { s: down(s), w: down(w), n: up(n), e: up(e) };
}

function contains(outer: Box, inner: Box): boolean {
  const eps = 1e-9;
  return inner.s >= outer.s - eps && inner.w >= outer.w - eps && inner.n <= outer.n + eps && inner.e <= outer.e + eps;
}

function metricValue(c: MapComplex, metric: Map3dMetric): number | null {
  return metric === "perPyeong" ? c.perPyeongMan : c.change1yPct;
}

function metricText(v: number | null, metric: Map3dMetric): string {
  if (v == null) return "";
  if (metric === "perPyeong") return shortPerPyeong(v);
  if (v === 0) return "0%";
  return `${v > 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}%`;
}

/** 긴 단지 이름은 이름표에서 줄인다 (카드에는 전체 이름) */
function shortName(name: string): string {
  const s = name.trim();
  return s.length > 11 ? `${s.slice(0, 10)}…` : s;
}

/**
 * 이름표 둘째 줄 — 2D 마커와 같은 값(마커 표시: 가격·평당가·전세가율·1년 변동).
 * 가격은 대표 평형 최근 실거래가(매매/전세 — 고른 거래유형) 앞에 평형을 붙인다 ("34평 · 29억").
 */
function labelValue(c: MapComplex, metric: MarkerMetric): { text: string; color: string } {
  if (metric === "price") {
    if (c.priceMan == null) return { text: "", color: "#94a3b8" };
    return { text: c.pyeongLabel ? `${c.pyeongLabel} · ${shortEok(c.priceMan)}` : shortEok(c.priceMan), color: "#115e59" };
  }
  const v = markerValue(c, metric);
  if (v.text === "–") return { text: "", color: "#94a3b8" };
  return { text: v.text, color: v.color ?? "#115e59" };
}

/** 고른 단지 점을 옮길 자리 — 단지 좌표는 필지 모서리·길가일 때가 있어, 동들의 가운데(면적 가중)로 */
type PointAt = { id: string; lng: number; lat: number };

function massCenter(shape: Complex3d | null, site: SiteBoundary | null): [number, number] | null {
  let sx = 0;
  let sy = 0;
  let sw = 0;
  for (const b of shape?.buildings ?? []) {
    const ring = b.rings?.[0];
    if (!ring || ring.length < 4) continue;
    // 넓이·무게중심 (경위도 그대로 — 단지 크기에서는 충분)
    let a = 0;
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      const [x0, y0] = ring[i]!;
      const [x1, y1] = ring[i + 1]!;
      const k = x0 * y1 - x1 * y0;
      a += k;
      cx += (x0 + x1) * k;
      cy += (y0 + y1) * k;
    }
    if (Math.abs(a) < 1e-14) continue;
    // 외곽선 방향(시계·반시계)이 섞여도 되게 — 넓이는 절댓값으로 가중
    const sg = Math.sign(a);
    sx += (cx / 3) * sg;
    sy += (cy / 3) * sg;
    sw += Math.abs(a);
  }
  if (sw !== 0) return [sx / sw, sy / sw];
  if (site?.bbox) return [(site.bbox[0] + site.bbox[2]) / 2, (site.bbox[1] + site.bbox[3]) / 2];
  return null;
}

/** 카메라 기울기·방향 — 점을 지붕 위로 띄우는 데 쓴다 */
type Lift = { pitch: number; bearing: number };

/**
 * 동 가운데 지붕 위(높이 top m + 여유)에 떠 있는 점을, 같은 화면 자리에 보이는 땅 위 점으로 옮긴다.
 * 비스듬히 보면 높이 h 인 점은 카메라 반대쪽(화면 위쪽 = 지도 방향)으로 h·tan(기울기)만큼 떨어진 땅과 겹쳐 보인다.
 * (점·이름표는 MapLibre에서 땅에만 놓을 수 있어서 — 가까운·먼 곳의 원근 차이는 무시)
 */
function liftedPoint(a: [number, number, number], lift: Lift): [number, number] {
  const d = (a[2] + ROOF_GAP_M) * Math.tan((Math.min(lift.pitch, 72) * Math.PI) / 180);
  const b = (lift.bearing * Math.PI) / 180;
  const kx = 111_320 * Math.cos((a[1] * Math.PI) / 180);
  return [a[0] + (d * Math.sin(b)) / kx, a[1] + (d * Math.cos(b)) / 111_320];
}

function toGeoJson(
  list: MapComplex[],
  metric: Map3dMetric,
  labelMetric: MarkerMetric,
  moved: PointAt | null = null,
  lift: Lift = { pitch: 0, bearing: 0 },
): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: list.map((c) => {
      const v = metricValue(c, metric);
      const lv = labelValue(c, labelMetric);
      const props: Record<string, string | number> = {
        id: c.complexId,
        name: shortName(c.aptName),
        label: lv.text,
        vc: lv.color,
        hh: c.householdCount ?? 0,
      };
      if (v != null) props.v = v;
      const at = c.anchor3d
        ? liftedPoint(c.anchor3d, lift)
        : moved?.id === c.complexId
          ? [moved.lng, moved.lat]
          : [c.lng, c.lat];
      return { type: "Feature", geometry: { type: "Point", coordinates: at }, properties: props };
    }),
  };
}

/**
 * 이름(가운데 줌) → 가까이(VALUE_ZOOM부터)는 두 줄: 1줄 이름(굵게 12px) · 2줄 값(11px, 지표 색).
 * 값이 없으면 이름 한 줄.
 */
const LABEL_TEXT = [
  "step",
  ["zoom"],
  ["get", "name"],
  VALUE_ZOOM,
  [
    "case",
    ["==", ["get", "label"], ""],
    ["get", "name"],
    [
      "format",
      ["get", "name"],
      {},
      "\n",
      {},
      ["get", "label"],
      { "text-color": ["to-color", ["get", "vc"]], "font-scale": 0.92 },
    ],
  ],
] as unknown as ExpressionSpecification;

/** 고른 단지 이름표는 줌과 상관없이 두 줄 (청록 바탕 위 흰 글자) */
const SELECTED_LABEL_TEXT = [
  "case",
  ["==", ["get", "label"], ""],
  ["get", "name"],
  ["format", ["get", "name"], {}, "\n", {}, ["get", "label"], { "font-scale": 0.92 }],
] as unknown as ExpressionSpecification;

/**
 * 고른 단지 동 외곽선을 바깥으로 조금(≈0.6m) 넓힌다 — 건물 타일의 같은 건물과 벽이 겹쳐 깜빡이지 않게.
 * 꼭짓점을 외곽선 가운데에서 멀어지는 쪽으로 민다 (단지 동은 대개 볼록에 가깝다).
 */
function grow(ring: Ring, meters: number): Ring {
  if (ring.length < 4) return ring;
  const pts = ring.slice(0, -1);
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const kx = 111_320 * Math.cos((cy * Math.PI) / 180);
  const ky = 111_320;
  const out = pts.map(([x, y]): [number, number] => {
    const dx = (x - cx) * kx;
    const dy = (y - cy) * ky;
    const d = Math.hypot(dx, dy) || 1;
    const f = (d + meters) / d;
    return [cx + (dx * f) / kx, cy + (dy * f) / ky];
  });
  return [...out, out[0]!];
}

/** 동 높이 — 원천 높이, 없으면 층수 × 3m, 둘 다 없으면 20m (강조 모형용) */
function buildingHeight(b: Complex3d["buildings"][number]): number {
  if (b.heightM && b.heightM > 0) return b.heightM;
  if (b.floors && b.floors > 0) return b.floors * 3;
  return 20;
}

function buildingsGeoJson(shape: Complex3d): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (const b of shape.buildings) {
    if (!b.rings?.length) continue;
    const outer = b.rings[0]!;
    features.push({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [grow(outer, 0.6)] },
      properties: { h: buildingHeight(b) + 0.8 },
    });
  }
  return { type: "FeatureCollection", features };
}

function inRing(pt: [number, number], ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inGeometry(pt: [number, number], g: GeoJSON.Geometry | null | undefined): boolean {
  if (!g) return false;
  if (g.type === "Polygon") return inRing(pt, g.coordinates[0] as Ring);
  if (g.type === "MultiPolygon") return g.coordinates.some((poly) => inRing(pt, poly[0] as Ring));
  return false;
}

/**
 * 건물 타일에서 고른 단지에 속하는 건물 — 우리 동 외곽선과 타일 외곽선이 조금 달라
 * 삐져나온 타일 조각이 회색 틈으로 보이지 않게, 같은 청록으로 덮는다.
 * 동 외곽선(5m 넓힘) 안이거나, 단지 경계 안의 공동주택(a=1) 건물이면 단지 건물로 본다.
 */
function tileBuildingsOf(
  map: maplibregl.Map,
  shape: Complex3d | null,
  site: SiteBoundary | null,
): GeoJSON.Feature[] {
  const near = (shape?.buildings ?? []).filter((b) => b.rings?.length).map((b) => grow(b.rings![0]!, 8));
  if (!near.length && !site) return [];
  const out: GeoJSON.Feature[] = [];
  const seen = new Set<string>();
  for (const f of map.querySourceFeatures("buildings", { sourceLayer: "buildings" })) {
    const g = f.geometry;
    const ring = g.type === "Polygon" ? (g.coordinates[0] as Ring) : null;
    if (!ring || ring.length < 4) continue;
    const pts = ring.slice(0, -1);
    const c: [number, number] = [
      pts.reduce((a, q) => a + q[0], 0) / pts.length,
      pts.reduce((a, q) => a + q[1], 0) / pts.length,
    ];
    const h = Number(f.properties?.h) || 0;
    // 단지 경계 안 건물은 모두(상가·관리동 포함), 경계 밖이면 동 외곽선(8m 넓힘)과 겹치는 조각만
    // (타일 건물은 타일 경계에서 잘려 조각으로 오기도 해서 가운데 말고 꼭짓점 절반 기준도 본다)
    const inside = (q: [number, number]) => near.some((r) => inRing(q, r));
    const mine =
      inGeometry(c, site?.fill) || inside(c) || pts.filter((q) => inside(q as [number, number])).length * 2 >= pts.length;
    if (!mine || h <= 0) continue;
    const key = `${c[0].toFixed(6)},${c[1].toFixed(6)},${h}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type: "Feature", geometry: { type: "Polygon", coordinates: [grow(ring, 0.4)] }, properties: { h: h + 0.4 } });
  }
  return out;
}

function siteGeoJson(b: SiteBoundary): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [
      { type: "Feature", geometry: b.fill, properties: { kind: "fill" } },
      { type: "Feature", geometry: b.outline, properties: { kind: "line" } },
    ],
  };
}

function shapeBounds(shape: Complex3d | null): [number, number, number, number] | null {
  if (!shape) return null;
  const b: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const x of shape.buildings)
    for (const [lng, lat] of x.rings?.[0] ?? []) {
      b[0] = Math.min(b[0], lng);
      b[1] = Math.min(b[1], lat);
      b[2] = Math.max(b[2], lng);
      b[3] = Math.max(b[3], lat);
    }
  return Number.isFinite(b[0]) ? b : null;
}

/** 작은 기억 상자 — 오래된 것부터 뺀다 */
function remember<T>(m: Map<string, T>, k: string, v: T) {
  m.delete(k);
  m.set(k, v);
  if (m.size > SHAPE_CACHE_MAX) m.delete(m.keys().next().value!);
}

export default function Seoul3DMap({
  initial,
  conditions,
  viewRef,
  focus = null,
  onCardChange,
  initialSelectedId = null,
  frameInitialSelected = false,
  onSelectedChange,
  sessionPath,
  labelMetric = "price",
  onLabelMetricChange,
  onMoveEnd,
  satelliteKey = null,
}: {
  initial: Map3dView;
  /** 2D 지도의 조건(거래유형·전용면적·필터 칩) — 2D와 같은 단지만 보이게 */
  conditions: MapConditions;
  /** 2D로 돌아갈 때 3D에서 보던 곳을 읽는 함수를 여기 넣어 둔다 */
  viewRef?: MutableRefObject<(() => Map3dView) | null>;
  /** 밖(지도 브리핑)에서 고른 곳 — seq 가 바뀔 때마다 그리로 날아가고, 단지면 고른다(경계·동 강조) */
  focus?: { lat: number; lng: number; complexId: string | null; seq: number } | null;
  /** 아래 단지 카드가 떴는지 — 밖의 시트가 카드와 겹치지 않게 */
  onCardChange?: (shown: boolean) => void;
  /** 뒤로 와서 되살릴 때 고른 단지 (카메라는 initial 그대로 — 다시 담지 않는다) */
  initialSelectedId?: string | null;
  /** 2D에서 고른 단지를 들고 올 때 — 되살림과 달리 그 단지를 새로 담는다 */
  frameInitialSelected?: boolean;
  /** 고른 단지가 바뀔 때마다 — 2D로 돌아갈 때 그대로 고른 채로 */
  onSelectedChange?: (id: string | null) => void;
  /** 이 지도 입구(/, /map) — 카메라·고른 단지를 sessionStorage 에 둔다 */
  sessionPath?: string;
  /** 이름표 값 — 2D 마커 표시와 같은 값(같은 설정을 나눠 쓴다) */
  labelMetric?: MarkerMetric;
  onLabelMetricChange?: (m: MarkerMetric) => void;
  /** 카메라가 멈출 때마다 (지도 브리핑 '지역' 범위) */
  onMoveEnd?: (v: Map3dView) => void;
  /** 브이월드 위성영상 키 (없으면 위성 버튼을 숨긴다) */
  satelliteKey?: string | null;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MlMap | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** 마지막으로 부른 범위·조건 — 새 화면이 그 안이고 잘리지 않았으면 다시 부르지 않는다 */
  const lastRef = useRef<{ box: Box; params: string; truncated: boolean } | null>(null);
  const [styleReady, setStyleReady] = useState(false);
  /** 바닥을 위성영상으로 — 브라우저에 기억 */
  const [satellite, setSatellite] = useState(false);
  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (satelliteKey && window.localStorage.getItem(SATELLITE_PREF) === "1") setSatellite(true);
    } catch {
      /* 저장소를 못 쓰면 끔 */
    }
  }, [satelliteKey]);
  const toggleSatellite = () =>
    setSatellite((on) => {
      try {
        window.localStorage.setItem(SATELLITE_PREF, on ? "0" : "1");
      } catch {
        /* 기억 못 해도 전환은 된다 */
      }
      return !on;
    });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [buildingsMissing, setBuildingsMissing] = useState(false);
  const [complexes, setComplexes] = useState<MapComplex[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId);
  const [selAtRaw, setSelAt] = useState<PointAt | null>(null);
  const selAt = selAtRaw && selAtRaw.id === selectedId ? selAtRaw : null;
  /** 되살린 단지는 카메라를 다시 담지 않는다 (저장된 카메라 그대로) */
  const skipFrameRef = useRef<string | null>(frameInitialSelected ? null : initialSelectedId);
  const selectedIdRef = useRef<string | null>(initialSelectedId);
  /** 지표 · 색 범례 팝오버 */
  const [legendOpen, setLegendOpen] = useState(false);
  const legendRef = useRef<HTMLDivElement | null>(null);
  // 팝오버 밖을 누르거나 Esc — 닫는다
  useEffect(() => {
    if (!legendOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!legendRef.current?.contains(e.target as Node)) setLegendOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLegendOpen(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [legendOpen]);
  /** 고른 단지 — 지도를 옮겨 목록에서 빠져도 카드·강조가 남게 고를 때 값을 잡아 둔다 */
  const [picked, setPicked] = useState<MapComplex | null>(null);
  const [metric, setMetric] = useState<Map3dMetric>("perPyeong");
  const [zoomedOut, setZoomedOut] = useState(initial.zoom < COMPLEX_MIN_ZOOM);
  const [outside, setOutside] = useState(!inSeoul(initial.lat, initial.lng));
  const [bearing, setBearing] = useState(0);
  /** 점 띄우기용 — 움직임이 멈출 때만 갱신 (매 프레임 다시 그리면 이름표가 깜빡인다) */
  const [lift, setLift] = useState<Lift>({ pitch: 0, bearing: 0 });
  const metricRef = useRef(metric);
  const labelMetricRef = useRef(labelMetric);
  const persistRef = useRef<(() => void) | null>(null);
  const onMoveEndRef = useRef(onMoveEnd);
  useEffect(() => {
    onMoveEndRef.current = onMoveEnd;
  }, [onMoveEnd]);
  const shapeCache = useRef(new Map<string, Complex3d | null>());
  const siteCache = useRef(new Map<string, SiteBoundary | null>());
  const zoneCache = useRef(new Map<string, SchoolZoneGeo | null>());
  /** 통학구역을 그리고 있는 단지 — 출처 ⓘ에 통학구역 출처를 더할 때만 */
  const [zoneShownId, setZoneShownId] = useState<string | null>(null);

  const deal = conditions.deal;
  const { min: areaMin, max: areaMax } = areaQuery(conditions);
  /** 전용면적 말고 다른 조건 칩이 걸렸나 — 없으면 그리는 값만(fields=lite) 받는다 */
  const chipFilters = activeCount({ ...conditions, ranges: { ...conditions.ranges, area: undefined } }) > 0;

  const fetchComplexes = useCallback(async () => {
    const map = mapRef.current;
    if (!map) return;
    const c = map.getCenter();
    const z = map.getZoom();
    const out = z < COMPLEX_MIN_ZOOM;
    setZoomedOut(out);
    setOutside(!inSeoul(c.lat, c.lng));
    // 멀리 보면 단지를 부르지 않는다 (고른 단지는 그대로 — 풀기는 사용자가)
    if (out) return;
    const box = viewBox(map);
    const params = new URLSearchParams({ areaMin: String(areaMin), areaMax: String(areaMax), deal });
    if (!chipFilters) params.set("fields", "lite");
    params.set("view", "3d");
    const paramsKey = params.toString();
    const last = lastRef.current;
    if (last && last.params === paramsKey && !last.truncated && contains(last.box, box)) return;
    const entry = { box, params: paramsKey, truncated: false };
    lastRef.current = entry;
    const qs = new URLSearchParams({
      swLat: box.s.toFixed(3),
      swLng: box.w.toFixed(3),
      neLat: box.n.toFixed(3),
      neLng: box.e.toFixed(3),
    });
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    try {
      const res = await fetch(`/api/map/complexes?${qs}&${paramsKey}`, { signal: ac.signal });
      // lite 응답은 MapComplex의 일부 값만 — 조건 칩이 없을 때라 matches()는 빠진 값을 읽지 않는다
      const data = (await res.json()) as { status: string; complexes?: MapComplex[]; truncated?: boolean };
      if (data.status !== "ok" && data.status !== "zoom_in") throw new Error(data.status);
      const cut = Boolean(data.truncated);
      entry.truncated = cut;
      setComplexes(data.complexes ?? []);
      setTruncated(cut);
      setError(null);
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      if (lastRef.current === entry) lastRef.current = null;
      setError("단지 정보를 불러오지 못했습니다.");
    } finally {
      if (!ac.signal.aborted) setLoading(false);
    }
  }, [deal, areaMin, areaMax, chipFilters]);
  /** 지도 이벤트는 처음 한 번 걸어 두므로 늘 최신 함수를 부르게 */
  const fetchRef = useRef(fetchComplexes);
  useEffect(() => {
    fetchRef.current = fetchComplexes;
    // 거래유형·면적이 바뀌면 다시 부른다 (처음은 지도 load에서)
    if (mapRef.current && styleReady) void fetchComplexes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchComplexes]);

  // 2D와 같은 조건 칩(세대수·입주년차·전세가율 …) — 2D 목록과 같은 방식으로 거른다
  const visible = useMemo(() => complexes.filter((c) => matches(c, conditions)), [complexes, conditions]);
  const visibleRef = useRef(visible);
  useEffect(() => {
    visibleRef.current = visible;
  }, [visible]);
  const nActive = activeCount(conditions);

  // 지도 만들기
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let moveTimer: number | undefined;
    if (!protocolAdded) {
      maplibregl.addProtocol("pmtiles", new Protocol().tile);
      protocolAdded = true;
    }
    const reduce = reducedMotion();
    let map: MlMap;
    /** 카메라·고른 단지 기억 — 3D 단지 탐색·단지 상세에서 뒤로 오면 그대로 */
    const persist = () => {
      if (!sessionPath || !map) return;
      const c = map.getCenter();
      write3dSession(sessionPath, {
        lat: c.lat,
        lng: c.lng,
        zoom: map.getZoom(),
        pitch: map.getPitch(),
        bearing: map.getBearing(),
        selectedId: selectedIdRef.current,
      });
    };
    persistRef.current = persist;
    (async () => {
      let style: StyleSpecification;
      try {
        const res = await fetch(BASEMAP_STYLE_URL);
        style = calmBasemap((await res.json()) as StyleSpecification);
      } catch {
        if (!cancelled) {
          setError("바탕 지도를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.");
          setLoading(false);
        }
        return;
      }
      if (cancelled) return;
      try {
        map = new maplibregl.Map({
          container: host,
          style,
          center: [initial.lng, initial.lat],
          zoom: initial.zoom,
          pitch: initial.pitch ?? (reduce ? START_PITCH : 0),
          bearing: initial.bearing ?? 0,
          minZoom: 10,
          maxZoom: 18.5,
          maxPitch: 70,
          // 출처는 왼쪽 아래 ⓘ로 따로 (Map3dAttribution — 처음 잠깐 펼쳤다가 접힘, 누르면 전체)
          attributionControl: false,
          locale: LOCALE_KO,
          localIdeographFontFamily: "'Noto Sans KR', 'Apple SD Gothic Neo', 'Malgun Gothic', sans-serif",
          pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
          canvasContextAttributes: { antialias: false, powerPreference: "high-performance" },
          reduceMotion: reduce,
          fadeDuration: reduce ? 0 : 200,
          maxTileCacheZoomLevels: 3,
        });
      } catch {
        setError("이 기기에서는 3D 지도를 표시할 수 없습니다 (WebGL 미지원).");
        setLoading(false);
        return;
      }
      mapRef.current = map;
      if (viewRef) {
        viewRef.current = () => {
          const c = map.getCenter();
          return { lat: c.lat, lng: c.lng, zoom: map.getZoom() };
        };
      }
      map.addControl(new maplibregl.NavigationControl({ visualizePitch: true, showZoom: true }), "bottom-right");
      map.touchPitch.enable();
      map.on("error", (e) => {
        const msg = String((e as { error?: Error }).error?.message ?? "");
        const src = (e as { sourceId?: string }).sourceId;
        if (src === "buildings" || /pmtiles|seoul-buildings/i.test(msg)) setBuildingsMissing(true);
      });
      map.on("load", () => {
        if (cancelled) return;
        map.addSource("buildings", {
          type: "vector",
          url: `pmtiles://${buildingsTilesUrl()}`,
          attribution: BUILDINGS_ATTRIBUTION,
        });
        // 이름표 바탕 (흰 알약 · 고른 단지 청록 알약)
        for (const [id, fill, stroke] of [
          ["cx-pill", "#ffffff", "#0f766e"],
          ["cx-pill-sel", "#0f766e", "#0b4f4a"],
        ] as const) {
          const img = pillImage(fill, stroke);
          if (img && !map.hasImage(id)) map.addImage(id, img.data, img.options);
        }
        // 도로·지명 글자 아래에 건물을 둔다
        const firstSymbol = map.getStyle().layers.find((l) => l.type === "symbol")?.id;
        // 고른 단지 초등학교 통학구역 — 대지 경계보다 아래, 옅은 면 + 점선
        map.addSource("sel-zone", { type: "geojson", data: EMPTY });
        map.addLayer(
          {
            id: "sel-zone-fill",
            type: "fill",
            source: "sel-zone",
            paint: { "fill-color": SCHOOL_ZONE_COLOR, "fill-opacity": 0.08 },
          },
          firstSymbol,
        );
        map.addLayer(
          {
            id: "sel-zone-line",
            type: "line",
            source: "sel-zone",
            layout: { "line-join": "round" },
            paint: {
              "line-color": SCHOOL_ZONE_COLOR,
              "line-opacity": 0.85,
              "line-width": ["interpolate", ["linear"], ["zoom"], 13, 1.5, 16, 2.5],
              "line-dasharray": [2, 1.5],
            },
          },
          firstSymbol,
        );
        // 고른 단지 대지 경계 — 건물 아래 바닥에 (기울이면 건물이 가린다)
        map.addSource("sel-site", { type: "geojson", data: EMPTY });
        map.addLayer(
          {
            id: "sel-site-fill",
            type: "fill",
            source: "sel-site",
            filter: ["==", ["get", "kind"], "fill"],
            paint: { "fill-color": SELECTED_SITE_FILL, "fill-opacity": 0.14 },
          },
          firstSymbol,
        );
        map.addLayer(
          {
            id: "sel-site-line",
            type: "line",
            source: "sel-site",
            filter: ["==", ["get", "kind"], "line"],
            layout: { "line-join": "round", "line-cap": "round" },
            paint: {
              "line-color": SELECTED_SITE_LINE,
              "line-width": ["interpolate", ["linear"], ["zoom"], 13, 2.5, 16, 4.5, 18, 6],
            },
          },
          firstSymbol,
        );
        map.addLayer(
          {
            id: "buildings-3d",
            type: "fill-extrusion",
            source: "buildings",
            "source-layer": "buildings",
            minzoom: 12,
            paint: {
              "fill-extrusion-color": BUILDING_COLOR,
              "fill-extrusion-height": BUILDING_HEIGHT,
              "fill-extrusion-base": 0,
              "fill-extrusion-opacity": 0.92,
              "fill-extrusion-vertical-gradient": true,
            },
          },
          firstSymbol,
        );
        // 고른 단지 동 — 건물 타일 위에 청록으로 (외곽선을 조금 넓혀 같은 건물과 겹쳐 깜빡이지 않게)
        map.addSource("sel-buildings", { type: "geojson", data: EMPTY });
        map.addLayer(
          {
            id: "sel-buildings-3d",
            type: "fill-extrusion",
            source: "sel-buildings",
            paint: {
              "fill-extrusion-color": SELECTED_BUILDING_COLOR,
              "fill-extrusion-height": ["get", "h"],
              "fill-extrusion-base": 0,
              "fill-extrusion-opacity": 0.96,
              "fill-extrusion-vertical-gradient": true,
            },
          },
          firstSymbol,
        );
        map.addSource("complexes", { type: "geojson", data: toGeoJson([], metricRef.current, labelMetricRef.current) });
        map.addLayer({
          id: "complex-dots",
          type: "circle",
          source: "complexes",
          minzoom: COMPLEX_MIN_ZOOM,
          paint: {
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 13, 5, 16, 8],
            "circle-color": stepColor(metricRef.current),
            "circle-stroke-color": "#ffffff",
            "circle-stroke-width": 2,
            "circle-pitch-alignment": "viewport",
          },
        });
        map.addLayer({
          id: "complex-selected",
          type: "circle",
          source: "complexes",
          filter: ["==", ["get", "id"], ""],
          paint: {
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 13, 9, 16, 13],
            "circle-color": "rgba(0,0,0,0)",
            "circle-stroke-color": "#0f172a",
            "circle-stroke-width": 2.5,
            "circle-pitch-alignment": "viewport",
          },
        });
        // 단지 이름표 — 세대수 큰 단지 먼저, 겹치면 작은 단지 이름표를 뺀다. 점 위에 알약 바탕.
        const pillLayout: maplibregl.SymbolLayerSpecification["layout"] = {
          "icon-text-fit": "both",
          "icon-text-fit-padding": [3, 7, 3, 7],
          "text-size": 12,
          "text-anchor": "bottom",
          "text-offset": ["interpolate", ["linear"], ["zoom"], 13, ["literal", [0, -1.05]], 16, ["literal", [0, -1.35]]],
          "text-font": ["Noto Sans Bold"],
          "text-max-width": 20,
          "text-line-height": 1.25,
          "text-pitch-alignment": "viewport",
          "icon-pitch-alignment": "viewport",
        };
        map.addLayer({
          id: "complex-labels",
          type: "symbol",
          source: "complexes",
          minzoom: LABEL_ZOOM,
          filter: ["!=", ["get", "id"], ""],
          layout: {
            ...pillLayout,
            "icon-image": "cx-pill",
            "text-field": LABEL_TEXT,
            "text-allow-overlap": false,
            "icon-allow-overlap": false,
            "text-padding": 3,
            "symbol-sort-key": ["-", 0, ["coalesce", ["get", "hh"], 0]],
          },
          paint: { "text-color": "#0f172a" },
        });
        map.addLayer({
          id: "complex-label-selected",
          type: "symbol",
          source: "complexes",
          filter: ["==", ["get", "id"], ""],
          layout: {
            ...pillLayout,
            "icon-image": "cx-pill-sel",
            "text-field": SELECTED_LABEL_TEXT,
            "text-allow-overlap": true,
            "icon-allow-overlap": true,
          },
          paint: { "text-color": "#ffffff" },
        });
        const pick = (e: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
          const id = e.features?.[0]?.properties?.id;
          if (typeof id !== "string") return;
          const c = visibleRef.current.find((x) => x.complexId === id);
          if (c) setPicked(c);
          setSelectedId(id);
        };
        const pickable = ["complex-dots", "complex-labels", "complex-label-selected"];
        for (const l of pickable) {
          map.on("click", l, pick);
          map.on("mouseenter", l, () => (map.getCanvas().style.cursor = "pointer"));
          map.on("mouseleave", l, () => (map.getCanvas().style.cursor = ""));
        }
        // 빈 곳을 누르면 고르기를 푼다 (고른 단지의 동·대지를 누른 것은 그대로)
        map.on("click", (e) => {
          const hit = map.queryRenderedFeatures(e.point, { layers: [...pickable, "sel-buildings-3d", "sel-site-fill"] });
          if (!hit.length) setSelectedId(null);
        });
        setStyleReady(true);
        setLoading(false);
        // 처음 한 번 비스듬히 — 3D임을 알 수 있게 (동작 줄이기면 바로)
        if (!reduce && initial.pitch == null) map.easeTo({ pitch: START_PITCH, duration: 900 });
        void fetchRef.current();
      });
      map.on("rotate", () => setBearing(map.getBearing()));
      map.on("moveend", () => {
        persist();
        const next = { pitch: Math.round(map.getPitch()), bearing: Math.round(map.getBearing()) };
        setLift((prev) => (prev.pitch === next.pitch && prev.bearing === next.bearing ? prev : next));
        const mc = map.getCenter();
        onMoveEndRef.current?.({ lat: mc.lat, lng: mc.lng, zoom: map.getZoom() });
        window.clearTimeout(moveTimer);
        moveTimer = window.setTimeout(() => void fetchRef.current(), 300);
      });
    })();
    return () => {
      cancelled = true;
      window.clearTimeout(moveTimer);
      abortRef.current?.abort();
      if (viewRef) viewRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
    };
    // initial·viewRef는 처음 한 번만 쓴다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 밖에서 고른 곳으로 — 먼저 그 자리로 날아가고(단지가 목록에 들어오게), 단지면 고른다.
  // 멀리(약 15km 넘게)·줌이 크게 바뀌면 날지 않고 바로 옮긴다.
  // 고르면 아래 '고른 단지' 효과가 대지 경계에 맞춰 다시 담는다.
  const focusSeq = focus?.seq ?? null;
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReady || !focus) return;
    const opts = {
      center: [focus.lng, focus.lat] as [number, number],
      zoom: focus.complexId ? Math.max(map.getZoom(), 15.5) : 14,
      pitch: FOCUS_PITCH,
      bearing: map.getBearing(),
    };
    const here = map.getCenter();
    const far = shouldJump({ lat: here.lat, lng: here.lng, zoom: map.getZoom() }, { lat: focus.lat, lng: focus.lng, zoom: opts.zoom });
    if (reducedMotion() || far) map.jumpTo(opts);
    else map.flyTo({ ...opts, duration: 1000, essential: false });
    setSelectedId(focus.complexId);
    setPicked(null);
    // seq 가 바뀔 때만 (같은 곳을 다시 골라도 seq 가 새로 온다)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusSeq, styleReady]);

  // 고른 단지의 초등학교 통학구역 — 한 단지씩 불러 그린다. 없으면(서울·경기 밖·판정 없음) 그리지 않는다.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReady) return;
    const src = map.getSource("sel-zone") as GeoJSONSource | undefined;
    // 바꾸거나 풀면 먼저 지운다 (출처는 zoneShownId === selectedId 일 때만 보여 따로 비우지 않는다)
    src?.setData(EMPTY);
    if (!selectedId) return;
    const id = selectedId;
    const ac = new AbortController();
    const p = zoneCache.current.has(id)
      ? Promise.resolve(zoneCache.current.get(id) ?? null)
      : fetch(`/api/complex-school-zone/${id}`, { signal: ac.signal })
          .then((r) => (r.ok ? (r.json() as Promise<SchoolZoneGeo>) : null))
          .then((z) => (remember(zoneCache.current, id, z), z));
    p.then((z) => {
      if (ac.signal.aborted || !z?.geometry?.features?.length) return;
      src?.setData(z.geometry);
      setZoneShownId(id);
    }).catch(() => {});
    return () => ac.abort();
  }, [selectedId, styleReady]);

  // 위성영상 — 바탕 지도 위, 단지 경계·건물 아래 (길 이름 등 글자는 그 위에 그대로)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReady || !satelliteKey) return;
    if (!satellite) {
      if (map.getLayer("satellite")) map.removeLayer("satellite");
      return;
    }
    if (!map.getSource("satellite")) {
      map.addSource("satellite", {
        type: "raster",
        tiles: [`https://api.vworld.kr/req/wmts/1.0.0/${encodeURIComponent(satelliteKey)}/Satellite/{z}/{y}/{x}.jpeg`],
        tileSize: 256,
        maxzoom: 19,
        attribution: SATELLITE_ATTRIBUTION.text,
      });
    }
    if (!map.getLayer("satellite")) {
      map.addLayer({ id: "satellite", type: "raster", source: "satellite", paint: { "raster-opacity": 0.95 } }, "sel-zone-fill");
    }
  }, [satellite, satelliteKey, styleReady]);

  // 단지 점·이름표·지표 갱신
  useEffect(() => {
    metricRef.current = metric;
    labelMetricRef.current = labelMetric;
    const map = mapRef.current;
    if (!map || !styleReady) return;
    (map.getSource("complexes") as GeoJSONSource | undefined)?.setData(toGeoJson(visible, metric, labelMetric, selAt, lift));
    map.setPaintProperty("complex-dots", "circle-color", stepColor(metric));
  }, [visible, metric, labelMetric, styleReady, selAt, lift]);

  // 고른 단지 — 점 테두리 · 이름표
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReady) return;
    const id = selectedId ?? "";
    map.setFilter("complex-selected", ["==", ["get", "id"], id]);
    map.setFilter("complex-label-selected", ["==", ["get", "id"], id]);
    map.setFilter("complex-labels", ["!=", ["get", "id"], id]);
  }, [selectedId, styleReady]);

  // 고른 단지 모양·높이(동 강조, 3D 버튼) · 대지 경계 — 바꾸거나 풀면 먼저 지운다
  const [has3d, setHas3d] = useState<Record<string, boolean>>({});
  useEffect(() => {
    selectedIdRef.current = selectedId;
    persistRef.current?.();
    const map = mapRef.current;
    if (!map || !styleReady) return;
    const setSrc = (id: string, data: GeoJSON.FeatureCollection) =>
      (map.getSource(id) as GeoJSONSource | undefined)?.setData(data);
    setSrc("sel-buildings", EMPTY);
    setSrc("sel-site", EMPTY);
    const dim = selectedId != null;
    map.setPaintProperty("buildings-3d", "fill-extrusion-color", dim ? BUILDING_COLOR_DIM : BUILDING_COLOR);
    map.setPaintProperty("buildings-3d", "fill-extrusion-opacity", dim ? 0.7 : 0.92);
    if (!selectedId) return;

    const ac = new AbortController();
    const id = selectedId;
    const getJson = async <T,>(url: string): Promise<T | null> => {
      const res = await fetch(url, { signal: ac.signal });
      return res.ok ? ((await res.json()) as T) : null;
    };
    const shapeP = shapeCache.current.has(id)
      ? Promise.resolve(shapeCache.current.get(id) ?? null)
      : getJson<Complex3d>(`/api/complex-3d/${id}?v=2&shapes=1`).then((s) => (remember(shapeCache.current, id, s), s));
    const siteP = siteCache.current.has(id)
      ? Promise.resolve(siteCache.current.get(id) ?? null)
      : getJson<SiteBoundary>(`/api/complex-3d/${id}/boundary?v=2`).then((b) => (remember(siteCache.current, id, b), b));

    let curShape: Complex3d | null = null;
    let curSite: SiteBoundary | null = null;
    const paintSel = () => {
      if (ac.signal.aborted) return;
      const c = massCenter(curShape, curSite);
      setSelAt((prev) =>
        c && !(prev?.id === id && prev.lng === c[0] && prev.lat === c[1]) ? { id, lng: c[0], lat: c[1] } : prev,
      );
      const own = curShape ? buildingsGeoJson(curShape).features : [];
      setSrc("sel-buildings", { type: "FeatureCollection", features: [...tileBuildingsOf(map, curShape, curSite), ...own] });
    };
    // 건물 타일이 늦게 오면(비행 중 새 타일) 다시 덮는다
    let t: ReturnType<typeof setTimeout> | undefined;
    const onData = (e: maplibregl.MapSourceDataEvent) => {
      if (e.sourceId !== "buildings" || !e.isSourceLoaded) return;
      clearTimeout(t);
      t = setTimeout(paintSel, 150);
    };
    map.on("sourcedata", onData);
    ac.signal.addEventListener("abort", () => {
      clearTimeout(t);
      map.off("sourcedata", onData);
    });
    shapeP
      .then((shape) => {
        if (ac.signal.aborted) return;
        // 확인이 안 되면 3D 버튼은 그대로 둔다 (3D 화면이 빈 상태를 안내)
        setHas3d((m) => ({ ...m, [id]: shape ? shape.coverage.withShape > 0 : true }));
        curShape = shape;
        paintSel();
      })
      .catch(() => {});
    siteP
      .then((site) => {
        if (ac.signal.aborted || !site) return;
        curSite = site;
        setSrc("sel-site", siteGeoJson(site));
        paintSel();
      })
      .catch(() => {});

    // 되살린 단지는 저장된 카메라 그대로 (한 번만)
    const skipFrame = skipFrameRef.current === id;
    skipFrameRef.current = null;
    // 단지를 비스듬히 담는다 — 경계(없으면 동 범위)에 맞춰, 아래 카드에 가리지 않게
    void Promise.allSettled([siteP, shapeP]).then(([s, sh]) => {
      if (ac.signal.aborted || skipFrame) return;
      const site = s.status === "fulfilled" ? s.value : null;
      const shape = sh.status === "fulfilled" ? sh.value : null;
      // 담을 범위 — 단지 경계와 동 범위를 합친 것 (경계가 없으면 동 범위)
      const sb = shapeBounds(shape);
      const bb: [number, number, number, number] | null =
        site?.bbox && sb
          ? [Math.min(site.bbox[0], sb[0]), Math.min(site.bbox[1], sb[1]), Math.max(site.bbox[2], sb[2]), Math.max(site.bbox[3], sb[3])]
          : (site?.bbox ?? sb);
      if (!bb) return;
      const box = map.getContainer();
      const w = box.clientWidth;
      // 가려지는 곳 — 위: 필터 줄 + 지표 알약(약 96px), 아래: 작은 단지 카드(모바일은 독까지)
      const mobile = w < 640;
      const safe = { top: 104, bottom: mobile ? 212 : 148, left: 16, right: 16 };
      const maxH = Math.max(0, ...(shape?.buildings ?? []).map((b) => buildingHeight(b)));
      // 아주 높은 탑상형은 덜 기울여 (위가 덜 길어지게)
      const pitch = maxH > 120 ? 50 : FOCUS_PITCH;
      // 기울기·원근·높이까지 넣어 보이는 곳의 약 80%를 채우게 (fit-camera.ts)
      const fit = fitComplexCamera(map, bb, maxH, safe, {
        pitch,
        bearing: map.getBearing(),
        fill: 0.8,
        minZoom: 14.5,
        maxZoom: FOCUS_MAX_ZOOM,
      });
      if (!fit) return;
      const opts = { center: fit.center, zoom: fit.zoom, pitch, bearing: map.getBearing() };
      if (reducedMotion()) map.jumpTo(opts);
      else map.flyTo({ ...opts, duration: 1100, essential: false });
    });
    return () => ac.abort();
  }, [selectedId, styleReady]);

  // 목록에 새 값이 오면 카드도 새 값으로 (목록에서 빠져도 고를 때 값은 남는다)
  const selected = selectedId
    ? (visible.find((c) => c.complexId === selectedId) ?? (picked?.complexId === selectedId ? picked : null))
    : null;
  const selected3d = selected ? has3d[selected.complexId] : undefined;
  const cardShown = selected != null;
  /** 카드 '더보기' — 연 단지에만 (다른 단지를 고르면 접힘) */
  const [cardMoreId, setCardMoreId] = useState<string | null>(null);
  const cardMore = selected != null && cardMoreId === selected.complexId;
  useEffect(() => {
    onCardChange?.(cardShown);
  }, [cardShown, onCardChange]);
  useEffect(() => {
    onSelectedChange?.(selectedId);
  }, [selectedId, onSelectedChange]);
  const dealLabel = DEAL_LABEL[deal];
  const steps = metric === "perPyeong" ? PER_PYEONG_STEPS : CHANGE_STEPS;

  const resetView = () => {
    const map = mapRef.current;
    if (!map) return;
    const opts = { bearing: 0, pitch: START_PITCH };
    if (reducedMotion()) map.jumpTo(opts);
    else map.easeTo({ ...opts, duration: 500 });
  };

  const notice = error
    ? error
    : outside
      ? "3D 건물은 서울만 준비돼 있어요"
      : zoomedOut
        ? "지도를 확대하면 단지가 보여요"
        : buildingsMissing
          ? "3D 건물 준비 중 — 바탕 지도와 단지만 보여요"
          : null;

  return (
    <div className="seoul3d absolute inset-0 z-20 bg-[#f4f5f2]" role="region" aria-label="서울 3D 지도">
      <style>{CONTROL_CSS}</style>
      <div ref={hostRef} className="h-full w-full" role="application" aria-label="3D 지도 — 두 손가락으로 기울이고 돌려 보세요" />

      {loading ? <LabIndeterminateBar className="pointer-events-none absolute inset-x-0 top-0 !h-0.5 !rounded-none" /> : null}
      {/*
        위: 맨 위 줄(2D | 3D · 거래유형 · 조건)은 MapSearchPage가 이 위에 그린다. 그 아래는 한 줄만 —
        지표 알약(누르면 지표 고르기 · 색 범례 팝오버) + 짧은 상태. 안내(확대·서울 밖·오류)는 있을 때만 한 줄 더.
      */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-col items-start gap-1.5 px-3 pt-[54px] sm:px-4 sm:pt-[60px]">
        <div className="flex max-w-full items-center gap-1.5">
          <div ref={legendRef} className="pointer-events-auto relative shrink-0">
            <button
              type="button"
              aria-haspopup="dialog"
              aria-expanded={legendOpen}
              aria-controls={legendOpen ? "map3d-legend" : undefined}
              onClick={() => setLegendOpen((v) => !v)}
              className="relative inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full border border-[color:var(--lab-navy-950)] bg-[color:var(--lab-surface)] pl-3 pr-2 text-[13px] font-semibold leading-5 text-[color:var(--lab-navy-950)] shadow-sm before:absolute before:inset-x-0 before:-inset-y-1 before:content-['']"
              data-map3d-legend-pill
            >
              {/* 이름표 값(2D 마커 표시와 같음) + 점 색 막대 — 하나의 알약 */}
              {labelMetric === "price" ? `${dealLabel}가` : (MARKER_METRICS.find((m) => m.id === labelMetric)?.label ?? "")}
              {/* 작은 색 막대 — 점 색 범례 단계 그대로 */}
              <span className="flex h-2 w-9 overflow-hidden rounded-full" aria-hidden>
                {steps.map(([min, color]) => (
                  <span key={String(min)} className="h-full flex-1" style={{ background: color }} />
                ))}
              </span>
              <ChevronDown
                className={`h-4 w-4 opacity-60 transition-transform motion-reduce:transition-none ${legendOpen ? "rotate-180" : ""}`}
                aria-hidden
              />
            </button>
            {legendOpen ? (
              <div
                id="map3d-legend"
                role="dialog"
                aria-label="이름표 값 · 점 색 · 범례"
                className="absolute left-0 top-[calc(100%+6px)] z-10 w-[244px] rounded-xl border border-[color:var(--lab-border)] bg-[color:var(--lab-surface)] p-2.5 shadow-[0_8px_24px_rgb(15_23_42/0.16)]"
              >
                <p className="mb-1.5 text-[12px] font-semibold leading-4 text-[color:var(--lab-navy-950)]">
                  이름표 값 <span className="font-normal text-[color:var(--lab-muted)]">· 2D 마커와 같음</span>
                </p>
                <div className="mb-2.5 grid grid-cols-2 gap-1" role="radiogroup" aria-label="이름표 값">
                  {MARKER_METRICS.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      role="radio"
                      aria-checked={labelMetric === m.id}
                      onClick={() => onLabelMetricChange?.(m.id)}
                      className={`h-9 whitespace-nowrap rounded-lg border text-[13px] leading-5 ${
                        labelMetric === m.id
                          ? "border-[color:var(--lab-brand-primary)] bg-[color:var(--lab-brand-subtle)] font-semibold text-[color:var(--lab-teal-700)]"
                          : "border-[color:var(--lab-border)] font-medium text-[color:var(--lab-navy-950)]"
                      }`}
                    >
                      {m.id === "price" ? `${dealLabel}가` : m.label}
                    </button>
                  ))}
                </div>
                <p className="mb-1.5 text-[12px] font-semibold leading-4 text-[color:var(--lab-navy-950)]">점 색</p>
                <div className="grid grid-cols-2 gap-1 rounded-full bg-[color:var(--lab-surface-subtle)] p-0.5" role="radiogroup" aria-label="점 색 기준">
                  {(
                    [
                      ["perPyeong", "평당가"],
                      ["change1y", "1년 변동"],
                    ] as const
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      role="radio"
                      aria-checked={metric === id}
                      onClick={() => setMetric(id)}
                      className={`h-9 whitespace-nowrap rounded-full text-[14px] leading-5 ${
                        metric === id
                          ? "bg-[color:var(--lab-navy-950)] font-semibold text-white"
                          : "font-medium text-[color:var(--lab-navy-950)]"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <p className="mt-2.5 text-[12px] font-semibold leading-4 text-[color:var(--lab-navy-950)]">
                  {metric === "perPyeong" ? `최근 ${dealLabel} 평당가` : `${dealLabel} 1년 변동`}
                </p>
                <ul className="mt-1.5 grid grid-cols-2 gap-x-2 gap-y-1 text-[12px] leading-5 text-[color:var(--lab-muted)]">
                  {steps.map(([min, color, label]) => (
                    <li key={String(min)} className="inline-flex items-center gap-1.5 whitespace-nowrap">
                      <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color }} aria-hidden />
                      {label}
                    </li>
                  ))}
                  <li className="inline-flex items-center gap-1.5 whitespace-nowrap">
                    <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: NO_VALUE_COLOR }} aria-hidden />
                    값 없음
                  </li>
                </ul>
              </div>
            ) : null}
          </div>
          {!zoomedOut && !outside && !error && (nActive > 0 || truncated) ? (
            <p
              className="pointer-events-auto min-w-0 truncate rounded-full bg-[color:var(--lab-surface)]/95 px-2.5 py-1 text-[12px] leading-5 text-[color:var(--lab-muted)] shadow-sm"
              role="status"
            >
              {[nActive > 0 ? `조건 맞는 ${visible.length}개` : null, truncated ? "세대수 큰 400개까지" : null]
                .filter(Boolean)
                .join(" · ")}
            </p>
          ) : null}
        </div>
        {notice ? (
          <p
            className={`pointer-events-auto rounded-lg px-3 py-1.5 text-[13px] font-medium shadow ${
              error ? "bg-[#fdecec] text-[#b42318]" : "bg-[color:var(--lab-navy-950)] text-white"
            }`}
            role={error ? "alert" : "status"}
          >
            {notice}
          </p>
        ) : null}
      </div>

      {/* 왼쪽 아래: 기울기·방향 초기화 (오른쪽 아래 확대·축소·나침반은 MapLibre 컨트롤) */}
      <button
        type="button"
        onClick={resetView}
        aria-label="보기 초기화 — 북쪽 위, 기본 기울기"
        className="absolute left-3 bottom-[calc(env(safe-area-inset-bottom)+132px+var(--map-sheet-peek,0px))] inline-flex h-11 w-11 items-center justify-center rounded-full border border-[color:var(--lab-border)] bg-[color:var(--lab-surface)] text-[color:var(--lab-navy-950)] shadow-sm sm:left-4 sm:bottom-[calc(env(safe-area-inset-bottom)+48px)]"
        style={selected ? { visibility: "hidden" } : undefined}
      >
        <Compass className="h-5 w-5" style={{ transform: `rotate(${-bearing}deg)` }} aria-hidden />
      </button>

      {/* 위성영상 켜고 끄기 — 보기 초기화 위 */}
      {satelliteKey ? (
        <button
          type="button"
          onClick={toggleSatellite}
          aria-pressed={satellite}
          aria-label={satellite ? "위성영상 끄기" : "위성영상으로 보기"}
          className={`absolute left-3 bottom-[calc(env(safe-area-inset-bottom)+184px+var(--map-sheet-peek,0px))] inline-flex h-11 w-11 items-center justify-center rounded-full border shadow-sm sm:left-4 sm:bottom-[calc(env(safe-area-inset-bottom)+100px)] ${
            satellite
              ? "border-[color:var(--lab-teal-700)] bg-[color:var(--lab-teal-700)] text-white"
              : "border-[color:var(--lab-border)] bg-[color:var(--lab-surface)] text-[color:var(--lab-navy-950)]"
          }`}
          style={selected ? { visibility: "hidden" } : undefined}
        >
          <Satellite className="h-5 w-5" aria-hidden />
        </button>
      ) : null}

      {/* 왼쪽 아래 출처 ⓘ — 독·시트 위, 단지 카드가 뜨면 카드 위로 */}
      <Map3dAttribution
        lines={[
          ...MAP3D_ATTRIBUTION,
          ...(satellite && satelliteKey ? [SATELLITE_ATTRIBUTION] : []),
          ...(zoneShownId && zoneShownId === selectedId ? [SCHOOL_ZONE_ATTRIBUTION] : []),
        ]}
        className={
          selected
            ? "z-10 bottom-[calc(env(safe-area-inset-bottom)+198px)] sm:bottom-[140px]"
            : "bottom-[calc(env(safe-area-inset-bottom)+80px+var(--map-sheet-peek,0px))] sm:bottom-1.5"
        }
      />

      {/* 아래: 고른 단지 카드 — 작게(약 108px): 이름·위치 / 최근 거래·지표 / 단지 상세 · 3D 탐색 */}
      {selected ? (
        <div className="absolute inset-x-0 bottom-0 z-10 px-3 pb-[calc(env(safe-area-inset-bottom)+76px)] sm:p-4 sm:pb-4">
          <div
            className="mx-auto w-full max-w-md rounded-2xl border border-[color:var(--lab-border)] bg-[color:var(--lab-surface)] px-3.5 pb-2.5 pt-2.5 shadow-lg"
            data-map3d-card
          >
            <div className="flex items-center gap-2">
              <p className="min-w-0 flex-1 truncate leading-5">
                <span className="text-[15px] font-bold text-[color:var(--lab-teal-700)]">{selected.aptName}</span>
                <span className="ml-1.5 text-[12px] text-[color:var(--lab-muted)]">
                  {[
                    selected.dong,
                    selected.householdCount ? `${selected.householdCount.toLocaleString("ko-KR")}세대` : null,
                    selected.buildYear ? `${selected.buildYear}년` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </p>
              <button
                type="button"
                onClick={() => setSelectedId(null)}
                aria-label="닫기"
                className="-my-1.5 -mr-2 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[color:var(--lab-muted)]"
              >
                <X className="h-5 w-5" aria-hidden />
              </button>
            </div>
            <p className="mt-0.5 flex min-w-0 items-baseline gap-1.5 whitespace-nowrap text-[13px] leading-5 text-[color:var(--lab-muted)]">
              <span className="shrink-0">
                최근 {dealLabel}
                {selected.pyeongLabel ? ` ${selected.pyeongLabel}` : ""}
              </span>
              <span className="shrink-0 text-[15px] font-bold tabular-nums text-[color:var(--lab-teal-700)]">
                {selected.priceMan ? formatEok(selected.priceMan) : "거래 없음"}
              </span>
              {selected.priceDate ? <span className="shrink-0 tabular-nums">{formatDealDate(selected.priceDate)}</span> : null}
              <span aria-hidden>·</span>
              <span className="min-w-0 truncate">
                {metric === "change1y" ? "1년 " : "평당 "}
                <span
                  className="font-semibold tabular-nums text-[color:var(--lab-teal-700)]"
                  style={
                    metric === "change1y" && selected.change1yPct
                      ? { color: selected.change1yPct > 0 ? "#D93A3F" : "#2F62D6" }
                      : undefined
                  }
                >
                  {metric === "change1y"
                    ? selected.change1yPct != null
                      ? metricText(selected.change1yPct, "change1y")
                      : "–"
                    : selected.perPyeongMan != null
                      ? shortPerPyeong(selected.perPyeongMan)
                      : "–"}
                </span>
              </span>
            </p>
            {cardMore ? <ComplexCardMore c={selected} id="map3d-card-more" /> : null}
            <div className="mt-1.5 flex gap-2">
              <Link
                href={selected.href}
                className="lab-button lab-button-primary h-9 !min-h-9 flex-1 text-[14px]"
              >
                단지 상세
              </Link>
              {selected3d ? (
                <Link
                  href={`/complex-3d/${selected.complexId}`}
                  className="lab-button lab-button-secondary h-9 !min-h-9 flex-1 text-[14px]"
                >
                  3D 탐색
                </Link>
              ) : (
                <button
                  type="button"
                  disabled
                  className="lab-button lab-button-secondary h-9 !min-h-9 flex-1 text-[14px]"
                >
                  {selected3d === false ? "3D 준비 중" : "3D 탐색"}
                </button>
              )}
              <button
                type="button"
                aria-expanded={cardMore}
                aria-controls="map3d-card-more"
                onClick={() => setCardMoreId(cardMore ? null : selected.complexId)}
                className="inline-flex h-9 shrink-0 items-center gap-0.5 rounded-lg px-2 text-[13px] font-semibold text-[color:var(--lab-teal-700)]"
              >
                {cardMore ? "접기" : "더보기"}
                <ChevronDown
                  className={`h-4 w-4 transition-transform motion-reduce:transition-none ${cardMore ? "rotate-180" : ""}`}
                  aria-hidden
                />
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

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
import { Compass, X } from "lucide-react";
import { LabIndeterminateBar } from "@/components/ui/LabLoading";
import { shortPerPyeong } from "@/components/map/complex-marker";
import type { MapComplex, MapDealKind } from "@/lib/map/map-complexes";
import { activeCount, areaQuery, matches, type MapConditions } from "@/lib/map/map-filters";
import type { Complex3d, Ring } from "@/lib/complex-3d/read";
import type { SiteBoundary } from "@/lib/complex-3d/boundary";
import { formatDealDate, formatEok } from "@/lib/utils/format";
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

export type Map3dView = { lat: number; lng: number; zoom: number };

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
const FOCUS_PITCH = 58;
const FOCUS_MAX_ZOOM = 17.2;
/** 고른 단지 도형 기억 (다시 골랐을 때 바로) — 많이 쌓지 않는다 */
const SHAPE_CACHE_MAX = 16;

let protocolAdded = false;

/** MapLibre 컨트롤 — 모바일 아래 탭 막대 위로, 손가락 크기(44px) */
const CONTROL_CSS = `
.seoul3d .maplibregl-ctrl-bottom-right{bottom:calc(env(safe-area-inset-bottom) + 76px)}
@media (min-width:640px){.seoul3d .maplibregl-ctrl-bottom-right{bottom:0}}
.seoul3d .maplibregl-ctrl-group button{width:40px;height:40px}
.seoul3d .maplibregl-ctrl-attrib{font-size:11px}
`;

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

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

/** 이름표 값 색 — 평당가는 집랩 청록, 1년 변동은 상승 빨강·하락 파랑 (2D 마커와 같음) */
function metricColor(v: number | null, metric: Map3dMetric): string {
  if (v == null) return "#94a3b8";
  if (metric === "perPyeong") return "#115e59";
  return v > 0 ? "#D93A3F" : v < 0 ? "#2F62D6" : "#64748b";
}

/** 긴 단지 이름은 이름표에서 줄인다 (카드에는 전체 이름) */
function shortName(name: string): string {
  const s = name.trim();
  return s.length > 11 ? `${s.slice(0, 10)}…` : s;
}

function toGeoJson(list: MapComplex[], metric: Map3dMetric): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: list.map((c) => {
      const v = metricValue(c, metric);
      const props: Record<string, string | number> = {
        id: c.complexId,
        name: shortName(c.aptName),
        label: metricText(v, metric),
        vc: metricColor(v, metric),
        hh: c.householdCount ?? 0,
      };
      if (v != null) props.v = v;
      return { type: "Feature", geometry: { type: "Point", coordinates: [c.lng, c.lat] }, properties: props };
    }),
  };
}

/** 이름(가운데 줌) → 이름 · 값(가까이) */
const LABEL_TEXT = [
  "step",
  ["zoom"],
  ["get", "name"],
  VALUE_ZOOM,
  [
    "format",
    ["get", "name"],
    {},
    ["case", ["==", ["get", "label"], ""], "", " · "],
    {},
    ["get", "label"],
    { "text-color": ["to-color", ["get", "vc"]] },
  ],
] as unknown as ExpressionSpecification;

/** 고른 단지 이름표는 줌과 상관없이 이름 · 값 (청록 바탕 위 흰 글자) */
const SELECTED_LABEL_TEXT = [
  "format",
  ["get", "name"],
  {},
  ["case", ["==", ["get", "label"], ""], "", " · "],
  {},
  ["get", "label"],
  {},
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
}: {
  initial: Map3dView;
  /** 2D 지도의 조건(거래유형·전용면적·필터 칩) — 2D와 같은 단지만 보이게 */
  conditions: MapConditions;
  /** 2D로 돌아갈 때 3D에서 보던 곳을 읽는 함수를 여기 넣어 둔다 */
  viewRef?: MutableRefObject<(() => Map3dView) | null>;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MlMap | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** 마지막으로 부른 범위·조건 — 새 화면이 그 안이고 잘리지 않았으면 다시 부르지 않는다 */
  const lastRef = useRef<{ box: Box; params: string; truncated: boolean } | null>(null);
  const [styleReady, setStyleReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [buildingsMissing, setBuildingsMissing] = useState(false);
  const [complexes, setComplexes] = useState<MapComplex[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** 고른 단지 — 지도를 옮겨 목록에서 빠져도 카드·강조가 남게 고를 때 값을 잡아 둔다 */
  const [picked, setPicked] = useState<MapComplex | null>(null);
  const [metric, setMetric] = useState<Map3dMetric>("perPyeong");
  const [zoomedOut, setZoomedOut] = useState(initial.zoom < COMPLEX_MIN_ZOOM);
  const [outside, setOutside] = useState(!inSeoul(initial.lat, initial.lng));
  const [bearing, setBearing] = useState(0);
  const metricRef = useRef(metric);
  const shapeCache = useRef(new Map<string, Complex3d | null>());
  const siteCache = useRef(new Map<string, SiteBoundary | null>());

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
          pitch: reduce ? START_PITCH : 0,
          bearing: 0,
          minZoom: 10,
          maxZoom: 18.5,
          maxPitch: 70,
          attributionControl: { compact: true },
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
        map.addSource("complexes", { type: "geojson", data: toGeoJson([], metricRef.current) });
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
        if (!reduce) map.easeTo({ pitch: START_PITCH, duration: 900 });
        void fetchRef.current();
      });
      map.on("rotate", () => setBearing(map.getBearing()));
      map.on("moveend", () => {
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

  // 단지 점·이름표·지표 갱신
  useEffect(() => {
    metricRef.current = metric;
    const map = mapRef.current;
    if (!map || !styleReady) return;
    (map.getSource("complexes") as GeoJSONSource | undefined)?.setData(toGeoJson(visible, metric));
    map.setPaintProperty("complex-dots", "circle-color", stepColor(metric));
  }, [visible, metric, styleReady]);

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
      : getJson<SiteBoundary>(`/api/complex-3d/${id}/boundary`).then((b) => (remember(siteCache.current, id, b), b));

    shapeP
      .then((shape) => {
        if (ac.signal.aborted) return;
        // 확인이 안 되면 3D 버튼은 그대로 둔다 (3D 화면이 빈 상태를 안내)
        setHas3d((m) => ({ ...m, [id]: shape ? shape.coverage.withShape > 0 : true }));
        if (shape) setSrc("sel-buildings", buildingsGeoJson(shape));
      })
      .catch(() => {});
    siteP
      .then((site) => {
        if (!ac.signal.aborted && site) setSrc("sel-site", siteGeoJson(site));
      })
      .catch(() => {});

    // 단지를 비스듬히 담는다 — 경계(없으면 동 범위)에 맞춰, 아래 카드에 가리지 않게
    void Promise.allSettled([siteP, shapeP]).then(([s, sh]) => {
      if (ac.signal.aborted) return;
      const site = s.status === "fulfilled" ? s.value : null;
      const shape = sh.status === "fulfilled" ? sh.value : null;
      const bb = site?.bbox ?? shapeBounds(shape);
      if (!bb) return;
      const h = map.getContainer().clientHeight;
      const cam = map.cameraForBounds(
        [
          [bb[0], bb[1]],
          [bb[2], bb[3]],
        ],
        {
          padding: { top: 120, bottom: Math.min(Math.round(h * 0.45), 340), left: 40, right: 40 },
          bearing: map.getBearing(),
        },
      );
      if (!cam?.center || cam.zoom == null) return;
      const opts = {
        center: cam.center,
        zoom: Math.min(cam.zoom, FOCUS_MAX_ZOOM),
        pitch: FOCUS_PITCH,
        bearing: map.getBearing(),
      };
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
      {/* 위: 맨 위 줄(2D | 3D · 거래유형 · 조건)은 MapSearchPage가 이 위에 그린다 — 그 아래에 지표 · 범례 · 상태 */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-col gap-2 px-3 pt-[60px] sm:px-4 sm:pt-[64px]">
        <div
          className="pointer-events-auto inline-flex h-9 shrink-0 self-start rounded-full border border-[color:var(--lab-navy-950)] bg-[color:var(--lab-surface)] p-0.5 shadow-sm"
          role="group"
          aria-label="단지 색 기준"
        >
          {(
            [
              ["perPyeong", "평당가"],
              ["change1y", "1년 변동"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={metric === id}
              onClick={() => setMetric(id)}
              className={`relative whitespace-nowrap rounded-full px-3 text-[14px] leading-5 before:absolute before:inset-x-0 before:-inset-y-1.5 before:content-[''] ${
                metric === id
                  ? "bg-[color:var(--lab-navy-950)] font-semibold text-white"
                  : "font-medium text-[color:var(--lab-navy-950)]"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="pointer-events-auto flex max-w-full flex-wrap items-center gap-x-2 gap-y-0.5 self-start rounded-lg bg-[color:var(--lab-surface)]/95 px-2.5 py-1 text-[12px] leading-5 text-[color:var(--lab-muted)] shadow-sm">
          <span className="font-semibold text-[color:var(--lab-navy-950)]">
            {metric === "perPyeong" ? `최근 ${dealLabel} 평당가` : `${dealLabel} 1년 변동`}
          </span>
          {steps.map(([min, color, label]) => (
            <span key={String(min)} className="inline-flex items-center gap-1 whitespace-nowrap">
              <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: color }} aria-hidden />
              {label}
            </span>
          ))}
          <span className="inline-flex items-center gap-1 whitespace-nowrap">
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: NO_VALUE_COLOR }} aria-hidden />
            값 없음
          </span>
        </div>
        {!zoomedOut && !outside && !error && (nActive > 0 || truncated) ? (
          <p
            className="pointer-events-auto self-start rounded-lg bg-[color:var(--lab-surface)]/95 px-2.5 py-1 text-[12px] leading-5 text-[color:var(--lab-muted)] shadow-sm"
            role="status"
          >
            {[
              nActive > 0 ? `조건 맞는 ${visible.length}개 단지` : null,
              truncated ? "세대수 큰 400개 단지까지 — 확대하면 더 보여요" : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        ) : null}
        {notice ? (
          <p
            className={`pointer-events-auto self-start rounded-lg px-3 py-1.5 text-[13px] font-medium shadow ${
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
        className="absolute left-3 bottom-[calc(env(safe-area-inset-bottom)+132px)] inline-flex h-11 w-11 items-center justify-center rounded-full border border-[color:var(--lab-border)] bg-[color:var(--lab-surface)] text-[color:var(--lab-navy-950)] shadow-sm sm:left-4 sm:bottom-[calc(env(safe-area-inset-bottom)+48px)]"
        style={selected ? { visibility: "hidden" } : undefined}
      >
        <Compass className="h-5 w-5" style={{ transform: `rotate(${-bearing}deg)` }} aria-hidden />
      </button>

      {/* 아래: 고른 단지 카드 */}
      {selected ? (
        <div className="absolute inset-x-0 bottom-0 z-10 px-4 pb-[calc(env(safe-area-inset-bottom)+76px)] sm:p-4 sm:pb-4">
          <div className="mx-auto w-full max-w-md rounded-2xl border border-[color:var(--lab-border)] bg-[color:var(--lab-surface)] p-4 shadow-lg">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="detail-subsection-title truncate">{selected.aptName}</p>
                <p className="detail-meta">
                  {[
                    selected.dong,
                    selected.householdCount ? `${selected.householdCount.toLocaleString("ko-KR")}세대` : null,
                    selected.buildYear ? `${selected.buildYear}년 준공` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedId(null)}
                aria-label="닫기"
                className="-mr-2 -mt-2 inline-flex h-11 w-11 shrink-0 items-center justify-center text-[color:var(--lab-muted)]"
              >
                <X className="h-5 w-5" aria-hidden />
              </button>
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-2">
              <div className="rounded-xl border border-[color:var(--lab-border)] px-3 py-2">
                <dt className="detail-label">
                  최근 {dealLabel}
                  {selected.pyeongLabel ? ` · ${selected.pyeongLabel}` : ""}
                </dt>
                <dd className="detail-data-value-emphasis tabular-nums">
                  {selected.priceMan ? formatEok(selected.priceMan) : "거래 없음"}
                </dd>
                <dd className="detail-meta">{selected.priceDate ? formatDealDate(selected.priceDate) : "기간 내 없음"}</dd>
              </div>
              <div className="rounded-xl border border-[color:var(--lab-border)] px-3 py-2">
                <dt className="detail-label">평당가</dt>
                <dd className="detail-data-value-emphasis tabular-nums">
                  {selected.perPyeongMan != null ? shortPerPyeong(selected.perPyeongMan) : "—"}
                </dd>
                <dd
                  className="detail-meta tabular-nums"
                  style={
                    selected.change1yPct
                      ? { color: selected.change1yPct > 0 ? "#D93A3F" : "#2F62D6" }
                      : undefined
                  }
                >
                  1년 {selected.change1yPct != null ? metricText(selected.change1yPct, "change1y") : "–"}
                </dd>
              </div>
            </dl>
            <div className="mt-3 grid grid-cols-2 gap-2">
              {selected3d ? (
                <Link href={`/complex-3d/${selected.complexId}`} className="lab-button lab-button-secondary w-full">
                  3D 단지 탐색
                </Link>
              ) : (
                <button type="button" disabled className="lab-button lab-button-secondary w-full">
                  {selected3d === false ? "3D 준비 중" : "3D 단지 탐색"}
                </button>
              )}
              <Link href={selected.href} className="lab-button lab-button-primary w-full">
                단지 상세 보기
              </Link>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

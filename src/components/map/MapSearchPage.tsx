"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Check, ChevronDown, ChevronRight, MapPin, LocateFixed, SlidersHorizontal, X } from "lucide-react";
import { LabBottomSheet } from "@/components/ui/LabBottomSheet";
import { MapConditionSheet, conditionSummary, type ConditionKey } from "@/components/map/MapConditionSheet";
import {
  isNaverMapAuthFailed,
  loadNaverMapsSdk,
  NAVER_AUTH_FAILURE_EVENT,
  NAVER_AUTH_FAILURE_MESSAGE,
  type NaverMapInstance,
  type NaverMarkerInstance,
} from "@/lib/nearby-map/naver-sdk";
import type { MapComplex, MapDealKind } from "@/lib/map/map-complexes";
import {
  EMPTY_CONDITIONS,
  activeCount,
  areaQuery,
  isFullRange,
  matches,
  rangeDefs,
  type MapConditions,
  type RangeFilterId,
} from "@/lib/map/map-filters";
import type { MapArea, MapAreaLevel } from "@/lib/map/map-areas";
import { formatDealDate, formatEok } from "@/lib/utils/format";

type Bounds = { getMin(): { y: number; x: number }; getMax(): { y: number; x: number } };
type MapWithBounds = NaverMapInstance & {
  getBounds(): Bounds;
  getCenter(): { y: number; x: number };
  getZoom(): number;
};

const DEAL_LABEL: Record<MapDealKind, string> = { trade: "매매", jeonse: "전세" };

/** 지도 위 조건 칩 순서 — 자주 쓰는 것부터 */
const CHIP_ORDER: Array<RangeFilterId | "heating"> = [
  "price",
  "area",
  "households",
  "age",
  "jeonseRatio",
  "gap",
  "rentYield",
  "far",
  "bcr",
  "parking",
  "heating",
];

/* ───────────── 지도 상태 ───────────── */

/** 처음 열 때 위치 — 마지막으로 본 곳을 기억 (브라우저에만). */
const LAST_VIEW_KEY = "apt-datalab:map-last-view:v1";
const DEFAULT_VIEW = { lat: 37.5133, lng: 127.0806, zoom: 15 }; // 잠실
/** 줌 ≥ 14 단지, 12~13 동, 9~11 구, 그 아래는 확대 안내. */
const COMPLEX_ZOOM = 14;
const DONG_ZOOM = 12;
const GU_ZOOM = 9;

type ViewLevel = "complex" | MapAreaLevel | "far";
function levelForZoom(z: number): ViewLevel {
  if (z >= COMPLEX_ZOOM) return "complex";
  if (z >= DONG_ZOOM) return "dong";
  if (z >= GU_ZOOM) return "gu";
  return "far";
}

function readLastView() {
  try {
    const raw = window.localStorage.getItem(LAST_VIEW_KEY);
    const v = raw ? JSON.parse(raw) : null;
    if (v && Number.isFinite(v.lat) && Number.isFinite(v.lng) && Number.isFinite(v.zoom)) return v;
  } catch {
    /* ignore */
  }
  return DEFAULT_VIEW;
}

function saveLastView(v: { lat: number; lng: number; zoom: number }) {
  try {
    window.localStorage.setItem(LAST_VIEW_KEY, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}

/* ───────────── 마커 HTML ───────────── */

/** 억 단위 짧은 표기: 315000 → "31.5억", 98000 → "9.8억" */
function shortEok(man: number): string {
  return `${Math.round((man / 10000) * 10) / 10}억`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const FONT = "'Noto Sans KR',system-ui,sans-serif";

/**
 * 아파트 모양 마커 — 좁은 윗동(전용㎡) 위에 넓은 몸통(가격)을 얹은 계단형 건물 실루엣 + 꼬리.
 * 거래가 없는 단지는 작은 회색 건물 아이콘.
 */
/**
 * 구 종합 랭킹 1~3위 왕관 — 순위마다 모양·색이 다르다.
 * 1위 금색 다섯 봉우리+보석 · 2위 은색 네 봉우리 · 3위 동색 세 봉우리.
 */
const CROWNS: Record<1 | 2 | 3, { fill: string; stroke: string; path: string; jewels: string }> = {
  1: {
    fill: "#F6C343",
    stroke: "#A86B00",
    path: "M2 15 L1 4 L6 8 L8.5 1.5 L12 7 L15.5 1.5 L18 8 L23 4 L22 15 Z",
    jewels: '<circle cx="12" cy="11.2" r="1.6" fill="#E5484D"/><circle cx="6.5" cy="11.6" r="1.1" fill="#fff"/><circle cx="17.5" cy="11.6" r="1.1" fill="#fff"/>',
  },
  2: {
    fill: "#D5DCE5",
    stroke: "#5B6778",
    path: "M3 15 L2 5 L7.5 9 L10 3 L14 3 L16.5 9 L22 5 L21 15 Z",
    jewels: '<circle cx="12" cy="11.4" r="1.4" fill="#4C6FFF"/>',
  },
  3: {
    fill: "#E2A26D",
    stroke: "#8A4B1C",
    path: "M4 15 L3 6 L8.5 10 L12 4 L15.5 10 L21 6 L20 15 Z",
    jewels: '<circle cx="12" cy="12" r="1.3" fill="#fff"/>',
  },
};

function crownHtml(rank: 1 | 2 | 3): string {
  const c = CROWNS[rank];
  return `<svg width="24" height="17" viewBox="0 0 24 17" aria-hidden="true" style="display:block;margin-bottom:-3px;position:relative;z-index:1;filter:drop-shadow(0 1px 1px rgba(15,23,42,.25))">
      <path d="${c.path}" fill="${c.fill}" stroke="${c.stroke}" stroke-width="1.3" stroke-linejoin="round"/>
      <path d="M2.5 13.2 H21.5" stroke="${c.stroke}" stroke-width="1" opacity=".55"/>
      ${c.jewels}
    </svg>`;
}

function complexMarkerHtml(c: MapComplex, selected: boolean, metric: MarkerMetric): string {
  if (c.priceMan == null) {
    const stroke = selected ? "var(--lab-brand-primary)" : "#94a3b8";
    return `<div style="transform:translate(-50%,-100%);cursor:pointer">
      <svg width="18" height="20" viewBox="0 0 18 20" aria-hidden="true" style="display:block;filter:drop-shadow(0 1px 1px rgba(15,23,42,.2))">
        <path d="M4 1h10v5h3v13H1V6h3z" fill="#fff" stroke="${stroke}" stroke-width="1.5" stroke-linejoin="round"/>
        <path d="M6 5h2M10 5h2M6 9h2M10 9h2M6 13h2M10 13h2" stroke="${stroke}" stroke-width="1.5"/>
      </svg></div>`;
  }
  // 평형 이름(단지 상세와 같은 "33평"), 모르면 전용㎡
  const pyeong = c.pyeongLabel ?? (c.mainAreaSqm ? `${Math.floor(c.mainAreaSqm)}㎡` : "");
  const value = markerValue(c, metric);
  const bodyBg = selected ? "var(--lab-brand-primary)" : "#fff";
  const bodyFg = selected ? "#fff" : value.color ?? "var(--lab-navy-950)";
  const edge = "var(--lab-brand-primary)";
  const top = selected ? "var(--lab-navy-950)" : edge;
  // 신고가 빨간 점 · 하락(고점 대비 −10% 이하) 파란 점
  const dot = c.move
    ? `<span style="position:absolute;top:-4px;right:-4px;width:9px;height:9px;border-radius:50%;background:${
        c.move === "singoga" ? "#E5484D" : "#3B6FE0"
      };border:1.5px solid #fff"></span>`
    : "";
  return `<div style="transform:translate(-50%,-100%);display:flex;flex-direction:column;align-items:center;cursor:pointer;filter:drop-shadow(0 1px 2px rgba(15,23,42,.22))">
    ${c.guRank ? crownHtml(c.guRank) : ""}
    ${
      pyeong
        ? `<div style="min-width:30px;padding:0 6px;height:16px;border-radius:5px 5px 0 0;background:${top};color:#fff;font:600 11px/16px ${FONT};text-align:center;white-space:nowrap">${escapeHtml(pyeong)}</div>`
        : ""
    }
    <div style="position:relative;min-width:48px;padding:2px 8px;border-radius:7px;background:${bodyBg};color:${bodyFg};border:1.5px solid ${edge};font:700 13px/18px ${FONT};font-variant-numeric:tabular-nums;text-align:center;white-space:nowrap">${escapeHtml(
      value.text,
    )}${dot}</div>
    <div style="width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;border-top:6px solid ${edge};margin-top:-1px"></div>
  </div>`;
}

/** 마커 표시 값 — 가격 · 평당가 · 전세가율 · 1년 변동 */
type MarkerMetric = "price" | "perPyeong" | "jeonseRatio" | "change1y";
// 가격: 대표 평형 최근 실거래가 · 평당가: 최근 실거래가 ÷ 평형(공급 3.3㎡)
// 전세가율: 대표 평형 최근 전세가 ÷ 최근 매매가 · 1년 변동: 최근 6개월 vs 1년 전 같은 6개월 (같은 평형, 각 2건 이상)
const MARKER_METRICS: Array<{ id: MarkerMetric; label: string }> = [
  { id: "price", label: "가격" },
  { id: "perPyeong", label: "평당가" },
  { id: "jeonseRatio", label: "전세가율" },
  { id: "change1y", label: "1년 변동" },
];
const METRIC_KEY = "apt-datalab:map-marker-metric:v1";

function readSavedMetric(): MarkerMetric | null {
  try {
    const v = window.localStorage.getItem(METRIC_KEY);
    return v && MARKER_METRICS.some((m) => m.id === v) ? (v as MarkerMetric) : null;
  } catch {
    return null;
  }
}

function markerValue(c: MapComplex, metric: MarkerMetric): { text: string; color?: string } {
  const none = { text: "–", color: "#94a3b8" };
  if (metric === "perPyeong") return c.perPyeongMan != null ? { text: shortPerPyeong(c.perPyeongMan) } : none;
  if (metric === "jeonseRatio") return c.jeonseRatioPct != null ? { text: `${Math.round(c.jeonseRatioPct)}%` } : none;
  if (metric === "change1y") {
    const v = c.change1yPct;
    if (v == null) return none;
    if (v === 0) return { text: "0%" };
    return { text: `${v > 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}%`, color: v > 0 ? "#D93A3F" : "#2F62D6" };
  }
  return { text: shortEok(c.priceMan!) };
}

/** 평당가 짧은 표기: 13059 → "1.31억", 6465 → "6,465만" */
function shortPerPyeong(man: number): string {
  return man >= 10_000 ? `${(man / 10_000).toFixed(2)}억` : `${man.toLocaleString("ko-KR")}만`;
}

/** "성남시 분당구" → "분당구" (말풍선은 짧게). */
function areaShortName(a: MapArea): string {
  return a.name.split(/\s+/).pop() || a.name;
}

function areaLabel(a: MapArea): { name: string; price: string } {
  return {
    name: areaShortName(a),
    price: a.medianPerPyeongMan != null ? shortPerPyeong(a.medianPerPyeongMan) : "거래 없음",
  };
}

/** 지역(구·동) 말풍선 — 이름 + 최근 12개월 전용 평당가(중위, 짧은 표기). 누르면 확대. */
function areaMarkerHtml(a: MapArea): string {
  const { name, price } = areaLabel(a);
  return `<div style="transform:translate(-50%,-50%);display:flex;flex-direction:column;align-items:center;justify-content:center;min-width:56px;padding:3px 8px;border-radius:10px;background:var(--lab-navy-950);color:#fff;cursor:pointer;box-shadow:0 2px 6px rgba(15,23,42,.25);text-align:center;white-space:nowrap">
    <span style="font:600 12px/16px ${FONT}">${escapeHtml(name)}</span>
    <span style="font:700 13px/17px ${FONT};font-variant-numeric:tabular-nums;color:${
      a.medianPerPyeongMan != null ? "#5eead4" : "#cbd5e1"
    }">${escapeHtml(price)}</span>
  </div>`;
}

/* ───────────── 컴포넌트 ───────────── */

export function MapSearchPage() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapWithBounds | null>(null);
  const markersRef = useRef<Map<string, NaverMarkerInstance>>(new Map());
  const abortRef = useRef<AbortController | null>(null);
  const [conditions, setConditions] = useState<MapConditions>(EMPTY_CONDITIONS);
  const [sheetOpen, setSheetOpen] = useState(false);
  /** null = 전체 조건 시트, 값이 있으면 그 조건 하나만 */
  const [sheetOnly, setSheetOnly] = useState<ConditionKey | null>(null);
  const [level, setLevel] = useState<ViewLevel>("complex");
  const [complexes, setComplexes] = useState<MapComplex[]>([]);
  const [areas, setAreas] = useState<MapArea[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  /** 마커에 보일 값 — 브라우저에 기억 */
  const [metric, setMetric] = useState<MarkerMetric>("price");
  const [metricOpen, setMetricOpen] = useState(false);
  const chooseMetric = (m: MarkerMetric) => {
    setMetric(m);
    setMetricOpen(false);
    try {
      window.localStorage.setItem(METRIC_KEY, m);
    } catch {}
  };
  /** Read by the map idle listener, which is registered once. */
  const condRef = useRef(conditions);
  /** Bumped on every map idle so marker culling follows zoom even when data is unchanged. */
  const [cullTick, setCullTick] = useState(0);
  /** 지도 가운데 (idle마다 갱신) — 구·동 상세 이동 버튼용 */
  const [center, setCenter] = useState<{ lat: number; lng: number } | null>(null);

  const fetchViewport = useCallback(async () => {
    const map = mapRef.current;
    if (!map) return;
    const zoom = map.getZoom();
    const c = map.getCenter();
    saveLastView({ lat: c.y, lng: c.x, zoom });
    const lv = levelForZoom(zoom);
    setLevel(lv);
    abortRef.current?.abort();
    if (lv === "far") {
      setComplexes([]);
      setAreas([]);
      setState("ready");
      return;
    }
    const b = map.getBounds();
    const sw = b.getMin();
    const ne = b.getMax();
    const ac = new AbortController();
    abortRef.current = ac;
    const { deal } = condRef.current;
    const area = areaQuery(condRef.current);
    const qs = new URLSearchParams({
      swLat: sw.y.toFixed(4),
      swLng: sw.x.toFixed(4),
      neLat: ne.y.toFixed(4),
      neLng: ne.x.toFixed(4),
      areaMin: String(area.min),
      areaMax: String(area.max),
      deal,
    });
    if (lv !== "complex") qs.set("level", lv);
    setState("loading");
    try {
      const res = await fetch(`/api/map/${lv === "complex" ? "complexes" : "areas"}?${qs}`, {
        signal: ac.signal,
      });
      const data = (await res.json()) as {
        status: string;
        complexes?: MapComplex[];
        areas?: MapArea[];
        truncated?: boolean;
      };
      if (data.status === "zoom_in") {
        setComplexes([]);
        setAreas([]);
        setState("ready");
        return;
      }
      if (data.status !== "ok") throw new Error(data.status);
      if (lv === "complex") {
        setComplexes(data.complexes ?? []);
        setAreas([]);
        setTruncated(Boolean(data.truncated));
      } else {
        setAreas(data.areas ?? []);
        setComplexes([]);
        setTruncated(false);
      }
      setState("ready");
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setState("error");
      setError("지도 정보를 불러오지 못했습니다.");
    }
  }, []);

  // Map init + idle → fetch.
  useEffect(() => {
    let cancelled = false;
    let idleTimer: number | undefined;
    (async () => {
      const loaded = await loadNaverMapsSdk();
      if (cancelled) return;
      if (!loaded.ok || !hostRef.current || isNaverMapAuthFailed()) {
        setState("error");
        setError(loaded.ok ? NAVER_AUTH_FAILURE_MESSAGE : loaded.reason);
        return;
      }
      const maps = loaded.naver.maps;
      const view = readLastView();
      const savedMetric = readSavedMetric();
      if (savedMetric) setMetric(savedMetric);
      try {
        const map = new maps.Map(hostRef.current, {
          center: new maps.LatLng(view.lat, view.lng),
          zoom: view.zoom,
          minZoom: 7,
          zoomControl: false,
          scaleControl: false,
          mapDataControl: false,
        }) as MapWithBounds;
        mapRef.current = map;
        setCenter({ lat: view.lat, lng: view.lng });
        maps.Event.addListener(map, "idle", () => {
          window.clearTimeout(idleTimer);
          idleTimer = window.setTimeout(() => {
            setCullTick((t) => t + 1);
            const c = map.getCenter();
            setCenter({ lat: c.y, lng: c.x });
            void fetchViewport();
          }, 250);
        });
        maps.Event.addListener(map, "click", () => setSelectedId(null));
        void fetchViewport();
      } catch {
        setState("error");
        setError("지도를 표시할 수 없습니다.");
      }
    })();
    const onAuth = () => {
      setState("error");
      setError(NAVER_AUTH_FAILURE_MESSAGE);
    };
    window.addEventListener(NAVER_AUTH_FAILURE_EVENT, onAuth);
    const markers = markersRef.current;
    return () => {
      cancelled = true;
      window.clearTimeout(idleTimer);
      window.removeEventListener(NAVER_AUTH_FAILURE_EVENT, onAuth);
      abortRef.current?.abort();
      for (const m of markers.values()) m.setMap(null);
      markers.clear();
      try {
        mapRef.current?.destroy?.();
      } catch {
        /* ignore */
      }
      mapRef.current = null;
    };
  }, [fetchViewport]);

  // 거래유형·전용면적이 바뀌면 서버 값(대표 평형·최근가)이 달라지므로 다시 불러온다. 나머지 조건은 화면에서 거른다.
  const areaKey = `${areaQuery(conditions).min}-${areaQuery(conditions).max}`;
  useEffect(() => {
    condRef.current = conditions;
  }, [conditions]);
  useEffect(() => {
    // 슬라이더를 끄는 동안 연달아 부르지 않게 잠깐 기다린다.
    const t = window.setTimeout(() => void fetchViewport(), 350);
    return () => window.clearTimeout(t);
  }, [conditions.deal, areaKey, fetchViewport]);

  const visibleComplexes = useMemo(
    () => complexes.filter((c) => matches(c, conditions)),
    [complexes, conditions],
  );

  // Sync markers (diff by id). Complex and area markers share the map, keyed by prefix.
  useEffect(() => {
    const map = mapRef.current;
    const maps = window.naver?.maps;
    if (!map || !maps) return;
    const markers = markersRef.current;
    type Box = { x0: number; y0: number; x1: number; y1: number };
    type Spec = {
      id: string;
      lat: number;
      lng: number;
      html: string;
      z: number;
      priority: number;
      title: string;
      box: (p: { x: number; y: number }) => Box;
      onClick: () => void;
    };
    const specs: Spec[] = [
      ...visibleComplexes.map((c) => {
        const selected = c.complexId === selectedId;
        return {
          id: `c:${c.complexId}`,
          lat: c.lat,
          lng: c.lng,
          html: complexMarkerHtml(c, selected, metric),
          z: selected ? 1000 : c.guRank ? 200 + (4 - c.guRank) : c.priceMan != null ? 100 : 10,
          priority: c.householdCount ?? 0,
          title: c.aptName,
          // 꼬리 끝이 좌표 — 박스는 그 위쪽. 가격 없는 단지 아이콘은 작다.
          box: (p: { x: number; y: number }): Box =>
            c.priceMan != null
              ? { x0: p.x - 28, x1: p.x + 28, y0: p.y - (c.mainAreaSqm ? 44 : 28) - (c.guRank ? 14 : 0), y1: p.y }
              : { x0: p.x - 9, x1: p.x + 9, y0: p.y - 20, y1: p.y },
          onClick: () => setSelectedId(c.complexId),
        };
      }),
      ...areas.map((a) => ({
        id: `a:${a.id}`,
        lat: a.lat,
        lng: a.lng,
        html: areaMarkerHtml(a),
        z: 50,
        priority: a.complexCount,
        title: a.name,
        box: (p: { x: number; y: number }): Box => {
          const { name, price } = areaLabel(a);
          const half = Math.max(28, Math.max(name.length * 12, price.length * 8) / 2 + 8);
          return { x0: p.x - half, x1: p.x + half, y0: p.y - 19, y1: p.y + 19 };
        },
        onClick: () => {
          const m = mapRef.current;
          if (!m) return;
          m.morph?.(new maps.LatLng(a.lat, a.lng), a.level === "gu" ? DONG_ZOOM + 1 : COMPLEX_ZOOM + 1);
        },
      })),
    ];
    // 겹치는 마커는 우선순위(선택 > 세대수·단지 수) 높은 쪽만 남긴다 — 화면 좌표 기준 사각형 충돌.
    const proj = (map as unknown as {
      getProjection?: () => { fromCoordToOffset(c: unknown): { x: number; y: number } };
    }).getProjection?.();
    const kept: Box[] = [];
    const placed = proj
      ? [...specs]
          .sort((a, b) => b.z - a.z || b.priority - a.priority)
          .filter((s) => {
            const box = s.box(proj.fromCoordToOffset(new maps.LatLng(s.lat, s.lng)));
            if (s.z < 1000 && kept.some((k) => box.x0 < k.x1 && box.x1 > k.x0 && box.y0 < k.y1 && box.y1 > k.y0)) {
              return false;
            }
            kept.push(box);
            return true;
          })
      : specs;
    const next = new Set(placed.map((s) => s.id));
    for (const [id, m] of markers) {
      if (!next.has(id)) {
        m.setMap(null);
        markers.delete(id);
      }
    }
    for (const s of placed) {
      const icon = { content: s.html, anchor: new maps.Point(0, 0) };
      const existing = markers.get(s.id);
      if (existing) {
        existing.setIcon?.(icon);
        existing.setZIndex?.(s.z);
        continue;
      }
      const marker = new maps.Marker({
        position: new maps.LatLng(s.lat, s.lng),
        map,
        icon,
        title: s.title,
        zIndex: s.z,
      });
      maps.Event.addListener(marker, "click", s.onClick);
      markers.set(s.id, marker);
    }
  }, [visibleComplexes, areas, selectedId, cullTick, metric]);

  const selected = visibleComplexes.find((c) => c.complexId === selectedId) ?? null;

  // 화면 가운데 지역 → 상세 이동 버튼 하나. 동 말풍선 단계는 구(지역 페이지), 단지 단계는 동 상세.
  // 버튼이 가리키는 구·동은 지도에 단지 범위 다각형으로 표시한다.
  const centerLink = useMemo(() => {
    if (!center) return null;
    const c = { y: center.lat, x: center.lng };
    const near = <T extends { lat: number; lng: number }>(list: T[]): T | null =>
      list.reduce<T | null>((best, p) => {
        const d = (p.lat - c.y) ** 2 + ((p.lng - c.x) * 0.8) ** 2;
        const bd = best ? (best.lat - c.y) ** 2 + ((best.lng - c.x) * 0.8) ** 2 : Infinity;
        return d < bd ? p : best;
      }, null);
    const hit = level === "dong" ? near(areas) : level === "complex" ? near(complexes) : null;
    if (!hit) return null;
    const { links } = hit;
    if (level === "dong") {
      return { label: `${links.guLabel} 상세 보기`, href: links.guHref, lawd: links.lawdCd, dong: null };
    }
    return links.dongHref
      ? { label: `${links.dongLabel} 상세 보기`, href: links.dongHref, lawd: links.lawdCd, dong: links.dongLabel }
      : null;
  }, [level, areas, complexes, center]);

  // 지역 표시 — 버튼 대상이 바뀔 때만 다시 그린다. 행정경계는 실선, 경계가 없어 단지 범위로 대신하면 점선.
  const shapeKey = centerLink && !selectedId ? `${centerLink.lawd}|${centerLink.dong ?? ""}` : null;
  type Shape = { source: "boundary" | "hull"; paths: Array<Array<{ lat: number; lng: number }>> };
  const shapeCache = useRef(new Map<string, Shape>());
  useEffect(() => {
    const map = mapRef.current;
    const maps = window.naver?.maps;
    if (!shapeKey || !map || !maps?.Polygon) return;
    let polygon: { setMap: (m: null) => void } | null = null;
    let cancelled = false;
    const draw = (shape: Shape) => {
      const paths = shape.paths.filter((p) => p.length >= 3);
      if (cancelled || !paths.length || !maps.Polygon) return;
      const boundary = shape.source === "boundary";
      polygon = new maps.Polygon({
        map,
        paths: paths.map((path) => path.map((p) => new maps.LatLng(p.lat, p.lng))),
        fillColor: "#0E9AA0",
        fillOpacity: boundary ? 0.06 : 0.08,
        strokeColor: "#0E9AA0",
        strokeOpacity: boundary ? 0.85 : 0.7,
        strokeWeight: 2,
        strokeStyle: boundary ? "solid" : "shortdash",
        clickable: false,
        zIndex: 1,
      });
    };
    const cached = shapeCache.current.get(shapeKey);
    if (cached) draw(cached);
    else {
      const [lawd, dong] = shapeKey.split("|");
      const qs = new URLSearchParams({ lawd: lawd! });
      if (dong) qs.set("dong", dong);
      fetch(`/api/map/region-shape?${qs}`)
        .then((r) => r.json())
        .then((d: Partial<Shape>) => {
          const shape: Shape = { source: d.source ?? "hull", paths: d.paths ?? [] };
          shapeCache.current.set(shapeKey, shape);
          draw(shape);
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
      polygon?.setMap(null);
    };
  }, [shapeKey]);
  const priced = visibleComplexes.filter((c) => c.priceMan != null).length;
  const dealLabel = DEAL_LABEL[conditions.deal];
  const nActive = activeCount(conditions);
  const chipDefs = rangeDefs(conditions.deal);
  const area = areaQuery(conditions);
  const areaRangeText = area.max < 10_000 || area.min > 0
    ? ` · 전용 ${area.min > 0 ? `${area.min}` : ""}~${area.max < 10_000 ? `${Math.floor(area.max)}` : ""}㎡`
    : "";

  const statusText = (() => {
    if (level === "far") return null;
    if (level === "complex") {
      const filtered = nActive > 0 ? ` · 조건 맞는 ${visibleComplexes.length}개 단지` : ` · 가격 있는 ${priced}개 단지`;
      const what =
        metric === "perPyeong"
          ? `대표 평형 최근 ${dealLabel} 평당가`
          : metric === "jeonseRatio"
            ? "대표 평형 전세가율"
            : metric === "change1y"
              ? `대표 평형 ${dealLabel} 1년 변동`
              : `대표 평형 최근 ${dealLabel}가`;
      return `${what}${areaRangeText}${state === "ready" ? filtered : ""}${truncated ? " · 세대수 큰 400개 단지까지" : ""}`;
    }
    return `최근 12개월 ${dealLabel}${areaRangeText} · ${level === "gu" ? "구" : "동"}별 전용 평당가`;
  })();

  const locate = () => {
    if (!navigator.geolocation || !mapRef.current || !window.naver?.maps) return;
    navigator.geolocation.getCurrentPosition((pos) => {
      const maps = window.naver!.maps;
      mapRef.current?.morph?.(new maps.LatLng(pos.coords.latitude, pos.coords.longitude), 15);
    });
  };

  const updateConditions = (next: MapConditions) => {
    setSelectedId(null);
    setConditions(next);
  };

  return (
    <div className="relative w-full" style={{ height: "calc(100dvh - var(--site-header-height, 56px))" }}>
      {/* h-full, not absolute inset-0: the NAVER SDK forces position:relative on its host. */}
      <div ref={hostRef} className="isolate h-full w-full" role="application" aria-label="단지 가격 지도" />

      {/* 상단: 거래유형 · 조건 · 레시피 + 상태 */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-col gap-2 pt-2 sm:pt-3">
        <div
          className="pointer-events-auto flex items-center gap-1.5 overflow-x-auto overflow-y-hidden overscroll-x-contain px-3 py-1 sm:px-4"
          style={{ scrollbarWidth: "none" }}
          role="toolbar"
          aria-label="지도 조건"
        >
          <div className="inline-flex h-9 shrink-0 rounded-full border border-[color:var(--lab-navy-950)] bg-[color:var(--lab-surface)] p-0.5 shadow-sm" role="group" aria-label="거래 유형">
            {(["trade", "jeonse"] as const).map((d) => (
              <button
                key={d}
                type="button"
                aria-pressed={conditions.deal === d}
                onClick={() => {
                  if (conditions.deal === d) return;
                  // 가격 구간은 거래유형마다 다르므로 바꿀 때 뺀다
                  const ranges = { ...conditions.ranges };
                  delete ranges.price;
                  updateConditions({ ...conditions, deal: d, ranges });
                }}
                className={`relative rounded-full px-3.5 text-[14px] leading-5 transition-colors before:absolute before:inset-x-0 before:-inset-y-1.5 before:content-[''] ${
                  conditions.deal === d
                    ? "bg-[color:var(--lab-navy-950)] font-semibold text-white"
                    : "font-medium text-[color:var(--lab-navy-950)]"
                }`}
              >
                {DEAL_LABEL[d]}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => {
              setSheetOnly(null);
              setSheetOpen(true);
            }}
            aria-haspopup="dialog"
            className={`relative inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3.5 text-[14px] leading-5 shadow-sm before:absolute before:inset-x-0 before:-inset-y-1 before:content-[''] ${
              nActive > 0
                ? "border-[color:var(--lab-brand-primary)] bg-[color:var(--lab-surface)] font-semibold text-[color:var(--lab-teal-700)]"
                : "border-[color:var(--lab-border)] bg-[color:var(--lab-surface)] font-medium text-[color:var(--lab-navy-950)]"
            }`}
          >
            <SlidersHorizontal className="h-4 w-4" aria-hidden />
            조건
            {nActive > 0 ? (
              <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-[color:var(--lab-brand-primary)] px-1 text-[12px] font-semibold leading-none text-white tabular-nums">
                {nActive}
              </span>
            ) : null}
          </button>
          {CHIP_ORDER.map((key) => {
            const def = key === "heating" ? null : chipDefs.find((d) => d.id === key)!;
            const on = def ? !isFullRange(def, conditions.ranges[def.id]) : conditions.heating.length > 0;
            const label = def
              ? on
                ? `${def.label} ${conditionSummary(def, conditions.ranges[def.id])}`
                : def.label
              : on
                ? `${conditions.heating.join("·")}난방`
                : "난방";
            return (
              <button
                key={key}
                type="button"
                aria-haspopup="dialog"
                onClick={() => {
                  setSheetOnly(key);
                  setSheetOpen(true);
                }}
                className={`relative inline-flex h-9 shrink-0 items-center gap-0.5 whitespace-nowrap rounded-full border px-3 text-[14px] leading-5 shadow-sm before:absolute before:inset-x-0 before:-inset-y-1 before:content-[''] ${
                  on
                    ? "border-[color:var(--lab-brand-primary)] bg-[color:var(--lab-brand-subtle)] font-semibold text-[color:var(--lab-teal-700)]"
                    : "border-[color:var(--lab-border)] bg-[color:var(--lab-surface)] font-medium text-[color:var(--lab-navy-950)]"
                }`}
              >
                {label}
                <ChevronDown className="h-4 w-4 opacity-60" aria-hidden />
              </button>
            );
          })}
        </div>
        <div className="flex flex-col items-start gap-2 px-3 sm:px-4">
          {level === "complex" ? (
            // 마커에 보일 값 — 조건(필터)이 아니라 보기 방식이라 칩 줄과 따로 둔다
            <button
              type="button"
              aria-haspopup="dialog"
              onClick={() => setMetricOpen(true)}
              className="pointer-events-auto relative -mt-0.5 inline-flex h-8 items-center gap-1 whitespace-nowrap rounded-full border border-[color:var(--lab-navy-950)] bg-[color:var(--lab-surface)] pl-2.5 pr-2 text-[13px] font-semibold leading-5 text-[color:var(--lab-navy-950)] shadow-sm before:absolute before:inset-x-0 before:-inset-y-1.5 before:content-['']"
            >
              <MapPin className="h-4 w-4" aria-hidden />
              마커 표시: {MARKER_METRICS.find((m) => m.id === metric)!.label}
              <ChevronDown className="h-4 w-4 opacity-60" aria-hidden />
            </button>
          ) : null}
          {statusText ? (
            <p className="pointer-events-auto rounded-lg bg-[color:var(--lab-surface)]/95 px-2.5 py-1 text-[13px] leading-5 text-[color:var(--lab-muted)] shadow-sm">
              {statusText}
              {state === "loading" ? " · 불러오는 중…" : ""}
            </p>
          ) : null}
          {level !== "complex" && level !== "far" && nActive > (area.min > 0 || area.max < 10_000 ? 1 : 0) ? (
            <p className="pointer-events-auto rounded-lg bg-[color:var(--lab-surface)]/95 px-2.5 py-1 text-[13px] leading-5 text-[color:var(--lab-muted)] shadow-sm">
              면적 외 조건은 단지가 보이는 거리에서 적용돼요
            </p>
          ) : null}
          {level === "far" ? (
            <p className="pointer-events-auto rounded-lg bg-[color:var(--lab-navy-950)] px-3 py-2 text-[13px] font-medium text-white shadow">
              지도를 확대하면 지역별 시세가 보여요
            </p>
          ) : null}
          {state === "error" && error ? (
            <p className="lab-state lab-state-error pointer-events-auto !min-h-0 max-w-md">{error}</p>
          ) : null}
        </div>
      </div>

      <button
        type="button"
        onClick={locate}
        aria-label="내 위치로 이동"
        className="absolute right-3 bottom-[calc(env(safe-area-inset-bottom)+84px)] inline-flex h-11 w-11 items-center justify-center rounded-full border border-[color:var(--lab-border)] bg-[color:var(--lab-surface)] text-[color:var(--lab-navy-950)] shadow-sm sm:right-4 sm:bottom-[calc(env(safe-area-inset-bottom)+16px)]"
        style={selected ? { bottom: "calc(env(safe-area-inset-bottom) + 284px)" } : undefined}
      >
        <LocateFixed className="h-5 w-5" aria-hidden />
      </button>

      {/* 하단 가운데: 화면 가운데 구·동 상세로 이동 */}
      {centerLink && !selected ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+84px)] flex justify-center px-16 sm:bottom-[calc(env(safe-area-inset-bottom)+16px)]">
          <Link
            href={centerLink.href}
            className="pointer-events-auto inline-flex h-11 min-w-0 items-center gap-0.5 rounded-full bg-[color:var(--lab-navy-950)] pl-4 pr-2.5 text-[14px] font-semibold leading-5 text-white shadow-lg"
          >
            <span className="truncate">{centerLink.label}</span>
            <ChevronRight className="h-4 w-4 shrink-0" aria-hidden />
          </Link>
        </div>
      ) : null}

      {/* 하단: 선택 단지 카드 */}
      {selected ? (
        <div className="absolute inset-x-0 bottom-0 px-4 pb-[calc(env(safe-area-inset-bottom)+76px)] sm:p-4 sm:pb-4">
          <div className="mx-auto w-full max-w-md rounded-2xl border border-[color:var(--lab-border)] bg-[color:var(--lab-surface)] p-4 shadow-lg">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="detail-subsection-title flex min-w-0 items-center gap-1.5">
                  <span className="truncate">{selected.aptName}</span>
                  {selected.guRank ? (
                    <span
                      className="shrink-0 rounded px-1.5 text-[12px] font-semibold leading-5"
                      style={{
                        color: CROWNS[selected.guRank].stroke,
                        background: `color-mix(in srgb, ${CROWNS[selected.guRank].fill} 35%, white)`,
                      }}
                    >
                      {selected.guName ? `${selected.guName} ` : ""}
                      {selected.guRank}위
                    </span>
                  ) : null}
                </p>
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
                  {selected.pyeongLabel
                    ? ` · ${selected.pyeongLabel}`
                    : selected.mainAreaSqm
                      ? ` · ${Math.floor(selected.mainAreaSqm)}㎡`
                      : ""}
                </dt>
                <dd className="detail-data-value-emphasis tabular-nums">
                  {selected.priceMan ? formatEok(selected.priceMan) : "거래 없음"}
                </dd>
                <dd className="detail-meta">
                  {selected.priceDate ? formatDealDate(selected.priceDate) : "기간 내 없음"}
                  {selected.move ? (
                    <span className={`ml-1 whitespace-nowrap font-semibold ${selected.move === "singoga" ? "text-[#D93A3F]" : "text-[#2F62D6]"}`}>
                      {selected.move === "singoga" ? "신고가" : "하락"}
                    </span>
                  ) : null}
                </dd>
              </div>
              <div className="rounded-xl border border-[color:var(--lab-border)] px-3 py-2">
                <dt className="detail-label">최근 12개월</dt>
                <dd className="detail-data-value-emphasis tabular-nums">
                  {selected.rangeMinMan != null && selected.rangeMaxMan != null
                    ? selected.rangeMinMan === selected.rangeMaxMan
                      ? formatEok(selected.rangeMinMan)
                      : `${shortEok(selected.rangeMinMan)}~${shortEok(selected.rangeMaxMan)}`
                    : "—"}
                </dd>
                <dd className="detail-meta">{selected.tradeCount12m}건 거래</dd>
              </div>
            </dl>
            {selected.jeonseRatioPct != null || selected.rentYieldPct != null || selected.change1yPct != null ? (
              <dl className="mt-2 grid grid-cols-4 gap-1 text-center">
                {(
                  [
                    ["전세가율", selected.jeonseRatioPct != null ? `${selected.jeonseRatioPct}%` : null, null],
                    [
                      "갭",
                      selected.gapMan != null
                        ? `${selected.gapMan < 0 ? "−" : ""}${shortEok(Math.abs(selected.gapMan))}`
                        : null,
                      null,
                    ],
                    ["월세수익률", selected.rentYieldPct != null ? `${selected.rentYieldPct}%` : null, null],
                    [
                      "1년 변동",
                      selected.change1yPct != null
                        ? `${selected.change1yPct > 0 ? "+" : selected.change1yPct < 0 ? "−" : ""}${Math.abs(selected.change1yPct).toFixed(1)}%`
                        : null,
                      selected.change1yPct == null || selected.change1yPct === 0
                        ? null
                        : selected.change1yPct > 0
                          ? "#D93A3F"
                          : "#2F62D6",
                    ],
                  ] as Array<[string, string | null, string | null]>
                ).map(([label, value, color]) => (
                  <div key={label} className="min-w-0">
                    <dt className="whitespace-nowrap text-[12px] leading-4 text-[color:var(--lab-muted)]">{label}</dt>
                    <dd
                      className="whitespace-nowrap text-[15px] font-semibold leading-5 tabular-nums text-[color:var(--lab-navy-950)]"
                      style={color ? { color } : undefined}
                    >
                      {value ?? "–"}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : null}
            <div className="mt-3 grid grid-cols-2 gap-2">
              <Link href={`/complex-3d/${selected.complexId}`} className="lab-button lab-button-secondary w-full">
                3D로 보기
              </Link>
              <Link href={selected.href} className="lab-button lab-button-primary w-full">
                단지 상세 보기
              </Link>
            </div>
          </div>
        </div>
      ) : null}

      <LabBottomSheet open={metricOpen} onClose={() => setMetricOpen(false)} title="마커 표시" hideDone>
        <ul className="flex flex-col" role="radiogroup" aria-label="마커 표시">
          {MARKER_METRICS.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                role="radio"
                aria-checked={metric === m.id}
                onClick={() => chooseMetric(m.id)}
                className="flex min-h-12 w-full items-center justify-between gap-3 border-b border-[color:var(--lab-border)] py-2 text-left last:border-b-0"
              >
                <span className={`min-w-0 text-[16px] leading-6 ${metric === m.id ? "font-semibold text-[color:var(--lab-teal-700)]" : "font-medium text-[color:var(--lab-navy-950)]"}`}>
                  {m.label}
                </span>
                {metric === m.id ? <Check className="h-5 w-5 shrink-0 text-[color:var(--lab-brand-primary)]" aria-hidden /> : null}
              </button>
            </li>
          ))}
        </ul>
        <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] leading-5 text-[color:var(--lab-muted)]">
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-[#E5484D]" aria-hidden />
            최근 거래가 신고가
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-[#3B6FE0]" aria-hidden />
            고점 대비 10% 넘게 하락
          </span>
        </p>
      </LabBottomSheet>

      <MapConditionSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        only={sheetOnly}
        conditions={conditions}
        onChange={updateConditions}
        complexes={complexes}
      />
    </div>
  );
}

"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import dynamic from "next/dynamic";
import { Check, ChevronDown, ChevronRight, Construction, MapPin, LocateFixed, SlidersHorizontal, X } from "lucide-react";
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
  complexMarkerHtml,
  CROWNS,
  escapeHtml,
  FONT,
  MARKER_METRICS,
  markerValue,
  shortPerPyeong,
  type MarkerMetric,
} from "@/components/map/complex-marker";
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
import { REDEV_STAGES, type RedevZoneShape } from "@/lib/redev/read";
import { formatDealDate, formatEok } from "@/lib/utils/format";
import { LabIndeterminateBar } from "@/components/ui/LabLoading";
import type { Map3dView } from "@/components/map3d/Seoul3DMap";
import { MapViewSwitch } from "@/components/map/MapViewSwitch";
import { setMapCardOpen } from "@/lib/map/map-dock";
import { displayAptName } from "@/lib/apt/display-name";
import { ComplexCardMore } from "@/components/map/ComplexCardMore";
import { MapBriefingSheet, type BriefingTarget, type BriefingView } from "@/components/map/MapBriefingSheet";
import { Map3dInvite, mark3dInviteDone, read3dInviteDone } from "@/components/map/Map3dInvite";
import { SEOUL_BOUNDS } from "@/components/map3d/seoul-3d-style";
import { clear3dSession, read3dSession, replaceViewParam, shouldJump } from "@/lib/map/view-state";

/** 서울 3D 지도 — MapLibre(약 1MB)는 3D를 열 때만 받는다 (2D 번들에 넣지 않음). */
const Seoul3DMap = dynamic(() => import("@/components/map3d/Seoul3DMap"), {
  ssr: false,
  loading: () => (
    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2.5 bg-[#f4f5f2]" aria-busy="true">
      <LabIndeterminateBar className="max-w-[180px]" />
      <p className="detail-meta">3D 지도 불러오는 중…</p>
    </div>
  ),
});

type Bounds = { getMin(): { y: number; x: number }; getMax(): { y: number; x: number } };
type MapWithBounds = NaverMapInstance & {
  getBounds(): Bounds;
  getCenter(): { y: number; x: number };
  getZoom(): number;
  getProjection(): {
    fromCoordToOffset(c: unknown): { x: number; y: number };
    fromOffsetToCoord(p: unknown): unknown;
  };
  panTo(c: unknown): void;
};

const DEAL_LABEL: Record<MapDealKind, string> = { trade: "매매", jeonse: "전세" };

/** 2D에서 고른 단지를 가운데로 옮길 때 위·아래 가림 (px, 모바일 기준) */
const CONTROLS_SPACE_PX = 110;
const CARD_SPACE_PX = 175;

/** 지도 높이 — 모바일은 상단바가 없어 화면 전체, PC는 상단바 아래 */
const MAP_HEIGHT_CLASS = "h-dvh sm:h-[calc(100dvh-var(--site-header-height,56px))]";

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

function inSeoul(v: { lat: number; lng: number }): boolean {
  const b = SEOUL_BOUNDS;
  return v.lat >= b.south && v.lat <= b.north && v.lng >= b.west && v.lng <= b.east;
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
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

/** 화면에 예시 단지가 없을 때 미리보기 모양만 보여줄 값 */
const SAMPLE_TEXT: Record<MarkerMetric, string> = { price: "12.5억", perPyeong: "3,800만", jeonseRatio: "55%", change1y: "+3.0%" };
const METRIC_KEY = "apt-datalab:map-marker-metric:v1";

function readSavedMetric(): MarkerMetric | null {
  try {
    const v = window.localStorage.getItem(METRIC_KEY);
    return v && MARKER_METRICS.some((m) => m.id === v) ? (v as MarkerMetric) : null;
  } catch {
    return null;
  }
}

/** "성남시 분당구" → "분당구" (말풍선은 짧게). */
function areaShortName(a: MapArea): string {
  return a.name.split(/\s+/).pop() || a.name;
}

function areaLabel(a: MapArea): { name: string; price: string } {
  return {
    name: areaShortName(a),
    price: a.perPyeongMan != null ? shortPerPyeong(a.perPyeongMan) : "거래 없음",
  };
}

/** 지역(구·동) 말풍선 — 이름 + 최근 12개월 전용 평당가(중위, 짧은 표기). 누르면 확대. */
function areaMarkerHtml(a: MapArea): string {
  const { name, price } = areaLabel(a);
  return `<div style="transform:translate(-50%,-50%);display:flex;flex-direction:column;align-items:center;justify-content:center;min-width:56px;padding:3px 8px;border-radius:10px;background:var(--lab-navy-950);color:#fff;cursor:pointer;box-shadow:0 2px 6px rgba(15,23,42,.25);text-align:center;white-space:nowrap">
    <span style="font:600 12px/16px ${FONT}">${escapeHtml(name)}</span>
    <span style="font:700 13px/17px ${FONT};font-variant-numeric:tabular-nums;color:${
      a.perPyeongMan != null ? "#5eead4" : "#cbd5e1"
    }">${escapeHtml(price)}</span>
  </div>`;
}

/** 정비구역 색 — 재건축 보라 · 재개발 주황 · 사업 단계 정보가 없는 구역 회색 */
function zoneColor(z: RedevZoneShape): string {
  if (!z.project) return "#64748B";
  return z.project.kind === "재건축" ? "#7C3AED" : z.project.kind === "재개발" ? "#EA580C" : "#0E7490";
}

/* ───────────── 컴포넌트 ───────────── */

/**
 * 지도 첫 화면(/)과 /map. 보기 방식은 주소 `?view=3d` 로 — 첫 화면부터 3D면 2D를 거치지 않고 바로 3D.
 * useSearchParams 는 미리 그린 페이지에서 Suspense 경계가 필요하다 (그동안 빈 지도 틀).
 */
export function MapSearchPage({ satelliteKey = null }: { satelliteKey?: string | null } = {}) {
  return (
    <Suspense
      fallback={
        <div className={`relative w-full bg-[#f4f5f2] ${MAP_HEIGHT_CLASS}`} aria-busy="true" />
      }
    >
      <MapSearchPageInner satelliteKey={satelliteKey} />
    </Suspense>
  );
}

function MapSearchPageInner({ satelliteKey }: { satelliteKey: string | null }) {
  const searchParams = useSearchParams();
  const pathname = usePathname() || "/";
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
  /** 3D 지도로 볼 때 시작 위치 (null = 2D) */
  const [view3d, setView3d] = useState<Map3dView | null>(() => {
    if (searchParams.get("view") !== "3d") return null;
    // 3D 단지 탐색·단지 상세에서 뒤로 왔으면 그때 카메라, 아니면 마지막으로 본 곳
    const saved = read3dSession(pathname);
    if (saved) return { lat: saved.lat, lng: saved.lng, zoom: saved.zoom, pitch: saved.pitch, bearing: saved.bearing };
    const v = readLastView();
    return { lat: v.lat, lng: v.lng, zoom: Math.max(v.zoom, COMPLEX_ZOOM) - 1 };
  });
  /** 3D 지도를 열 때 고른 단지 — 뒤로 와서 되살린 것(카메라 그대로) 또는 2D에서 고른 것(새로 담기) */
  const [initial3dSel, setInitial3dSel] = useState<{ id: string | null; frame: boolean }>(() => ({
    id: searchParams.get("view") === "3d" ? (read3dSession(pathname)?.selectedId ?? null) : null,
    frame: false,
  }));
  /** 3D 지도에서 지금 고른 단지 — 2D로 돌아가도 고른 채로 */
  const sel3dRef = useRef<string | null>(null);
  /** 3D에서 고른 단지 자리 — 2D로 돌아가면 그 단지를 가운데로 */
  const sel3dAtRef = useRef<{ lat: number; lng: number } | null>(null);
  /** 3D에서 고른 단지 (카드가 아직 안 떴어도) — 전환 중 브리핑 시트가 잠깐 떴다 사라지지 않게 */
  const [sel3d, setSel3d] = useState<string | null>(null);
  const onSelected3d = useCallback((id: string | null, at?: { lat: number; lng: number } | null) => {
    sel3dRef.current = id;
    sel3dAtRef.current = id ? (at ?? null) : null;
    setSel3d(id);
  }, []);
  /** 2D 단지 카드 '더보기' — 연 단지에만 (다른 단지를 고르면 접힘) */
  const [cardMoreId, setCardMoreId] = useState<string | null>(null);
  /** 3D 지도가 지금 보는 곳 — 2D로 돌아갈 때 그 자리로 */
  const view3dRef = useRef<(() => Map3dView) | null>(null);
  /** 브리핑에서 고른 곳 — 3D 지도가 그리로 날아가 단지를 고른다 (seq 가 바뀔 때마다) */
  const [focus3d, setFocus3d] = useState<{ lat: number; lng: number; complexId: string | null; seq: number } | null>(null);
  /** 조작 줄 안 3D 전용 알약 자리 (Seoul3DMap 이 portal 로 그린다) */
  const [slot3d, setSlot3d] = useState<HTMLSpanElement | null>(null);
  /** 3D 지도에 단지 카드가 떠 있나 — 그동안 브리핑 시트를 숨긴다 */
  const [card3d, setCard3d] = useState(false);
  /** 브리핑 '지역' 범위용 — 2D 지도가 멈춘 곳(네이버 줌), 3D 카메라가 멈춘 곳(MapLibre 줌) */
  const [view2d, setView2d] = useState<{ lat: number; lng: number; zoom: number } | null>(null);
  const [cam3d, setCam3d] = useState<Map3dView | null>(null);
  /** 처음 온 사람 3D 안내 — 한 번 닫거나 3D를 쓰면 끝 (null = 아직 모름, 서버 렌더와 같게) */
  const [inviteDone, setInviteDone] = useState<boolean | null>(null);
  useEffect(() => {
    // localStorage 는 브라우저에서만 — 첫 렌더 뒤에 읽는다
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setInviteDone(read3dInviteDone());
  }, []);
  const finishInvite = () => {
    mark3dInviteDone();
    setInviteDone(true);
  };
  const open3d = () => {
    finishInvite();
    // 새로 여는 3D — 예전 카메라·고른 단지는 버리고 주소에 view=3d (기록은 쌓지 않음)
    clear3dSession(pathname);
    replaceViewParam("3d");
    // 2D 지도가 못 떴어도(인증 실패 등) 3D는 연다 — 마지막으로 본 곳에서
    let v = readLastView();
    try {
      const map = mapRef.current;
      if (map) v = { lat: map.getCenter().y, lng: map.getCenter().x, zoom: map.getZoom() };
    } catch {
      /* 2D 지도 상태를 못 읽으면 저장된 위치 */
    }
    // 2D에서 고른 단지는 3D에서도 고른 채로 (그 단지를 비스듬히 담는다)
    setInitial3dSel({ id: selectedId, frame: true });
    setSel3d(selectedId);
    setSelectedId(null);
    setCam3d(null);
    // 네이버 줌(256px 타일)과 MapLibre 줌(512px)은 1 차이 — 같은 축척으로 연다
    setView3d({ lat: v.lat, lng: v.lng, zoom: Math.max(v.zoom, COMPLEX_ZOOM) - 1 });
  };
  /**
   * 2D에서 단지를 고르면 그 단지를 보이는 곳 가운데로 — 위 조작 줄(약 110px)과 아래 카드(약 175px) 사이.
   * 지도 가운데보다 (아래 가림 − 위 가림)/2 만큼 위에 오게 옮긴다.
   */
  const centerOnSelection = (lat: number, lng: number) => {
    const maps = window.naver?.maps;
    const map = mapRef.current;
    if (!maps || !map) return;
    try {
      const proj = map.getProjection();
      const pt = proj.fromCoordToOffset(new maps.LatLng(lat, lng));
      const up = (CARD_SPACE_PX - CONTROLS_SPACE_PX) / 2;
      map.panTo(proj.fromOffsetToCoord(new maps.Point(pt.x, pt.y + up)));
    } catch {
      /* 지도가 준비되지 않았으면 그대로 */
    }
  };
  const close3d = (v: Map3dView) => {
    setView3d(null);
    replaceViewParam("2d");
    clear3dSession(pathname);
    setFocus3d(null);
    setCard3d(false);
    setCam3d(null);
    // 3D에서 고른 단지가 있으면 그 단지를 가운데로(단지가 보이는 거리 이상으로), 없으면 3D가 보던 곳
    const at = sel3dRef.current ? sel3dAtRef.current : null;
    const c = at ?? { lat: v.lat, lng: v.lng };
    const z = at ? Math.max(Math.round(v.zoom + 1), 16) : Math.round(v.zoom + 1);
    setView2d({ lat: c.lat, lng: c.lng, zoom: z });
    // 3D에서 고른 단지는 2D에서도 고른 채로
    setSelectedId(sel3dRef.current);
    const maps = window.naver?.maps;
    try {
      if (maps && mapRef.current) {
        mapRef.current.setCenter(new maps.LatLng(c.lat, c.lng));
        mapRef.current.setZoom?.(z);
      }
    } catch {
      /* 2D 지도가 준비되지 않았으면 그대로 */
    }
  };
  /** 정비구역 레이어 (서울) */
  const [redevOn, setRedevOn] = useState(false);
  const [zones, setZones] = useState<RedevZoneShape[]>([]);
  const [zoneId, setZoneId] = useState<string | null>(null);
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
        // 2D가 없어도 3D 안내·브리핑은 마지막으로 본 곳 기준으로
        const v = readLastView();
        setCenter({ lat: v.lat, lng: v.lng });
        setView2d(v);
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
        setView2d({ lat: view.lat, lng: view.lng, zoom: view.zoom });
        maps.Event.addListener(map, "idle", () => {
          // 브리핑 범위는 시트가 400ms 기다렸다 정한다 — 여기서는 멈춘 곳만 알린다
          const ic = map.getCenter();
          setView2d({ lat: ic.y, lng: ic.x, zoom: map.getZoom() });
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
          onClick: () => {
            setSelectedId(c.complexId);
            centerOnSelection(c.lat, c.lng);
          },
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

  // 정비구역 — 켜져 있고 단지·동 거리일 때 화면 영역의 구역을 읽는다 (영역이 0.01° 넘게 바뀔 때만)
  const zoneKeyRef = useRef("");
  useEffect(() => {
    const map = mapRef.current as MapWithBounds | null;
    if (!redevOn || !map || (level !== "complex" && level !== "dong")) return;
    const b = map.getBounds();
    const r = (v: number) => Math.round(v * 100) / 100;
    const q = { swLat: r(b.getMin().y), swLng: r(b.getMin().x), neLat: r(b.getMax().y), neLng: r(b.getMax().x) };
    const key = Object.values(q).join(",");
    if (key === zoneKeyRef.current) return;
    zoneKeyRef.current = key;
    const qs = new URLSearchParams(Object.fromEntries(Object.entries(q).map(([k, v]) => [k, String(v)])));
    let cancelled = false;
    fetch(`/api/map/redev-zones?${qs}`)
      .then((res) => res.json())
      .then((d: { zones?: RedevZoneShape[] }) => {
        if (!cancelled) setZones(d.zones ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [redevOn, cullTick, level]);

  useEffect(() => {
    const map = mapRef.current;
    const maps = window.naver?.maps;
    if (!redevOn || !map || !maps?.Polygon || (level !== "complex" && level !== "dong")) return;
    const drawn: Array<{ setMap: (m: null) => void }> = [];
    for (const z of zones) {
      if (!z.rings.length) continue;
      const color = zoneColor(z);
      const on = z.zoneId === zoneId;
      const polygon = new maps.Polygon({
        map,
        paths: z.rings.map((ring) => ring.map(([lng, lat]) => new maps.LatLng(lat, lng))),
        fillColor: color,
        fillOpacity: on ? 0.28 : 0.14,
        strokeColor: color,
        strokeOpacity: 0.9,
        strokeWeight: on ? 3 : 1.5,
        clickable: true,
        zIndex: on ? 3 : 2,
      });
      maps.Event.addListener(polygon, "click", () => {
        setSelectedId(null);
        setZoneId(z.zoneId);
      });
      drawn.push(polygon);
    }
    return () => {
      for (const p of drawn) p.setMap(null);
    };
  }, [zones, redevOn, zoneId, level]);
  const zone = redevOn ? (zones.find((z) => z.zoneId === zoneId) ?? null) : null;

  const selected = visibleComplexes.find((c) => c.complexId === selectedId) ?? null;
  const cardMore = selectedId != null && cardMoreId === selectedId;
  const setCardMore = (f: (v: boolean) => boolean) => setCardMoreId(f(cardMore) ? selectedId : null);

  // 고른 단지에 3D 건물 모양이 있는지 — 없으면 '3D로 보기'를 막는다 (동·모양 미연결 단지가 많음)
  const [has3d, setHas3d] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (!selectedId || selectedId in has3d) return;
    const ctrl = new AbortController();
    fetch(`/api/complex-3d/${selectedId}/coverage`, { signal: ctrl.signal })
      .then((res) => (res.ok ? (res.json() as Promise<{ withShape: number }>) : null))
      // 확인이 안 되면 버튼은 그대로 둔다 (3D 화면이 빈 상태를 안내)
      .then((cov) => setHas3d((m) => ({ ...m, [selectedId]: cov ? cov.withShape > 0 : true })))
      .catch(() => {});
    return () => ctrl.abort();
  }, [selectedId, has3d]);
  const selected3d = selected ? has3d[selected.complexId] : undefined;

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
  // 마커 표시 미리보기 — 네 값이 다 있는 단지 중 세대수가 가장 큰 곳 (없으면 가격 있는 단지)
  const sample = (() => {
    const withPrice = visibleComplexes.filter((c) => c.priceMan != null);
    const full = withPrice.filter((c) => c.perPyeongMan != null && c.jeonseRatioPct != null && c.change1yPct != null);
    const pool = full.length ? full : withPrice;
    return pool.reduce<MapComplex | null>((best, c) => (!best || (c.householdCount ?? 0) > (best.householdCount ?? 0) ? c : best), null);
  })();
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
    return conditions.deal === "trade"
      ? `${level === "gu" ? "구" : "동"}별 지역 시세 평당가`
      : `최근 12개월 ${dealLabel}${areaRangeText} · ${level === "gu" ? "구" : "동"}별 전용 평당가`;
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

  /** 2D 지도를 옮긴다 — 가까우면 부드럽게(morph), 멀거나 줌이 크게 바뀌거나 동작 줄이기면 바로. 못 옮기면 false */
  const move2d = (lat: number, lng: number, zoom: number, forceJump = false): boolean => {
    const map = mapRef.current;
    const maps = window.naver?.maps;
    if (!map || !maps || isNaverMapAuthFailed()) return false;
    try {
      const at = new maps.LatLng(lat, lng);
      const c = map.getCenter();
      const jump = forceJump || shouldJump({ lat: c.y, lng: c.x, zoom: map.getZoom() }, { lat, lng, zoom });
      if (map.morph && !jump && !prefersReducedMotion()) map.morph(at, zoom);
      else {
        map.setCenter(at);
        map.setZoom?.(zoom);
      }
      return true;
    } catch {
      return false;
    }
  };

  /**
   * 브리핑 항목 → 지도 이동. 2D는 가운데·줌을 옮기고 단지를 고르고, 3D는 그리로 가서 단지를 고른다(경계·강조).
   * 가까우면 날고, 멀면(약 15km 넘게) 바로 옮긴다. 3D에서 서울 밖을 고르면 2D로 바꿔서 옮긴다(3D는 서울만).
   */
  const goToTarget = (t: BriefingTarget) => {
    const complexId = t.kind === "complex" ? t.complexId : null;
    setZoneId(null);
    // 네이버 지도: 단지는 단지 거리보다 한 칸 더, 지역은 단지가 보이는 거리
    const zoom = complexId ? COMPLEX_ZOOM + 2 : COMPLEX_ZOOM;
    if (view3d) {
      if (inSeoul(t) || state === "error") {
        // 서울이거나 2D를 못 띄웠으면(인증 실패 등) 3D 안에서 옮긴다 (먼 곳은 3D가 바로 옮김)
        setFocus3d({ lat: t.lat, lng: t.lng, complexId, seq: Date.now() });
        return;
      }
      // 3D → 2D (주소 view 도 2D로), 그 자리로 바로
      setView3d(null);
      replaceViewParam("2d");
      clear3dSession(pathname);
      setFocus3d(null);
      setCard3d(false);
      setCam3d(null);
      setView2d({ lat: t.lat, lng: t.lng, zoom });
      if (move2d(t.lat, t.lng, zoom, true)) setSelectedId(complexId);
      return;
    }
    if (state !== "error" && move2d(t.lat, t.lng, zoom)) {
      setSelectedId(complexId);
      return;
    }
    // 2D 지도를 못 띄웠으면(인증 실패 등) 그 자리를 3D로 연다
    saveLastView({ lat: t.lat, lng: t.lng, zoom });
    finishInvite();
    clear3dSession(pathname);
    replaceViewParam("3d");
    setSelectedId(null);
    setCam3d(null);
    setView3d({ lat: t.lat, lng: t.lng, zoom: zoom - 1 });
    setFocus3d({ lat: t.lat, lng: t.lng, complexId, seq: Date.now() });
  };
  /** 브리핑 범위 — 지금 보는 지도(3D면 카메라, 아직 안 움직였으면 연 자리) */
  const briefView = useMemo<BriefingView | null>(() => {
    if (view3d) {
      const v = cam3d ?? view3d;
      return { lat: v.lat, lng: v.lng, zoom: v.zoom, mode: "3d" };
    }
    return view2d ? { ...view2d, mode: "2d" } : null;
  }, [view3d, cam3d, view2d]);
  // 고른 단지가 있으면(카드가 불러오는 중이어도) 숨김 — 2D·3D 전환 때 잠깐 떴다 사라지지 않게
  const briefingHidden = view3d ? card3d || sel3d != null : Boolean(selectedId) || Boolean(zone);
  // 단지·정비구역 카드가 떠 있는 동안 하단 메뉴를 숨긴다 (카드가 맨 아래로)
  const cardOpen = view3d ? card3d : Boolean(selected) || Boolean(zone);
  useEffect(() => {
    setMapCardOpen(cardOpen);
  }, [cardOpen]);
  useEffect(() => () => setMapCardOpen(false), []);
  const showInvite = inviteDone === false && !view3d && center != null && inSeoul(center);

  return (
    <div
      className={`relative w-full ${MAP_HEIGHT_CLASS} ${briefingHidden ? "" : "[--map-sheet-peek:96px] sm:[--map-sheet-peek:0px]"}`}
    >
      {/* h-full, not absolute inset-0: the NAVER SDK forces position:relative on its host. */}
      <div ref={hostRef} className="isolate h-full w-full" role="application" aria-label="단지 가격 지도" />

      {/*
        상단: 조작 줄 하나 (모바일은 상단바가 없어 로고·검색·메뉴도 여기) + 그 아래 상태.
        [로고] ⟨가로 스크롤: 검색 · 2D|3D · 매매|전세 · 조건 · 지표(2D 마커 / 3D 범례·구 이동) · 정비구역 · 조건 칩들⟩ [≡]
        줄은 3D 화면(z-20)·하단 독(z-40) 위(z-50) — 2D·3D에서 같은 자리. 팝오버는 fixed 라 스크롤 줄에 잘리지 않는다.
      */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-col gap-2 pt-[calc(env(safe-area-inset-top)+8px)] sm:pt-3">
        <div className="pointer-events-auto relative z-50 flex flex-col gap-1" data-map-controls>
        <div className="flex items-center gap-1.5 pl-3 pr-2 sm:pl-4 sm:pr-0">
          {/* 브랜드 — 집 모양만 (상단바 로고 대신, 모바일만) */}
          <span
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full border border-[color:var(--lab-border)] bg-white shadow-sm sm:hidden"
            role="img"
            aria-label="집랩"
          >
            <span className="block h-[22px] w-[22px] overflow-hidden" aria-hidden>
              <Image src="/brand/jiplab-logo.png" alt="" width={1065} height={406} priority className="h-[22px] w-auto max-w-none" />
            </span>
          </span>
          <div
            className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto overflow-y-hidden overscroll-x-contain py-1 pl-0.5 pr-1 sm:pr-4 [&::-webkit-scrollbar]:hidden"
            // 오른쪽 끝을 흐리게 — 잘린 칩이 '옆으로 밀면 더 있음'으로 보이게
            style={{
              scrollbarWidth: "none",
              maskImage: "linear-gradient(to right, #000 calc(100% - 28px), transparent)",
              WebkitMaskImage: "linear-gradient(to right, #000 calc(100% - 28px), transparent)",
            }}
            role="toolbar"
            aria-label="지도 조건"
          >
            <MapViewSwitch
              mode={view3d ? "3d" : "2d"}
              onChange={(m) => {
                if (m === "3d") open3d();
                else if (view3d) close3d(view3dRef.current?.() ?? view3d);
              }}
            />
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
        </div>
        {/* 둘째 줄 — 보기 방식: 마커 값(2D) · 3D 지표 범례와 구 이동(Seoul3DMap이 portal) · 정비구역 */}
        <div className="flex items-center gap-1.5 overflow-x-auto px-3 py-0.5 sm:px-4 [&::-webkit-scrollbar]:hidden" style={{ scrollbarWidth: "none" }}>
              {!view3d && level === "complex" ? (
                // 마커에 보일 값 — 조건(필터)이 아니라 보기 방식 (3D는 이 자리에 범례 알약)
                <button
                  type="button"
                  aria-haspopup="dialog"
                  aria-label={`마커 표시: ${MARKER_METRICS.find((m) => m.id === metric)!.label}`}
                  onClick={() => setMetricOpen(true)}
                  className="relative inline-flex h-9 shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-[color:var(--lab-navy-950)] bg-[color:var(--lab-surface)] pl-2.5 pr-2 text-[14px] font-semibold leading-5 text-[color:var(--lab-navy-950)] shadow-sm before:absolute before:inset-x-0 before:-inset-y-1 before:content-['']"
                >
                  <MapPin className="h-4 w-4" aria-hidden />
                  마커: {MARKER_METRICS.find((m) => m.id === metric)!.label}
                  <ChevronDown className="h-4 w-4 opacity-60" aria-hidden />
                </button>
              ) : null}
              {/* 3D 지도의 지표(범례) 알약 · 구 이동 — Seoul3DMap 이 여기에 그린다 (portal) */}
              <span ref={setSlot3d} className="contents" />
              {!view3d && (level === "complex" || level === "dong") ? (
                <button
                  type="button"
                  aria-pressed={redevOn}
                  onClick={() => {
                    setRedevOn((v) => !v);
                    setZoneId(null);
                    zoneKeyRef.current = "";
                    if (redevOn) setZones([]);
                  }}
                  className={`relative inline-flex h-9 shrink-0 items-center gap-1 whitespace-nowrap rounded-full border pl-2.5 pr-3 text-[14px] font-semibold leading-5 shadow-sm before:absolute before:inset-x-0 before:-inset-y-1 before:content-[''] ${
                    redevOn
                      ? "border-[color:var(--lab-brand-primary)] bg-[color:var(--lab-brand-subtle)] text-[color:var(--lab-teal-700)]"
                      : "border-[color:var(--lab-border)] bg-[color:var(--lab-surface)] text-[color:var(--lab-navy-950)]"
                  }`}
                >
                  <Construction className="h-4 w-4" aria-hidden />
                  정비구역
                </button>
              ) : null}
        </div>
        </div>
        <div className="flex flex-col items-start gap-2 px-3 sm:px-4">
          {redevOn && (level === "complex" || level === "dong") ? (
            <p className="pointer-events-auto flex flex-wrap items-center gap-x-2.5 rounded-lg bg-[color:var(--lab-surface)]/95 px-2.5 py-1 text-[13px] leading-5 text-[color:var(--lab-muted)] shadow-sm">
              {[
                ["#7C3AED", "재건축"],
                ["#EA580C", "재개발"],
                ["#64748B", "단계 정보 없음"],
              ].map(([c, l]) => (
                <span key={l} className="inline-flex items-center gap-1">
                  <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: c }} aria-hidden />
                  {l}
                </span>
              ))}
              <span>· 서울</span>
            </p>
          ) : null}
          {statusText ? (
            // 한 줄로만 — 지도를 덜 가리게 (넘치면 말줄임, 전체는 title)
            <p
              className="pointer-events-auto max-w-full truncate rounded-lg bg-[color:var(--lab-surface)]/95 px-2.5 py-1 text-[12px] leading-5 text-[color:var(--lab-muted)] shadow-sm"
              title={statusText}
            >
              {statusText}
              {state === "loading" ? " · 불러오는 중…" : ""}
            </p>
          ) : null}
          {level !== "complex" && level !== "far" && nActive > (conditions.deal === "trade" ? 0 : area.min > 0 || area.max < 10_000 ? 1 : 0) ? (
            <p className="pointer-events-auto rounded-lg bg-[color:var(--lab-surface)]/95 px-2.5 py-1 text-[13px] leading-5 text-[color:var(--lab-muted)] shadow-sm">
              {conditions.deal === "trade" ? "조건" : "면적 외 조건"}은 단지가 보이는 거리에서 적용돼요
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
        className="absolute right-3 bottom-[calc(env(safe-area-inset-bottom)+var(--map-dock-space,68px)+16px+var(--map-sheet-peek,0px))] inline-flex h-11 w-11 items-center justify-center rounded-full border border-[color:var(--lab-border)] bg-[color:var(--lab-surface)] text-[color:var(--lab-navy-950)] shadow-sm sm:right-4 sm:bottom-[calc(env(safe-area-inset-bottom)+16px)]"
        style={
          selected
            ? { bottom: `calc(env(safe-area-inset-bottom) + var(--map-dock-space,68px) + ${cardMore ? 176 : 120}px)`, visibility: cardMore ? "hidden" : undefined }
            : undefined
        }
      >
        <LocateFixed className="h-5 w-5" aria-hidden />
      </button>

      {/* 하단 가운데: 화면 가운데 구·동 상세로 이동 */}
      {centerLink && !selected ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+var(--map-dock-space,68px)+16px+var(--map-sheet-peek,0px))] flex justify-center px-16 sm:bottom-[calc(env(safe-area-inset-bottom)+16px)]">
          <Link
            href={centerLink.href}
            className="pointer-events-auto inline-flex h-11 min-w-0 items-center gap-0.5 rounded-full bg-[color:var(--lab-navy-950)] pl-4 pr-2.5 text-[14px] font-semibold leading-5 text-white shadow-lg"
          >
            <span className="truncate">{centerLink.label}</span>
            <ChevronRight className="h-4 w-4 shrink-0" aria-hidden />
          </Link>
        </div>
      ) : null}

      {/* 하단: 선택 단지 카드 — 작게(약 108px): 이름·위치 / 최근 거래·12개월 / 단지 상세 · 3D. 나머지 값은 '더보기' */}
      {selected ? (
        <div className="absolute inset-x-0 bottom-0 px-4 pb-[calc(env(safe-area-inset-bottom)+var(--map-dock-space,68px))] sm:p-4 sm:pb-4">
          <div
            className="mx-auto w-full max-w-md rounded-2xl border border-[color:var(--lab-border)] bg-[color:var(--lab-surface)] px-3.5 pb-2.5 pt-2.5 shadow-lg"
            data-map2d-card
          >
            <div className="flex items-center gap-2">
              <p className="min-w-0 flex-1 truncate leading-5">
                <span className="text-[15px] font-bold text-[color:var(--lab-teal-700)]">{displayAptName(selected.aptName)}</span>
                {selected.guRank ? (
                  <span
                    className="ml-1.5 rounded px-1 text-[11px] font-semibold leading-4"
                    style={{
                      color: CROWNS[selected.guRank].stroke,
                      background: `color-mix(in srgb, ${CROWNS[selected.guRank].fill} 35%, white)`,
                    }}
                  >
                    {selected.guName ? `${selected.guName} ` : ""}
                    {selected.guRank}위
                  </span>
                ) : null}
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
                {selected.pyeongLabel
                  ? ` ${selected.pyeongLabel}`
                  : selected.mainAreaSqm
                    ? ` ${Math.floor(selected.mainAreaSqm)}㎡`
                    : ""}
              </span>
              <span className="shrink-0 text-[15px] font-bold tabular-nums text-[color:var(--lab-teal-700)]">
                {selected.priceMan ? formatEok(selected.priceMan) : "거래 없음"}
              </span>
              {selected.priceDate ? <span className="shrink-0 tabular-nums">{formatDealDate(selected.priceDate)}</span> : null}
              {selected.move ? (
                <span className={`shrink-0 font-semibold ${selected.move === "singoga" ? "text-[#D93A3F]" : "text-[#2F62D6]"}`}>
                  {selected.move === "singoga" ? "신고가" : "하락"}
                </span>
              ) : null}
              <span aria-hidden>·</span>
              {/* 3D 카드와 같게 — 평당가 (12개월 범위·건수는 더보기) */}
              <span className="min-w-0 truncate">
                평당{" "}
                <span className="font-semibold tabular-nums text-[color:var(--lab-teal-700)]">
                  {selected.perPyeongMan != null ? shortPerPyeong(selected.perPyeongMan) : "–"}
                </span>
              </span>
            </p>
            {cardMore ? <ComplexCardMore c={selected} id="map2d-card-more" /> : null}
            <div className="mt-2.5 flex gap-2">
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
                aria-controls="map2d-card-more"
                onClick={() => setCardMore((v) => !v)}
                className="inline-flex h-9 w-[68px] shrink-0 items-center justify-center gap-0.5 rounded-lg text-[13px] font-semibold text-[color:var(--lab-teal-700)]"
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

      {zone && !selected ? (
        <div className="absolute inset-x-0 bottom-0 px-4 pb-[calc(env(safe-area-inset-bottom)+var(--map-dock-space,68px))] sm:p-4 sm:pb-4">
          <div className="mx-auto w-full max-w-md rounded-2xl border border-[color:var(--lab-border)] bg-[color:var(--lab-surface)] p-4 shadow-lg">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-1.5">
                  <span
                    className="rounded px-1.5 text-[12px] font-semibold leading-5 text-white"
                    style={{ background: zoneColor(zone) }}
                  >
                    {zone.project ? (zone.project.kind === "기타" ? "정비사업" : zone.project.kind) : "정비구역"}
                  </span>
                  {zone.category ? <span className="detail-meta">{zone.category}</span> : null}
                </p>
                <p className="detail-subsection-title mt-1 break-keep">{zone.project?.zoneName ?? zone.name}</p>
                {zone.project && zone.project.zoneName !== zone.name ? (
                  <p className="detail-meta break-keep">{zone.name}</p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => setZoneId(null)}
                aria-label="닫기"
                className="-mr-2 -mt-2 inline-flex h-11 w-11 shrink-0 items-center justify-center text-[color:var(--lab-muted)]"
              >
                <X className="h-5 w-5" aria-hidden />
              </button>
            </div>
            {zone.project?.stage ? (
              <div className="mt-3 flex flex-col gap-2">
                <p className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-[18px] font-bold leading-6 text-[color:var(--lab-teal-700)]">{zone.project.stage}</span>
                  {zone.project.stageIndex >= 0 && zone.project.stageIndex < REDEV_STAGES.length - 1 ? (
                    <span className="detail-meta">다음: {REDEV_STAGES[zone.project.stageIndex + 1]}</span>
                  ) : null}
                  {zone.project.householdsTotal != null ? (
                    <span className="detail-meta tabular-nums">새로 짓는 {zone.project.householdsTotal.toLocaleString("ko-KR")}세대</span>
                  ) : null}
                </p>
                {zone.project.stageIndex >= 0 ? (
                  <div className="flex gap-1" aria-hidden>
                    {REDEV_STAGES.map((st, i) => (
                      <span
                        key={st}
                        className="h-2 flex-1 rounded-full"
                        style={{
                          background:
                            i < zone.project!.stageIndex
                              ? "var(--lab-brand-border)"
                              : i === zone.project!.stageIndex
                                ? "var(--lab-brand-primary)"
                                : "var(--lab-surface-subtle)",
                        }}
                      />
                    ))}
                  </div>
                ) : null}
              </div>
            ) : (
              <p className="detail-meta mt-2">
                사업 단계 정보가 없는 구역입니다{zone.noticeDate ? ` · 고시 ${zone.noticeDate.slice(0, 7).replace("-", ".")}` : ""}.
              </p>
            )}
          </div>
        </div>
      ) : null}

      <LabBottomSheet open={metricOpen} onClose={() => setMetricOpen(false)} title="마커 표시" hideDone>
        {/* 선택지마다 실제 마커 모양으로 미리보기 — 화면 속 대표 단지 값 */}
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="마커 표시">
          {MARKER_METRICS.map((m) => {
            const on = metric === m.id;
            const v = sample ? markerValue(sample, m.id) : { text: SAMPLE_TEXT[m.id] };
            return (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => chooseMetric(m.id)}
                className={`relative flex flex-col items-center gap-2 rounded-xl px-2 pb-2.5 pt-3.5 ${
                  on
                    ? "border-2 border-[color:var(--lab-brand-primary)] bg-[color:var(--lab-brand-subtle)]"
                    : "border border-[color:var(--lab-border)] bg-[color:var(--lab-surface)]"
                }`}
              >
                {on ? (
                  <Check className="absolute right-2 top-2 h-4 w-4 text-[color:var(--lab-brand-primary)]" aria-hidden />
                ) : null}
                <span className="flex flex-col items-center" aria-hidden>
                  <span className="h-4 min-w-[30px] rounded-t-[5px] bg-[color:var(--lab-brand-primary)] px-1.5 text-center text-[11px] font-semibold leading-4 text-white">
                    {sample?.pyeongLabel ?? "33평"}
                  </span>
                  <span
                    className="min-w-12 whitespace-nowrap rounded-[7px] border-[1.5px] border-[color:var(--lab-brand-primary)] bg-white px-2 py-0.5 text-center text-[13px] font-bold leading-[18px] tabular-nums text-[color:var(--lab-navy-950)]"
                    style={v.color ? { color: v.color } : undefined}
                  >
                    {v.text}
                  </span>
                  <span className="-mt-px h-0 w-0 border-x-[5px] border-t-[6px] border-x-transparent border-t-[color:var(--lab-brand-primary)]" />
                </span>
                <span
                  className={`text-[15px] leading-5 ${on ? "font-semibold text-[color:var(--lab-teal-700)]" : "font-medium text-[color:var(--lab-navy-950)]"}`}
                >
                  {m.label}
                </span>
              </button>
            );
          })}
        </div>
        {sample ? (
          <p className="mt-2 text-[13px] leading-5 text-[color:var(--lab-muted)]">예시: {sample.aptName}</p>
        ) : null}
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

      {/* 서울 3D 지도 — 3D를 누를 때만 MapLibre·건물 타일을 불러온다. 맨 위 줄(전환·거래유형·조건)은 이 위에 그대로 */}
      {view3d ? (
        <Seoul3DMap
          initial={view3d}
          conditions={conditions}
          viewRef={view3dRef}
          focus={focus3d}
          onCardChange={setCard3d}
          initialSelectedId={initial3dSel.id}
          frameInitialSelected={initial3dSel.frame}
          onSelectedChange={onSelected3d}
          labelMetric={metric}
          onLabelMetricChange={chooseMetric}
          sessionPath={pathname}
          onMoveEnd={setCam3d}
          controlsSlot={slot3d}
          satelliteKey={satelliteKey}
        />
      ) : null}

      {/* 오늘의 시장 브리핑 — 2D·3D 모두 (단지 카드가 뜨면 숨김) */}
      <MapBriefingSheet hidden={briefingHidden} view={briefView} onTarget={goToTarget} />

      {showInvite ? (
        <Map3dInvite
          onTry={() => {
            finishInvite();
            open3d();
          }}
          onDismiss={finishInvite}
        />
      ) : null}

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

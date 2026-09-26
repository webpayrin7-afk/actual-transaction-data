"use client";

/**
 * 서울 3D 지도 (1단계) — 지도로 찾기에서 '3D로 보기'를 눌렀을 때만 불러온다 (MapLibre + PMTiles 건물 타일).
 * 2D(네이버) 지도와 따로 동작하며, 단지 값은 2D와 같은 /api/map/complexes(화면 범위, 서버 계산)만 쓴다.
 */
import "maplibre-gl/dist/maplibre-gl.css";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import maplibregl, { type GeoJSONSource, type Map as MlMap, type StyleSpecification } from "maplibre-gl";
import { Protocol } from "pmtiles";
import { Compass, Map as MapIcon, X } from "lucide-react";
import { LabIndeterminateBar } from "@/components/ui/LabLoading";
import { shortPerPyeong } from "@/components/map/complex-marker";
import type { MapComplex, MapDealKind } from "@/lib/map/map-complexes";
import { formatDealDate, formatEok } from "@/lib/utils/format";
import {
  BASEMAP_STYLE_URL,
  BUILDING_COLOR,
  BUILDING_HEIGHT,
  BUILDINGS_ATTRIBUTION,
  CHANGE_STEPS,
  LOCALE_KO,
  NO_VALUE_COLOR,
  PER_PYEONG_STEPS,
  SEOUL_BOUNDS,
  buildingsTilesUrl,
  calmBasemap,
  stepColor,
  type Map3dMetric,
} from "@/components/map3d/seoul-3d-style";

export type Map3dView = { lat: number; lng: number; zoom: number };

const DEAL_LABEL: Record<MapDealKind, string> = { trade: "매매", jeonse: "전세" };
/** 단지를 불러오는 줌 — MapLibre 줌(512px 타일)이라 2D(네이버) 14와 같은 축척 */
const COMPLEX_ZOOM = 13;
/** 화면 가운데 기준으로 부르는 범위(도) — API 한도(0.12°) 안, 격자에 맞춰 CDN 캐시가 잘 맞게 */
const HALF_LAT = 0.03;
const HALF_LNG = 0.04;
const SNAP = 0.01;
const START_PITCH = 55;

let protocolAdded = false;

/** MapLibre 컨트롤 — 모바일 아래 탭 막대 위로, 손가락 크기(44px) */
const CONTROL_CSS = `
.seoul3d .maplibregl-ctrl-bottom-right{bottom:calc(env(safe-area-inset-bottom) + 76px)}
@media (min-width:640px){.seoul3d .maplibregl-ctrl-bottom-right{bottom:0}}
.seoul3d .maplibregl-ctrl-group button{width:40px;height:40px}
.seoul3d .maplibregl-ctrl-attrib{font-size:11px}
`;

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

function metricValue(c: MapComplex, metric: Map3dMetric): number | null {
  return metric === "perPyeong" ? c.perPyeongMan : c.change1yPct;
}

function metricText(v: number | null, metric: Map3dMetric): string {
  if (v == null) return "";
  if (metric === "perPyeong") return shortPerPyeong(v);
  if (v === 0) return "0%";
  return `${v > 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}%`;
}

function toGeoJson(list: MapComplex[], metric: Map3dMetric): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: list.map((c) => {
      const v = metricValue(c, metric);
      const props: Record<string, string | number> = { id: c.complexId, label: metricText(v, metric) };
      if (v != null) props.v = v;
      return { type: "Feature", geometry: { type: "Point", coordinates: [c.lng, c.lat] }, properties: props };
    }),
  };
}

export default function Seoul3DMap({
  initial,
  deal,
  areaMin,
  areaMax,
  onClose,
}: {
  initial: Map3dView;
  deal: MapDealKind;
  areaMin: number;
  areaMax: number;
  /** 2D로 돌아갈 때 3D에서 보던 곳을 넘겨 준다 */
  onClose: (view: Map3dView) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MlMap | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastKeyRef = useRef("");
  const [styleReady, setStyleReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [buildingsMissing, setBuildingsMissing] = useState(false);
  const [complexes, setComplexes] = useState<MapComplex[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [metric, setMetric] = useState<Map3dMetric>("perPyeong");
  const [zoomedOut, setZoomedOut] = useState(initial.zoom < COMPLEX_ZOOM - 0.25);
  const [outside, setOutside] = useState(!inSeoul(initial.lat, initial.lng));
  const [bearing, setBearing] = useState(0);
  const metricRef = useRef(metric);

  const fetchComplexes = useCallback(async () => {
    const map = mapRef.current;
    if (!map) return;
    const c = map.getCenter();
    const z = map.getZoom();
    setZoomedOut(z < COMPLEX_ZOOM - 0.25);
    setOutside(!inSeoul(c.lat, c.lng));
    if (z < COMPLEX_ZOOM - 0.25) return;
    const swLat = Math.floor((c.lat - HALF_LAT) / SNAP) * SNAP;
    const swLng = Math.floor((c.lng - HALF_LNG) / SNAP) * SNAP;
    const neLat = Math.ceil((c.lat + HALF_LAT) / SNAP) * SNAP;
    const neLng = Math.ceil((c.lng + HALF_LNG) / SNAP) * SNAP;
    const qs = new URLSearchParams({
      swLat: swLat.toFixed(2),
      swLng: swLng.toFixed(2),
      neLat: neLat.toFixed(2),
      neLng: neLng.toFixed(2),
      areaMin: String(areaMin),
      areaMax: String(areaMax),
      deal,
    });
    const key = qs.toString();
    if (key === lastKeyRef.current) return;
    lastKeyRef.current = key;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    try {
      const res = await fetch(`/api/map/complexes?${key}`, { signal: ac.signal });
      const data = (await res.json()) as { status: string; complexes?: MapComplex[] };
      if (data.status !== "ok" && data.status !== "zoom_in") throw new Error(data.status);
      setComplexes(data.complexes ?? []);
      setError(null);
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      lastKeyRef.current = "";
      setError("단지 정보를 불러오지 못했습니다.");
    } finally {
      if (!ac.signal.aborted) setLoading(false);
    }
  }, [deal, areaMin, areaMax]);

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
        // 도로·지명 글자 아래에 건물을 둔다
        const firstSymbol = map.getStyle().layers.find((l) => l.type === "symbol")?.id;
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
        map.addSource("complexes", { type: "geojson", data: toGeoJson([], metricRef.current) });
        map.addLayer({
          id: "complex-dots",
          type: "circle",
          source: "complexes",
          paint: {
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 13, 5, 16, 9],
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
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 13, 9, 16, 14],
            "circle-color": "rgba(0,0,0,0)",
            "circle-stroke-color": "#0f172a",
            "circle-stroke-width": 2.5,
            "circle-pitch-alignment": "viewport",
          },
        });
        map.addLayer({
          id: "complex-labels",
          type: "symbol",
          source: "complexes",
          minzoom: 13.5,
          layout: {
            "text-field": ["get", "label"],
            "text-size": 12,
            "text-offset": [0, -1.4],
            "text-anchor": "bottom",
            "text-font": ["Noto Sans Bold"],
            "text-allow-overlap": false,
            "text-padding": 2,
            "symbol-sort-key": ["-", 0, ["coalesce", ["get", "v"], 0]],
          },
          paint: {
            "text-color": "#0f172a",
            "text-halo-color": "#ffffff",
            "text-halo-width": 1.6,
          },
        });
        const pick = (e: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
          const id = e.features?.[0]?.properties?.id;
          if (typeof id === "string") setSelectedId(id);
        };
        map.on("click", "complex-dots", pick);
        map.on("click", (e) => {
          const hit = map.queryRenderedFeatures(e.point, { layers: ["complex-dots"] });
          if (!hit.length) setSelectedId(null);
        });
        map.on("mouseenter", "complex-dots", () => (map.getCanvas().style.cursor = "pointer"));
        map.on("mouseleave", "complex-dots", () => (map.getCanvas().style.cursor = ""));
        setStyleReady(true);
        setLoading(false);
        // 처음 한 번 비스듬히 — 3D임을 알 수 있게 (동작 줄이기면 바로)
        if (!reduce) map.easeTo({ pitch: START_PITCH, duration: 900 });
        void fetchComplexes();
      });
      map.on("rotate", () => setBearing(map.getBearing()));
      map.on("moveend", () => {
        window.clearTimeout(moveTimer);
        moveTimer = window.setTimeout(() => void fetchComplexes(), 300);
      });
    })();
    return () => {
      cancelled = true;
      window.clearTimeout(moveTimer);
      abortRef.current?.abort();
      mapRef.current?.remove();
      mapRef.current = null;
    };
    // initial은 처음 한 번만 쓴다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 단지 점·지표 갱신
  useEffect(() => {
    metricRef.current = metric;
    const map = mapRef.current;
    if (!map || !styleReady) return;
    (map.getSource("complexes") as GeoJSONSource | undefined)?.setData(toGeoJson(complexes, metric));
    map.setPaintProperty("complex-dots", "circle-color", stepColor(metric));
  }, [complexes, metric, styleReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReady) return;
    map.setFilter("complex-selected", ["==", ["get", "id"], selectedId ?? ""]);
  }, [selectedId, styleReady]);

  const selected = selectedId ? complexes.find((c) => c.complexId === selectedId) ?? null : null;
  const dealLabel = DEAL_LABEL[deal];
  const steps = metric === "perPyeong" ? PER_PYEONG_STEPS : CHANGE_STEPS;

  const close = () => {
    const map = mapRef.current;
    if (!map) return onClose(initial);
    const c = map.getCenter();
    onClose({ lat: c.lat, lng: c.lng, zoom: map.getZoom() });
  };

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

      {/* 위: 돌아가기 · 지표 · 상태 */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-col gap-2 px-3 pt-2 sm:px-4 sm:pt-3">
        {loading ? <LabIndeterminateBar className="pointer-events-none absolute inset-x-0 top-0 !h-0.5 !rounded-none" /> : null}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={close}
            className="pointer-events-auto relative inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-[color:var(--lab-navy-950)] pl-3 pr-3.5 text-[14px] font-semibold leading-5 text-white shadow-sm before:absolute before:inset-x-0 before:-inset-y-1 before:content-['']"
          >
            <MapIcon className="h-4 w-4" aria-hidden />
            2D 지도
          </button>
          <div
            className="pointer-events-auto inline-flex h-9 shrink-0 rounded-full border border-[color:var(--lab-navy-950)] bg-[color:var(--lab-surface)] p-0.5 shadow-sm"
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
              <Link href={`/complex-3d/${selected.complexId}`} className="lab-button lab-button-secondary w-full">
                3D 단지 탐색
              </Link>
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

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { LocateFixed, X } from "lucide-react";
import { LabTabs } from "@/components/ui/LabTabs";
import {
  isNaverMapAuthFailed,
  loadNaverMapsSdk,
  NAVER_AUTH_FAILURE_EVENT,
  NAVER_AUTH_FAILURE_MESSAGE,
  type NaverMapInstance,
  type NaverMarkerInstance,
} from "@/lib/nearby-map/naver-sdk";
import type { MapAreaBand, MapComplex } from "@/lib/map/map-complexes";
import { formatDealDate, formatEok } from "@/lib/utils/format";

type Bounds = { getMin(): { y: number; x: number }; getMax(): { y: number; x: number } };
type MapWithBounds = NaverMapInstance & {
  getBounds(): Bounds;
  getCenter(): { y: number; x: number };
  getZoom(): number;
};

const BANDS: Array<{ id: MapAreaBand; label: string }> = [
  { id: "all", label: "전체" },
  { id: "small", label: "소형" },
  { id: "mid", label: "중형" },
  { id: "large", label: "대형" },
];
const BAND_HINT: Record<MapAreaBand, string> = {
  all: "모든 면적",
  small: "전용 60㎡ 미만",
  mid: "전용 60~85㎡",
  large: "전용 85㎡ 초과",
};

/** 처음 열 때 위치 — 마지막으로 본 곳을 기억 (브라우저에만). */
const LAST_VIEW_KEY = "apt-datalab:map-last-view:v1";
const DEFAULT_VIEW = { lat: 37.5133, lng: 127.0806, zoom: 15 }; // 잠실
const MIN_PRICE_ZOOM = 14;

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

/** 억 단위 짧은 표기: 315000 → "31.5억", 98000 → "9.8억" */
function shortEok(man: number): string {
  const eok = man / 10000;
  return `${eok >= 10 ? Math.round(eok * 10) / 10 : Math.round(eok * 10) / 10}억`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** 가격 말풍선 (가격 있음) / 작은 점 (기간 내 거래 없음). 색은 --lab-* 토큰. */
function markerHtml(c: MapComplex, selected: boolean): { content: string; w: number; h: number } {
  if (c.medianPriceMan == null) {
    return {
      content: `<div style="width:12px;height:12px;border-radius:9999px;background:var(--lab-surface);border:2px solid ${
        selected ? "var(--lab-brand-primary)" : "var(--lab-muted)"
      };box-shadow:0 1px 2px rgba(15,23,42,.2)"></div>`,
      w: 12,
      h: 12,
    };
  }
  const bg = selected ? "var(--lab-brand-primary)" : "var(--lab-surface)";
  const fg = selected ? "#fff" : "var(--lab-navy-950)";
  const border = selected ? "var(--lab-brand-primary)" : "var(--lab-brand-primary)";
  return {
    content: `<div style="position:relative;transform:translate(-50%,-100%);display:inline-flex;flex-direction:column;align-items:center;cursor:pointer">
      <div style="white-space:nowrap;padding:3px 8px;border-radius:8px;background:${bg};color:${fg};border:1.5px solid ${border};font:600 13px/18px 'Noto Sans KR',system-ui,sans-serif;font-variant-numeric:tabular-nums;box-shadow:0 1px 3px rgba(15,23,42,.18)">${escapeHtml(
        shortEok(c.medianPriceMan),
      )}</div>
      <div style="width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;border-top:6px solid ${border};margin-top:-1px"></div>
    </div>`,
    w: 0,
    h: 0,
  };
}

export function MapSearchPage() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapWithBounds | null>(null);
  const markersRef = useRef<Map<string, NaverMarkerInstance>>(new Map());
  const abortRef = useRef<AbortController | null>(null);
  const [band, setBand] = useState<MapAreaBand>("mid");
  const [complexes, setComplexes] = useState<MapComplex[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "zoom_in" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  /** Read by the map idle listener, which is registered once. */
  const bandRef = useRef(band);

  const fetchViewport = useCallback(async () => {
    const map = mapRef.current;
    if (!map) return;
    const zoom = map.getZoom();
    const c = map.getCenter();
    saveLastView({ lat: c.y, lng: c.x, zoom });
    if (zoom < MIN_PRICE_ZOOM) {
      setState("zoom_in");
      setComplexes([]);
      return;
    }
    const b = map.getBounds();
    const sw = b.getMin();
    const ne = b.getMax();
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    const qs = new URLSearchParams({
      swLat: sw.y.toFixed(5),
      swLng: sw.x.toFixed(5),
      neLat: ne.y.toFixed(5),
      neLng: ne.x.toFixed(5),
      band: bandRef.current,
    });
    try {
      const res = await fetch(`/api/map/complexes?${qs}`, { signal: ac.signal });
      const data = (await res.json()) as { status: string; complexes: MapComplex[]; truncated?: boolean };
      if (data.status === "zoom_in") {
        setState("zoom_in");
        setComplexes([]);
        return;
      }
      if (data.status !== "ok") throw new Error(data.status);
      setComplexes(data.complexes);
      setTruncated(Boolean(data.truncated));
      setState("ready");
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setState("error");
      setError("단지 정보를 불러오지 못했습니다.");
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
      try {
        const map = new maps.Map(hostRef.current, {
          center: new maps.LatLng(view.lat, view.lng),
          zoom: view.zoom,
          zoomControl: false,
          scaleControl: false,
          mapDataControl: false,
        }) as MapWithBounds;
        mapRef.current = map;
        maps.Event.addListener(map, "idle", () => {
          window.clearTimeout(idleTimer);
          idleTimer = window.setTimeout(() => void fetchViewport(), 250);
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

  // Band change → refetch current viewport.
  useEffect(() => {
    bandRef.current = band;
    // Deferred so the fetch (and its setState) runs outside the effect body.
    const t = window.setTimeout(() => void fetchViewport(), 0);
    return () => window.clearTimeout(t);
  }, [band, fetchViewport]);

  // Sync markers (diff by id).
  useEffect(() => {
    const map = mapRef.current;
    const maps = window.naver?.maps;
    if (!map || !maps) return;
    const markers = markersRef.current;
    const next = new Set(complexes.map((c) => c.complexId));
    for (const [id, m] of markers) {
      if (!next.has(id)) {
        m.setMap(null);
        markers.delete(id);
      }
    }
    for (const c of complexes) {
      const selected = c.complexId === selectedId;
      const html = markerHtml(c, selected);
      const icon = {
        content: html.content,
        anchor: html.w ? new maps.Point(html.w / 2, html.h / 2) : new maps.Point(0, 0),
      };
      const existing = markers.get(c.complexId);
      if (existing) {
        existing.setIcon?.(icon);
        existing.setZIndex?.(selected ? 1000 : c.medianPriceMan != null ? 100 : 10);
        continue;
      }
      const marker = new maps.Marker({
        position: new maps.LatLng(c.lat, c.lng),
        map,
        icon,
        title: c.aptName,
        zIndex: c.medianPriceMan != null ? 100 : 10,
      });
      maps.Event.addListener(marker, "click", () => setSelectedId(c.complexId));
      markers.set(c.complexId, marker);
    }
  }, [complexes, selectedId]);

  const selected = complexes.find((c) => c.complexId === selectedId) ?? null;
  const priced = complexes.filter((c) => c.medianPriceMan != null).length;

  const locate = () => {
    if (!navigator.geolocation || !mapRef.current || !window.naver?.maps) return;
    navigator.geolocation.getCurrentPosition((pos) => {
      const maps = window.naver!.maps;
      mapRef.current?.morph?.(new maps.LatLng(pos.coords.latitude, pos.coords.longitude), 15);
    });
  };

  return (
    <div
      className="relative w-full"
      style={{
        height:
          "calc(100dvh - var(--site-header-height, 56px))",
      }}
    >
      {/* h-full, not absolute inset-0: the NAVER SDK forces position:relative on its host. */}
      <div ref={hostRef} className="h-full w-full" role="application" aria-label="단지 가격 지도" />

      {/* 상단: 면적 필터 + 상태 */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-col gap-2 p-3 sm:p-4">
        <div className="pointer-events-auto w-full max-w-md rounded-xl border border-[color:var(--lab-border)] bg-[color:var(--lab-surface)] p-2 shadow-sm">
          <LabTabs
            variant="compact"
            ariaLabel="면적"
            equalWidth
            value={band}
            items={BANDS}
            onChange={(v) => {
              setSelectedId(null);
              setBand(v);
            }}
          />
          <p className="detail-meta mt-1.5 px-1">
            {BAND_HINT[band]} · 최근 12개월 매매 중위가
            {state === "ready" ? ` · 가격 ${priced}곳` : ""}
            {truncated ? " · 큰 단지 400곳까지" : ""}
          </p>
        </div>
        {state === "zoom_in" ? (
          <p className="pointer-events-auto self-start rounded-lg bg-[color:var(--lab-navy-950)] px-3 py-2 text-[13px] font-medium text-white shadow">
            지도를 확대하면 단지별 가격이 보여요
          </p>
        ) : null}
        {state === "error" && error ? (
          <p className="lab-state lab-state-error pointer-events-auto !min-h-0 max-w-md">{error}</p>
        ) : null}
      </div>

      <button
        type="button"
        onClick={locate}
        aria-label="내 위치로 이동"
        className="absolute right-3 bottom-[calc(env(safe-area-inset-bottom)+84px)] inline-flex sm:bottom-[calc(env(safe-area-inset-bottom)+16px)] h-11 w-11 items-center justify-center rounded-full border border-[color:var(--lab-border)] bg-[color:var(--lab-surface)] text-[color:var(--lab-navy-950)] shadow-sm sm:right-4"
        style={selected ? { bottom: "calc(env(safe-area-inset-bottom) + 264px)" } : undefined}
      >
        <LocateFixed className="h-5 w-5" aria-hidden />
      </button>

      {/* 하단: 선택 단지 카드 */}
      {selected ? (
        <div className="absolute inset-x-0 bottom-0 p-3 pb-[calc(env(safe-area-inset-bottom)+80px)] sm:p-4 sm:pb-4">
          <div className="mx-auto w-full max-w-md rounded-2xl border border-[color:var(--lab-border)] bg-[color:var(--lab-surface)] p-4 shadow-lg">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="detail-subsection-title truncate">{selected.aptName}</p>
                <p className="detail-meta">
                  {[selected.dong, selected.householdCount ? `${selected.householdCount.toLocaleString("ko-KR")}세대` : null]
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
                <dt className="detail-label">{BANDS.find((b) => b.id === band)?.label} 중위가</dt>
                <dd className="detail-data-value-emphasis tabular-nums">
                  {selected.medianPriceMan ? formatEok(Math.round(selected.medianPriceMan)) : "거래 없음"}
                </dd>
                <dd className="detail-meta">최근 12개월 {selected.tradeCount12m}건</dd>
              </div>
              <div className="rounded-xl border border-[color:var(--lab-border)] px-3 py-2">
                <dt className="detail-label">최근 매매</dt>
                <dd className="detail-data-value-emphasis tabular-nums">
                  {selected.latestPriceMan ? formatEok(selected.latestPriceMan) : "—"}
                </dd>
                <dd className="detail-meta">
                  {selected.latestDealDate ? formatDealDate(selected.latestDealDate) : "기간 내 없음"}
                </dd>
              </div>
            </dl>
            <Link href={selected.href} className="lab-button lab-button-primary mt-3 w-full">
              단지 상세 보기
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}

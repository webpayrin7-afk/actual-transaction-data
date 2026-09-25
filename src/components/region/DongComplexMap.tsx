"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { loadNaverMapsSdk, type NaverMapInstance, type NaverMarkerInstance } from "@/lib/nearby-map/naver-sdk";
import type { MapComplex } from "@/lib/map/map-complexes";
import { complexMarkerHtml } from "@/components/map/complex-marker";

type Pt = { complexId: string; lat: number | null; lng: number | null };
type MapWithBounds = NaverMapInstance & {
  getBounds(): { getMin(): { y: number; x: number }; getMax(): { y: number; x: number } };
  getCenter(): { y: number; x: number };
  getZoom(): number;
};

/** 메인 지도가 마지막으로 본 위치 — "지도에서 크게 보기"로 넘길 때 여기에 적어 두면 그 위치로 열린다 */
const LAST_VIEW_KEY = "apt-datalab:map-last-view:v1";

/**
 * 동 상세 단지 지도 — 메인 지도(지도로 찾기)와 같은 가격 마커·같은 데이터(/api/map/complexes, 매매·전체 면적).
 * 이 동의 단지만 보여 주고, 누르면 onSelect.
 */
export function DongComplexMap({
  complexes,
  selectedId,
  onSelect,
  ariaLabel,
}: {
  complexes: Pt[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  ariaLabel: string;
}) {
  const router = useRouter();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapWithBounds | null>(null);
  const markersRef = useRef<NaverMarkerInstance[]>([]);
  const [data, setData] = useState<MapComplex[]>([]);
  const [failed, setFailed] = useState(false);
  const pickRef = useRef(onSelect);
  useEffect(() => {
    pickRef.current = onSelect;
  }, [onSelect]);

  const ids = useMemo(() => new Set(complexes.map((c) => c.complexId)), [complexes]);
  const pts = useMemo(() => complexes.filter((c) => c.lat != null && c.lng != null) as Array<Pt & { lat: number; lng: number }>, [complexes]);

  // 지도 만들고 동 단지가 다 들어오게 맞춘 뒤, 그 범위의 단지 가격을 메인 지도 API로 받는다
  useEffect(() => {
    if (!pts.length || !hostRef.current || mapRef.current) return;
    let cancelled = false;
    void (async () => {
      const loaded = await loadNaverMapsSdk();
      if (cancelled || !loaded.ok || !hostRef.current) {
        if (!loaded.ok) setFailed(true);
        return;
      }
      const maps = loaded.naver.maps;
      const lat = pts.reduce((s, c) => s + c.lat, 0) / pts.length;
      const lng = pts.reduce((s, c) => s + c.lng, 0) / pts.length;
      const map = new maps.Map(hostRef.current, {
        center: new maps.LatLng(lat, lng),
        zoom: 15,
        zoomControl: false,
        scaleControl: false,
        mapDataControl: false,
      }) as MapWithBounds;
      mapRef.current = map;
      const lats = pts.map((c) => c.lat);
      const lngs = pts.map((c) => c.lng);
      map.fitBounds?.(
        new maps.LatLngBounds(
          new maps.LatLng(Math.min(...lats), Math.min(...lngs)),
          new maps.LatLng(Math.max(...lats), Math.max(...lngs)),
        ),
        { top: 60, right: 30, bottom: 20, left: 30 },
      );
      // 동이 넓어도 메인 지도 API 범위 안(약 0.12°)에서 받도록 동 범위로 직접 묻는다
      const pad = 0.004;
      const qs = new URLSearchParams({
        swLat: (Math.min(...lats) - pad).toFixed(4),
        swLng: (Math.min(...lngs) - pad).toFixed(4),
        neLat: (Math.max(...lats) + pad).toFixed(4),
        neLng: (Math.max(...lngs) + pad).toFixed(4),
        areaMin: "0",
        areaMax: "10000",
        deal: "trade",
      });
      try {
        const res = await fetch(`/api/map/complexes?${qs}`);
        const json = (await res.json()) as { status: string; complexes?: MapComplex[] };
        if (!cancelled && json.status === "ok") setData(json.complexes ?? []);
      } catch {
        /* 마커 없이 지도만 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pts]);

  useEffect(
    () => () => {
      for (const m of markersRef.current) m.setMap(null);
      mapRef.current?.destroy?.();
      mapRef.current = null;
    },
    [],
  );

  // 이 동 단지만, 메인 지도와 같은 마커로
  useEffect(() => {
    const map = mapRef.current;
    const maps = window.naver?.maps;
    if (!map || !maps) return;
    for (const m of markersRef.current) m.setMap(null);
    markersRef.current = [];
    for (const c of data) {
      if (!ids.has(c.complexId)) continue;
      const marker = new maps.Marker({
        position: new maps.LatLng(c.lat, c.lng),
        map,
        icon: { content: complexMarkerHtml(c, c.complexId === selectedId, "price"), anchor: new maps.Point(0, 0) },
        zIndex: c.complexId === selectedId ? 100 : c.priceMan == null ? 1 : 10,
      });
      maps.Event.addListener(marker, "click", () => pickRef.current(c.complexId));
      markersRef.current.push(marker);
    }
  }, [data, ids, selectedId]);

  const openMain = () => {
    const map = mapRef.current;
    if (map) {
      const c = map.getCenter();
      try {
        window.localStorage.setItem(LAST_VIEW_KEY, JSON.stringify({ lat: c.y, lng: c.x, zoom: Math.max(14, map.getZoom()) }));
      } catch {
        /* ignore */
      }
    }
    router.push("/map");
  };

  if (failed) return <p className="detail-meta">지도를 불러오지 못했어요.</p>;
  return (
    <div className="relative h-full w-full">
      <div ref={hostRef} className="h-full w-full" role="application" aria-label={ariaLabel} />
      <button
        type="button"
        onClick={openMain}
        className="absolute right-2 top-2 z-10 rounded-full bg-white/95 px-3 py-1.5 text-[12px] font-semibold text-[color:var(--lab-navy-950)] shadow-[0_2px_8px_rgba(15,23,42,0.18)] active:scale-95"
      >
        지도에서 크게 보기 ›
      </button>
    </div>
  );
}

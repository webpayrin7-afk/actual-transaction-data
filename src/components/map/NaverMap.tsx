"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  getNaverMapClientId,
  loadNaverMapsSdk,
  type NaverMapInstance,
  type NaverMarkerInstance,
} from "@/lib/nearby-map/naver-sdk";
import type { LatLng } from "@/lib/nearby-map/geo";

export type NaverMapMarker = {
  id: string;
  position: LatLng;
  title: string;
  kind: "COMPLEX" | "SCHOOL" | "TRANSIT" | "LIVING" | "MEDICAL" | "OTHER";
  selected?: boolean;
};

type NaverMapProps = {
  center: LatLng;
  zoom?: number;
  markers?: NaverMapMarker[];
  selectedId?: string | null;
  onMarkerClick?: (id: string) => void;
  className?: string;
  style?: CSSProperties;
  ariaLabel?: string;
};

const KIND_COLOR: Record<NaverMapMarker["kind"], string> = {
  COMPLEX: "#0f766e",
  SCHOOL: "#1d4ed8",
  TRANSIT: "#b45309",
  LIVING: "#047857",
  MEDICAL: "#be123c",
  OTHER: "#475569",
};

function markerIconHtml(kind: NaverMapMarker["kind"], selected: boolean) {
  const color = selected ? "#0f766e" : KIND_COLOR[kind];
  // Subway (TRANSIT) outranks bus/other POIs visually.
  const size = selected
    ? 14
    : kind === "COMPLEX"
      ? 12
      : kind === "TRANSIT"
        ? 11
        : 9;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size * 2}" height="${size * 2}" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="${color}" stroke="#fff" stroke-width="2"/></svg>`;
  return {
    content: svg,
    anchor: window.naver?.maps
      ? new window.naver.maps.Point(size, size)
      : undefined,
  };
}

/**
 * Reusable NAVER Web Dynamic Map.
 * Client-only, single SDK inject, hydration-safe.
 */
export function NaverMap({
  center,
  zoom = 16,
  markers = [],
  selectedId = null,
  onMarkerClick,
  className = "",
  style,
  ariaLabel = "지도",
}: NaverMapProps) {
  const reactId = useId();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<NaverMapInstance | null>(null);
  const markerMapRef = useRef<Map<string, NaverMarkerInstance>>(new Map());
  const onMarkerClickRef = useRef(onMarkerClick);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    onMarkerClickRef.current = onMarkerClick;
  }, [onMarkerClick]);

  useEffect(() => {
    let cancelled = false;
    const started = performance.now();

    (async () => {
      if (!getNaverMapClientId()) {
        if (!cancelled) {
          setStatus("error");
          setError(
            "NEXT_PUBLIC_NAVER_MAP_CLIENT_ID가 없어 지도를 불러올 수 없습니다."
          );
        }
        return;
      }
      const loaded = await loadNaverMapsSdk();
      if (cancelled) return;
      if (!loaded.ok) {
        setStatus("error");
        setError(loaded.reason);
        return;
      }
      if (!hostRef.current || !window.naver?.maps) {
        setStatus("error");
        setError("지도 컨테이너 초기화 실패");
        return;
      }

      const maps = window.naver.maps;
      const map = new maps.Map(hostRef.current, {
        center: new maps.LatLng(center.lat, center.lng),
        zoom,
        zoomControl: true,
        zoomControlOptions: {
          position: maps.Position?.TOP_LEFT,
        },
      });
      mapRef.current = map;
      setStatus("ready");
      if (process.env.NODE_ENV !== "production") {
        console.info(
          "[NaverMap] ready in",
          Math.round(performance.now() - started),
          "ms"
        );
      }
    })();

    return () => {
      cancelled = true;
      for (const m of markerMapRef.current.values()) {
        m.setMap(null);
      }
      markerMapRef.current.clear();
      try {
        mapRef.current?.destroy?.();
      } catch {
        /* ignore */
      }
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const maps = window.naver?.maps;
    if (!map || !maps || status !== "ready") return;
    map.setCenter(new maps.LatLng(center.lat, center.lng));
  }, [center.lat, center.lng, status]);

  useEffect(() => {
    const map = mapRef.current;
    const maps = window.naver?.maps;
    if (!map || !maps || status !== "ready") return;

    const nextIds = new Set(markers.map((m) => m.id));
    for (const [id, marker] of markerMapRef.current) {
      if (!nextIds.has(id)) {
        marker.setMap(null);
        markerMapRef.current.delete(id);
      }
    }

    for (const item of markers) {
      const selected = Boolean(item.selected || item.id === selectedId);
      const pos = new maps.LatLng(item.position.lat, item.position.lng);
      const existing = markerMapRef.current.get(item.id);
      if (existing) {
        existing.setPosition(pos);
        existing.setIcon?.(markerIconHtml(item.kind, selected));
        continue;
      }
      const marker = new maps.Marker({
        position: pos,
        map,
        title: item.title,
        icon: markerIconHtml(item.kind, selected),
        zIndex: selected || item.kind === "COMPLEX" ? 100 : 10,
      });
      maps.Event.addListener(marker, "click", () => {
        onMarkerClickRef.current?.(item.id);
      });
      markerMapRef.current.set(item.id, marker);
    }

    if (selectedId) {
      const selected = markers.find((m) => m.id === selectedId);
      if (selected) {
        map.panTo(
          new maps.LatLng(selected.position.lat, selected.position.lng)
        );
      }
    }
  }, [markers, selectedId, status]);

  return (
    <div
      className={`relative overflow-hidden rounded-xl bg-slate-50 ${className}`.trim()}
      style={style}
    >
      <div
        ref={hostRef}
        id={`naver-map-${reactId}`}
        role="region"
        aria-label={ariaLabel}
        className="h-full min-h-[220px] w-full"
      />
      {status === "loading" ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-white/70 text-sm text-slate-600">
          지도 불러오는 중…
        </div>
      ) : null}
      {status === "error" ? (
        <div className="absolute inset-0 flex items-center justify-center bg-white px-4 text-center text-sm text-slate-600">
          {error || "지도를 표시할 수 없습니다."}
        </div>
      ) : null}
    </div>
  );
}

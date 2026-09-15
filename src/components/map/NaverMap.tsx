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
  /** Compact always-visible label (COMPLEX). */
  label?: string;
  /** Optional line badge text for TRANSIT (e.g. "2"). */
  badge?: string;
  /** Override fill color (e.g. subway line color). */
  color?: string;
  /** OTHER subtype — bus stop pictogram instead of a plain dot. */
  variant?: "bus-stop";
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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Marker visual hierarchy: COMPLEX > TRANSIT (subway) > OTHER (bus-stop).
 * COMPLEX: building icon + always-visible name (not a plain dot).
 * Pixel anchors only — never shift source lat/lng.
 */
function markerIconHtml(marker: NaverMapMarker, selected: boolean) {
  const kind = marker.kind;
  const color =
    marker.color ||
    (selected && kind === "COMPLEX" ? "#0f766e" : KIND_COLOR[kind]);

  if (kind === "COMPLEX") {
    const name = escapeHtml(marker.label || marker.title || "");
    const fill = selected ? "#0f766e" : KIND_COLOR.COMPLEX;
    // Stack: name above icon, pointer tip on LatLng (pixel anchor only).
    const html = `<div style="display:flex;flex-direction:column;align-items:center;transform:translate(-50%,-100%);white-space:nowrap;pointer-events:none">
      <span style="font:600 12px/1.2 system-ui,-apple-system,sans-serif;color:#0f172a;background:rgba(255,255,255,.94);padding:3px 7px;border-radius:6px;border:1px solid rgba(15,23,42,.12);box-shadow:0 1px 2px rgba(15,23,42,.12);margin-bottom:4px">${name}</span>
      <div style="display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:8px;background:${fill};border:2px solid #fff;box-shadow:0 1px 3px rgba(15,23,42,.28)">
        <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"/><path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/><path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"/><path d="M10 6h4"/><path d="M10 10h4"/><path d="M10 14h4"/><path d="M10 18h4"/></svg>
      </div>
      <div style="width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;border-top:6px solid ${fill};filter:drop-shadow(0 1px 1px rgba(15,23,42,.2))"></div>
    </div>`;
    return {
      content: html,
      anchor: window.naver?.maps
        ? new window.naver.maps.Point(0, 0)
        : undefined,
    };
  }

  if (kind === "TRANSIT") {
    const badge = escapeHtml(
      (marker.badge || "").replace(/호선$/, "") || "역",
    );
    const label = escapeHtml(
      (marker.label || marker.title || "").replace(/역$/, ""),
    );
    const fill = marker.color || KIND_COLOR.TRANSIT;
    const ring = selected ? "2px solid #0f766e" : "2px solid #fff";
    // Centered badge on coordinate (subway station point).
    const html = `<div style="display:flex;flex-direction:column;align-items:center;gap:2px;transform:translate(-50%,-50%);white-space:nowrap;pointer-events:none">
      <div style="min-width:22px;height:22px;padding:0 5px;border-radius:999px;background:${fill};border:${ring};box-shadow:0 1px 2px rgba(15,23,42,.25);display:flex;align-items:center;justify-content:center;font:700 11px/1 system-ui,-apple-system,sans-serif;color:#fff">${badge}</div>
      <span style="font:600 10px/1.1 system-ui,-apple-system,sans-serif;color:#1e293b;background:rgba(255,255,255,.92);padding:1px 4px;border-radius:4px;border:1px solid rgba(15,23,42,.1)">${label}</span>
    </div>`;
    return {
      content: html,
      anchor: window.naver?.maps
        ? new window.naver.maps.Point(0, 0)
        : undefined,
    };
  }

  // Bus stop — stop-sign pictogram (not a plain grey dot; not a vehicle emoji)
  if (kind === "OTHER" && marker.variant === "bus-stop") {
    const fill = selected ? "#0f766e" : "#1e3a5f";
    const html = `<div style="display:flex;flex-direction:column;align-items:center;transform:translate(-50%,-100%);pointer-events:none">
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;width:20px;padding:2px 0 0;border-radius:4px;background:#fff;border:1.5px solid ${fill};box-shadow:0 1px 2px rgba(15,23,42,.22)">
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="${fill}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="10" rx="1.5"/><path d="M8 13v5"/><path d="M16 13v5"/><path d="M6 21h4"/><path d="M14 21h4"/><path d="M8 7h8"/><path d="M8 10h5"/></svg>
        <span style="font:700 7px/1 system-ui,-apple-system,sans-serif;color:${fill};letter-spacing:.02em;padding:1px 0 2px">BUS</span>
      </div>
      <div style="width:2px;height:6px;background:${fill};opacity:.9"></div>
    </div>`;
    return {
      content: html,
      anchor: window.naver?.maps
        ? new window.naver.maps.Point(0, 0)
        : undefined,
    };
  }

  // Generic other — small weak dot
  const size = selected ? 10 : 7;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size * 2}" height="${size * 2}" viewBox="0 0 24 24"><circle cx="12" cy="12" r="7" fill="${color}" stroke="#fff" stroke-width="2" opacity="0.92"/></svg>`;
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
      const zIndex =
        item.kind === "COMPLEX"
          ? 120
          : item.kind === "TRANSIT"
            ? selected
              ? 90
              : 60
            : selected
              ? 50
              : 20;
      const existing = markerMapRef.current.get(item.id);
      if (existing) {
        existing.setPosition(pos);
        existing.setIcon?.(markerIconHtml(item, selected));
        continue;
      }
      const marker = new maps.Marker({
        position: pos,
        map,
        title: item.title,
        icon: markerIconHtml(item, selected),
        zIndex,
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

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
import { haversineMeters, type LatLng } from "@/lib/nearby-map/geo";

/** Living map height CSS transition (~280ms) — re-fit after layout settles. */
const FIT_LAYOUT_SETTLE_MS = 300;
/**
 * Apartment-centered fit covers in-radius living markers (~3km) so the
 * view is not over-shrunk. Farther leftover markers are not expected.
 */
const FIT_COVER_MAX_M = 3000;

export type LivingMarkerCategory =
  | "MART"
  | "HOSPITAL"
  | "PHARMACY"
  | "CONVENIENCE"
  | "PARK"
  | "CAFE"
  | "RESTAURANT";

export type NaverMapMarker = {
  id: string;
  position: LatLng;
  title: string;
  kind: "COMPLEX" | "SCHOOL" | "TRANSIT" | "LIVING" | "MEDICAL" | "OTHER";
  /** Optional compact label (TRANSIT / SCHOOL). COMPLEX does not show a name label. */
  label?: string;
  /** Optional line badge text for TRANSIT (e.g. "2"). */
  badge?: string;
  /** Override fill color (e.g. subway line color). */
  color?: string;
  /** Multiple subway line badges (interchange). */
  badges?: Array<{ text: string; color: string }>;
  /** OTHER subtype — bus stop pictogram instead of a plain dot. */
  variant?: "bus-stop";
  /** Living POI category — icon shape distinguishes category (not rainbow colors). */
  livingCategory?: LivingMarkerCategory;
  /** HOSPITAL 종합병원 — same family, slightly larger ring. */
  hospitalEmphasis?: boolean;
  /** School level badge (초/중/고) — same family marker, text distinguishes level. */
  schoolLevel?: "ELEMENTARY" | "MIDDLE" | "HIGH";
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
  /**
   * When this token changes, zoom so all markers are visible while keeping
   * `fitAnchor` (or `center`) as the geometric center.
   */
  fitBoundsToken?: string | null;
  /** Preferred center when fitting (e.g. complex). Falls back to `center`. */
  fitAnchor?: LatLng | null;
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

/** Lucide `Bus` paths — same glyph as the transport list row icon. */
const LUCIDE_BUS_SVG = (stroke: string, size = 12) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6v6"/><path d="M15 6v6"/><path d="M2 12h19.6"/><path d="M18 18h3s.5-1.7.8-2.8c.1-.4.2-.8.2-1.2 0-.4-.1-.8-.2-1.2l-1.4-5C20.1 6.8 19.1 6 18 6H4a2 2 0 0 0-2 2v10h3"/><circle cx="7" cy="18" r="2"/><path d="M9 18h5"/><circle cx="16" cy="18" r="2"/></svg>`;

/** Living category glyphs — shape distinguishes category; color stays navy/teal. */
const LIVING_ICON_SVG: Record<
  LivingMarkerCategory,
  (stroke: string, size?: number) => string
> = {
  MART: (stroke, size = 12) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/></svg>`,
  HOSPITAL: (stroke, size = 12) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 6v4"/><path d="M14 14h-4"/><path d="M14 18h-4"/><path d="M14 8h-4"/><path d="M18 12h2a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2h2"/><path d="M18 22V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v18"/></svg>`,
  PHARMACY: (stroke, size = 12) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m10.5 20.5 10-10a4.95 4.95 0 1 0-7-7l-10 10a4.95 4.95 0 1 0 7 7Z"/><path d="m8.5 8.5 7 7"/></svg>`,
  CONVENIENCE: (stroke, size = 12) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m2 7 4.41-4.41A2 2 0 0 1 7.83 2h8.34a2 2 0 0 1 1.42.59L22 7"/><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="M15 22v-4a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4"/><path d="M2 7h20"/><path d="M22 7v3a2 2 0 0 1-2 2a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 16 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 12 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 8 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 4 12a2 2 0 0 1-2-2V7"/></svg>`,
  PARK: (stroke, size = 12) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 10v.2A3 3 0 0 1 8.9 16H5a3 3 0 0 1-1-5.8V10a3 3 0 0 1 6 0Z"/><path d="M7 16v6"/><path d="M13 19v3"/><path d="M12 19h8.3a1 1 0 0 0 .7-1.7L18 14h.3a1 1 0 0 0 .7-1.7L16 9h.2a1 1 0 0 0 .8-1.7L13 3l-1.4 1.5"/></svg>`,
  /** Lucide Coffee — commerce café. */
  CAFE: (stroke, size = 12) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2v2"/><path d="M14 2v2"/><path d="M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1"/><path d="M6 2v2"/></svg>`,
  /** Lucide UtensilsCrossed — commerce restaurant. */
  RESTAURANT: (stroke, size = 12) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 2-2.3 2.3a3 3 0 0 0 0 4.2l1.8 1.8a3 3 0 0 0 4.2 0L22 8"/><path d="M15 15 3.3 3.3a4.2 4.2 0 0 0 0 6l7.3 7.3c.7.7 2 .7 2.8 0L15 15Zm0 0 7 7"/><path d="m2.1 21.8 6.4-6.3"/><path d="m19 5-7 7"/></svg>`,
};

/**
 * Downward selection arrow that bounces vertically above a marker.
 * Shown when a list row (or marker) is selected.
 */
function selectionArrowHtml(): string {
  return `<style>@keyframes ziplab-marker-bounce{0%,100%{transform:translateY(0)}50%{transform:translateY(10px)}}</style><div style="display:flex;justify-content:center;margin-bottom:5px;animation:ziplab-marker-bounce .85s ease-in-out infinite;will-change:transform"><svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 17L5.5 9.5h13L12 17z" fill="#0f766e"/><path d="M12 17L5.5 9.5h13L12 17z" fill="none" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/></svg></div>`;
}

/**
 * Marker visual hierarchy: COMPLEX > selected living > transit/other.
 * COMPLEX: building icon only (no apartment-name text label).
 * Pixel anchors only — never shift source lat/lng.
 */
function markerIconHtml(marker: NaverMapMarker, selected: boolean) {
  const kind = marker.kind;
  const color =
    marker.color ||
    (selected && kind === "COMPLEX" ? "#0f766e" : KIND_COLOR[kind]);

  if (kind === "COMPLEX") {
    // Building icon only — no apartment-name text label on the map.
    const fill = selected ? "#0f766e" : KIND_COLOR.COMPLEX;
    const html = `<div style="display:flex;flex-direction:column;align-items:center;transform:translate(-50%,-100%);white-space:nowrap;pointer-events:none">
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
    const badgeItems =
      marker.badges && marker.badges.length > 0
        ? marker.badges
        : [
            {
              text: (marker.badge || "").replace(/호선$/, "") || "역",
              color: marker.color || KIND_COLOR.TRANSIT,
            },
          ];
    const label = escapeHtml(
      (marker.label || marker.title || "").replace(/역$/, ""),
    );
    const ring = selected ? "2px solid #0f766e" : "1.5px solid rgba(15,23,42,.28)";
    const badgesHtml = badgeItems
      .map((b) => {
        const text = escapeHtml(b.text.replace(/호선$/, "") || "역");
        const fill = b.color || KIND_COLOR.TRANSIT;
        return `<div style="min-width:20px;height:20px;padding:0 5px;border-radius:999px;background:${fill};border:${ring};box-shadow:0 1px 2px rgba(15,23,42,.25);display:flex;align-items:center;justify-content:center;font:700 10px/1 system-ui,-apple-system,sans-serif;color:#fff">${text}</div>`;
      })
      .join("");
    const html = `<div style="display:flex;flex-direction:column;align-items:center;gap:2px;transform:translate(-50%,-50%);white-space:nowrap;pointer-events:none">
      ${selected ? selectionArrowHtml() : ""}
      <div style="display:flex;align-items:center;gap:2px">${badgesHtml}</div>
      <span style="font:600 10px/1.1 system-ui,-apple-system,sans-serif;color:#1e293b;background:rgba(255,255,255,.92);padding:1px 4px;border-radius:4px;border:1px solid rgba(15,23,42,.1)">${label}</span>
    </div>`;
    return {
      content: html,
      anchor: window.naver?.maps
        ? new window.naver.maps.Point(0, 0)
        : undefined,
    };
  }

  if (kind === "OTHER" && marker.variant === "bus-stop") {
    const stroke = selected ? "#0f766e" : "#1e3a5f";
    const border = selected ? "#0f766e" : "#cbd5e1";
    const html = `<div style="display:flex;flex-direction:column;align-items:center;transform:translate(-50%,-100%);pointer-events:none">
      ${selected ? selectionArrowHtml() : ""}
      <div style="display:flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:4px;background:#fff;border:1px solid ${border};box-shadow:0 1px 2px rgba(15,23,42,.18);color:${stroke}">
        ${LUCIDE_BUS_SVG(stroke, 12)}
      </div>
      <div style="width:2px;height:6px;background:${stroke};opacity:.9"></div>
    </div>`;
    return {
      content: html,
      anchor: window.naver?.maps
        ? new window.naver.maps.Point(0, 0)
        : undefined,
    };
  }

  if (kind === "LIVING" || kind === "MEDICAL") {
    const cat: LivingMarkerCategory =
      marker.livingCategory || (kind === "MEDICAL" ? "HOSPITAL" : "MART");
    const emphasis = Boolean(marker.hospitalEmphasis && cat === "HOSPITAL");
    const stroke = selected ? "#0f766e" : "#1e3a5f";
    const border = selected ? "#0f766e" : emphasis ? "#1e3a5f" : "#94a3b8";
    const ring = selected
      ? "2px solid #0f766e"
      : emphasis
        ? "2px solid #1e3a5f"
        : `1px solid ${border}`;
    const box = emphasis ? 26 : 22;
    const iconSize = emphasis ? 15 : 13;
    const iconFn = LIVING_ICON_SVG[cat] || LIVING_ICON_SVG.MART;
    const badge = emphasis
      ? `<span style="margin-top:2px;font:700 8px/1 system-ui,-apple-system,sans-serif;color:#1e3a5f;background:rgba(255,255,255,.94);padding:1px 3px;border-radius:3px;border:1px solid rgba(30,58,95,.22)">종합</span>`
      : "";
    const html = `<div style="display:flex;flex-direction:column;align-items:center;transform:translate(-50%,-100%);pointer-events:none">
      ${selected ? selectionArrowHtml() : ""}
      <div style="display:flex;align-items:center;justify-content:center;width:${box}px;height:${box}px;border-radius:6px;background:#fff;border:${ring};box-shadow:0 1px 2px rgba(15,23,42,.16)">
        ${iconFn(stroke, iconSize)}
      </div>
      ${badge}
      <div style="width:2px;height:5px;background:${stroke};opacity:.85"></div>
    </div>`;
    return {
      content: html,
      anchor: window.naver?.maps
        ? new window.naver.maps.Point(0, 0)
        : undefined,
    };
  }


  if (kind === "SCHOOL") {
    const stroke = selected ? "#0f766e" : "#1e3a5f";
    const border = selected ? "#0f766e" : "#94a3b8";
    const ring = selected ? "2px solid #0f766e" : `1px solid ${border}`;
    const badge =
      marker.schoolLevel === "MIDDLE"
        ? "중"
        : marker.schoolLevel === "HIGH"
          ? "고"
          : "초";
    const label = escapeHtml((marker.label || marker.title || "").trim());
    const html = `<div style="display:flex;flex-direction:column;align-items:center;transform:translate(-50%,-100%);pointer-events:none;white-space:nowrap">
      ${selected ? selectionArrowHtml() : ""}
      <div style="display:flex;align-items:center;gap:3px;padding:2px 5px 2px 2px;border-radius:8px;background:#fff;border:${ring};box-shadow:0 1px 2px rgba(15,23,42,.16)">
        <span style="display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;border-radius:5px;background:#1e3a5f;color:#fff;font:700 10px/1 system-ui,-apple-system,sans-serif">${badge}</span>
        <span style="font:600 10px/1.1 system-ui,-apple-system,sans-serif;color:#1e293b;max-width:88px;overflow:hidden;text-overflow:ellipsis">${label}</span>
      </div>
      <div style="width:2px;height:5px;background:${stroke};opacity:.85"></div>
    </div>`;
    return {
      content: html,
      anchor: window.naver?.maps
        ? new window.naver.maps.Point(0, 0)
        : undefined,
    };
  }

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
 * Parent height transitions must not remount this component.
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
  fitBoundsToken = null,
  fitAnchor = null,
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
        zoomControl: false,
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

  // Keep tiles/layout correct when the parent animates container height.
  useEffect(() => {
    if (status !== "ready") return;
    const host = hostRef.current;
    const map = mapRef.current;
    const maps = window.naver?.maps;
    if (!host || !map || !maps) return;

    const triggerResize = () => {
      try {
        maps.Event.trigger?.(map, "resize");
      } catch {
        /* ignore */
      }
    };

    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            triggerResize();
          })
        : null;
    ro?.observe(host);
    triggerResize();

    return () => {
      ro?.disconnect();
    };
  }, [status]);

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
      // Selected marker always on top so list-focus is not covered by neighbors.
      const zIndex = selected
        ? 200
        : item.kind === "COMPLEX"
          ? 120
          : item.kind === "LIVING" || item.kind === "MEDICAL"
            ? 55
            : item.kind === "TRANSIT"
              ? 60
              : item.kind === "SCHOOL"
                ? 50
                : 20;
      const existing = markerMapRef.current.get(item.id);
      if (existing) {
        existing.setPosition(pos);
        existing.setIcon?.(markerIconHtml(item, selected));
        existing.setZIndex?.(zIndex);
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

  // Category / set change: apartment-centered zoom with morph animation.
  useEffect(() => {
    const map = mapRef.current;
    const maps = window.naver?.maps;
    if (!map || !maps || status !== "ready") return;
    if (!fitBoundsToken) return;

    const anchor = fitAnchor ?? center;
    const anchorLatLng = new maps.LatLng(anchor.lat, anchor.lng);
    const poi = markers.filter((m) => m.id !== "complex");

    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;

    const estimateZoom = (latDelta: number, lngDelta: number): number => {
      const cos = Math.max(0.25, Math.cos((anchor.lat * Math.PI) / 180));
      const host = hostRef.current;
      let width = 360;
      let height = 320;
      // Prefer host box (tracks CSS height transition) over stale map.getSize().
      if (host && host.clientWidth > 0) width = host.clientWidth;
      else {
        try {
          const size = map.getSize?.();
          if (size && Number.isFinite(size.width) && size.width > 0) {
            width = size.width;
          }
        } catch {
          /* keep fallback */
        }
      }
      if (host && host.clientHeight > 0) height = host.clientHeight;
      else {
        try {
          const size = map.getSize?.();
          if (size && Number.isFinite(size.height) && size.height > 0) {
            height = size.height;
          }
        } catch {
          /* keep fallback */
        }
      }
      const usableW = Math.max(120, width - 48);
      const usableH = Math.max(120, height - 56);
      const northM = Math.max(latDelta * 111320, 40);
      const eastM = Math.max(lngDelta * 111320 * cos, 40);
      const mpp = Math.max((2 * eastM) / usableW, (2 * northM) / usableH);
      const z = Math.log2((156543.03392 * cos) / mpp);
      return Math.max(12, Math.min(16, Math.round(z)));
    };

    const animateTo = (targetZoom: number) => {
      const z = Math.max(11, Math.min(18, targetZoom));
      try {
        map.stop?.();
      } catch {
        /* ignore */
      }
      try {
        maps.Event.trigger?.(map, "resize");
      } catch {
        /* ignore */
      }
      if (reduceMotion || typeof map.morph !== "function") {
        map.setCenter(anchorLatLng);
        map.setZoom?.(z);
        return;
      }
      map.morph(anchorLatLng, z, {
        duration: 560,
        easing: "easeOutCubic",
      });
    };

    const runFit = () => {
      if (poi.length === 0) {
        animateTo(zoom);
        return;
      }

      let maxLatDelta = 0;
      let maxLngDelta = 0;
      let anyInCover = false;
      for (const m of poi) {
        const distM = haversineMeters(anchor, m.position);
        // Soft cover: keep apartment context within living radius band.
        if (Number.isFinite(distM) && distM > FIT_COVER_MAX_M) continue;
        anyInCover = true;
        maxLatDelta = Math.max(
          maxLatDelta,
          Math.abs(m.position.lat - anchor.lat),
        );
        maxLngDelta = Math.max(
          maxLngDelta,
          Math.abs(m.position.lng - anchor.lng),
        );
      }
      if (!anyInCover) {
        for (const m of poi) {
          maxLatDelta = Math.max(
            maxLatDelta,
            Math.abs(m.position.lat - anchor.lat),
          );
          maxLngDelta = Math.max(
            maxLngDelta,
            Math.abs(m.position.lng - anchor.lng),
          );
        }
      }
      const pad = 1.1;
      const latDelta = Math.max(maxLatDelta * pad, 0.0012);
      const lngDelta = Math.max(maxLngDelta * pad, 0.0012);
      animateTo(estimateZoom(latDelta, lngDelta));
    };

    let cancelled = false;
    let fitted = false;
    let settleTimer: number | null = null;
    let rafOuter = 0;
    let rafInner = 0;

    const runFitOnce = () => {
      if (cancelled || fitted) return;
      fitted = true;
      runFit();
    };

    // Avoid double morph: do not fit on the first paint with transport-sized
    // height (that over-shrinks, then a second fit corrects). Wait for the
    // living height transition when the box is still short; otherwise fit
    // on the next frame (in-living chip change).
    const hostH = hostRef.current?.clientHeight ?? 0;
    const needsLayoutSettle = hostH > 0 && hostH < 300;
    if (needsLayoutSettle) {
      settleTimer = window.setTimeout(runFitOnce, FIT_LAYOUT_SETTLE_MS);
    } else {
      rafOuter = window.requestAnimationFrame(() => {
        rafInner = window.requestAnimationFrame(runFitOnce);
      });
    }

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(rafOuter);
      window.cancelAnimationFrame(rafInner);
      if (settleTimer != null) window.clearTimeout(settleTimer);
    };
    // Only re-fit when the token changes (category / marker set), not on selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitBoundsToken, status]);

  const zoomBy = (delta: number) => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    const current =
      typeof map.getZoom === "function" ? map.getZoom() : undefined;
    if (typeof current !== "number" || typeof map.setZoom !== "function") return;
    map.setZoom(Math.max(1, Math.min(21, current + delta)));
  };

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
      {status === "ready" ? (
        <div className="absolute bottom-3 left-3 z-[5] flex flex-col overflow-hidden rounded-md border border-slate-200/90 bg-white shadow-sm">
          <button
            type="button"
            aria-label="지도 확대"
            onClick={() => zoomBy(1)}
            className="flex h-8 w-8 items-center justify-center text-[16px] font-medium leading-none text-slate-700 hover:bg-slate-50 active:bg-slate-100"
          >
            +
          </button>
          <div className="h-px bg-slate-200" />
          <button
            type="button"
            aria-label="지도 축소"
            onClick={() => zoomBy(-1)}
            className="flex h-8 w-8 items-center justify-center text-[16px] font-medium leading-none text-slate-700 hover:bg-slate-50 active:bg-slate-100"
          >
            −
          </button>
        </div>
      ) : null}
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

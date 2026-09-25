"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  getNaverMapClientId,
  isNaverMapAuthFailed,
  loadNaverMapsSdk,
  NAVER_AUTH_FAILURE_EVENT,
  NAVER_AUTH_FAILURE_MESSAGE,
  type NaverMapInstance,
  type NaverMarkerInstance,
  type NaverCircleInstance,
  type NaverOverlayViewInstance,
  type NaverMapsApi,
} from "@/lib/nearby-map/naver-sdk";
import { haversineMeters, type LatLng } from "@/lib/nearby-map/geo";
import type { CommerceMapPoints } from "@/lib/complex-detail/commerce-snapshot";
import { commerceCategoryColorByIndex } from "@/lib/complex-detail/commerce-category-colors";

/** Living map height CSS transition (~280ms) — re-fit after layout settles. */
const FIT_LAYOUT_SETTLE_MS = 300;
/**
 * Apartment-centered fit covers in-radius living markers (~3km) so the
 * view is not over-shrunk. Farther leftover markers are not expected.
 */
const FIT_COVER_MAX_M_LIVING = 3000;
/** Commerce / school display radius is 1.5km — tighter cover so tab switch zooms in. */
const FIT_COVER_MAX_M_NEARBY = 1600;

/** Canvas point size — color from shared commerce category tokens (U4). */
const POINT_CLOUD_CSS_PX = 2.5;
const POINT_CLOUD_FALLBACK_FILL = "rgba(47, 122, 115, 0.38)";

function fitCoverMaxM(token: string): number {
  if (token.startsWith("commerce:") || token.startsWith("school:")) {
    return FIT_COVER_MAX_M_NEARBY;
  }
  return FIT_COVER_MAX_M_LIVING;
}

function meterOffsetToLatLng(
  originLat: number,
  originLng: number,
  dxM: number,
  dyM: number,
): LatLng {
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos((originLat * Math.PI) / 180);
  return {
    lat: originLat + dyM / mPerDegLat,
    lng: originLng + dxM / mPerDegLng,
  };
}

/**
 * ONE NAVER OverlayView + ONE canvas drawing SEMAS P2 points.
 * Never creates per-point Marker/Circle/DOM nodes.
 */
function createCommercePointCloudOverlay(
  maps: NaverMapsApi["maps"],
  data: CommerceMapPoints,
): NaverOverlayViewInstance {
  // Prototype subclass — NAVER OverlayView requires onAdd/draw/onRemove.
  type OverlayCtor = new () => NaverOverlayViewInstance & {
    _canvas?: HTMLCanvasElement | null;
    _data: CommerceMapPoints;
  };
  const OverlayViewBase = maps.OverlayView as unknown as {
    new (): NaverOverlayViewInstance;
    prototype: NaverOverlayViewInstance;
  };
  function PointCloudOverlay(this: {
    _canvas: HTMLCanvasElement | null;
    _data: CommerceMapPoints;
  }) {
    OverlayViewBase.call(this as unknown as NaverOverlayViewInstance);
    this._canvas = null;
    this._data = data;
  }
  PointCloudOverlay.prototype = Object.create(OverlayViewBase.prototype);
  PointCloudOverlay.prototype.constructor = PointCloudOverlay;

  PointCloudOverlay.prototype.onAdd = function (this: {
    _canvas: HTMLCanvasElement | null;
    getPanes?: () => { overlayLayer?: HTMLElement };
  }) {
    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    canvas.style.position = "absolute";
    canvas.style.left = "0";
    canvas.style.top = "0";
    canvas.style.pointerEvents = "none";
    canvas.style.zIndex = "1";
    this._canvas = canvas;
    const panes = this.getPanes?.();
    panes?.overlayLayer?.appendChild(canvas);
  };

  PointCloudOverlay.prototype.draw = function (this: {
    _canvas: HTMLCanvasElement | null;
    _data: CommerceMapPoints;
    getMap?: () => NaverMapInstance | null;
    getProjection?: () => {
      fromCoordToOffset: (coord: unknown) => { x: number; y: number };
    };
    getContainerTopLeft?: () => { x: number; y: number };
  }) {
    const map = this.getMap?.();
    const canvas = this._canvas;
    const projection = this.getProjection?.();
    if (!map || !canvas || !projection) return;

    const size = map.getSize?.();
    if (!size || size.width <= 0 || size.height <= 0) return;

    const topLeft = this.getContainerTopLeft?.() ?? { x: 0, y: 0 };
    canvas.style.left = `${topLeft.x}px`;
    canvas.style.top = `${topLeft.y}px`;
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;

    const dpr = Math.min(
      2.5,
      typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1,
    );
    const bw = Math.max(1, Math.round(size.width * dpr));
    const bh = Math.max(1, Math.round(size.height * dpr));
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bh) canvas.height = bh;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.width, size.height);

    const { originLat, originLng, offsetsM, pointCount, categoryIdx } =
      this._data;
    const pad = 4;
    const half = POINT_CLOUD_CSS_PX / 2;
    const max = Math.min(pointCount, Math.floor(offsetsM.length / 2));
    const hasCats =
      Array.isArray(categoryIdx) && categoryIdx.length >= max;

    // Cache fill strings per category index (0..5).
    const fillByCat: string[] = [];
    for (let c = 0; c < 6; c++) {
      fillByCat[c] = commerceCategoryColorByIndex(c).mapFill;
    }

    for (let i = 0; i < max; i++) {
      const dx = offsetsM[i * 2];
      const dy = offsetsM[i * 2 + 1];
      const ll = meterOffsetToLatLng(originLat, originLng, dx, dy);
      const offset = projection.fromCoordToOffset(
        new maps.LatLng(ll.lat, ll.lng),
      );
      const x = offset.x - topLeft.x;
      const y = offset.y - topLeft.y;
      if (
        x < -pad ||
        y < -pad ||
        x > size.width + pad ||
        y > size.height + pad
      ) {
        continue;
      }
      const cat = hasCats ? categoryIdx![i] : -1;
      ctx.fillStyle =
        cat >= 0 && cat < 6 ? fillByCat[cat]! : POINT_CLOUD_FALLBACK_FILL;
      ctx.fillRect(x - half, y - half, POINT_CLOUD_CSS_PX, POINT_CLOUD_CSS_PX);
    }
  };

  PointCloudOverlay.prototype.onRemove = function (this: {
    _canvas: HTMLCanvasElement | null;
  }) {
    this._canvas?.remove();
    this._canvas = null;
  };

  return new (PointCloudOverlay as unknown as OverlayCtor)();
}

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
  /** NEIS code when known — used by school-tab marker → detail navigation. */
  schoolCode?: string | null;
  schoolKind?: string;
  schoolAddress?: string | null;
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
  /**
   * When set (and no POI markers), fit so this radius around the anchor is
   * visible — used by commerce point-cloud (1km).
   */
  fitRadiusM?: number | null;
  /** SEMAS P2 actual point cloud (commerce). Canvas overlay — not Markers. */
  pointCloud?: CommerceMapPoints | null;
  /** Optional thin reference radius (meters) around fitAnchor/center. */
  referenceRadiusM?: number | null;
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
 * 선택된 마커 위 이름 말풍선 — 목록이나 마커를 누르면 그 장소 이름을 띄운다(살짝 튀는 모션).
 */
function selectionBubbleHtml(name: string): string {
  const text = escapeHtml(name.trim());
  if (!text) return selectionArrowHtml();
  return `<style>@keyframes ziplab-marker-bounce{0%,100%{transform:translateY(0)}50%{transform:translateY(4px)}}</style><div style="display:flex;flex-direction:column;align-items:center;margin-bottom:4px;animation:ziplab-marker-bounce .85s ease-in-out infinite;will-change:transform"><div style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:5px 9px;border-radius:8px;background:#0f766e;color:#fff;font:700 12px/1.2 system-ui,-apple-system,sans-serif;box-shadow:0 2px 6px rgba(15,23,42,.28)">${text}</div><div style="width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent;border-top:6px solid #0f766e"></div></div>`;
}

/**
 * Downward selection arrow that bounces vertically above a marker (이름이 없을 때).
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
    // 우리 단지 — 아파트 두 동 모양 핀(평소엔 이름 없이, 누르면 이름 말풍선)
    const fill = KIND_COLOR.COMPLEX;
    const html = `<div data-map-marker-id="${encodeURIComponent(marker.id)}" role="button" style="display:flex;flex-direction:column;align-items:center;transform:translate(-50%,-100%);white-space:nowrap;pointer-events:auto;cursor:pointer;-webkit-tap-highlight-color:transparent">
      ${selected ? selectionBubbleHtml(marker.title || "") : ""}
      <div style="display:flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:10px;background:${fill};border:2px solid #fff;box-shadow:0 2px 5px rgba(15,23,42,.3)">
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="#fff" aria-hidden="true"><path d="M3 21V8.5a1 1 0 0 1 .6-.9l6-2.7a1 1 0 0 1 1.4.9V21Z"/><path d="M12 21V3.6a1 1 0 0 1 1.3-.95l6.9 2.2a1 1 0 0 1 .7.95V21Z"/><g fill="${fill}"><rect x="5" y="10" width="1.8" height="1.8" rx=".3"/><rect x="7.8" y="10" width="1.8" height="1.8" rx=".3"/><rect x="5" y="13.5" width="1.8" height="1.8" rx=".3"/><rect x="7.8" y="13.5" width="1.8" height="1.8" rx=".3"/><rect x="14.2" y="7" width="1.8" height="1.8" rx=".3"/><rect x="17.2" y="7" width="1.8" height="1.8" rx=".3"/><rect x="14.2" y="10.5" width="1.8" height="1.8" rx=".3"/><rect x="17.2" y="10.5" width="1.8" height="1.8" rx=".3"/><rect x="14.2" y="14" width="1.8" height="1.8" rx=".3"/><rect x="17.2" y="14" width="1.8" height="1.8" rx=".3"/></g></svg>
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
    const html = `<div data-map-marker-id="${encodeURIComponent(marker.id)}" role="button" style="display:flex;flex-direction:column;align-items:center;gap:2px;transform:translate(-50%,-50%);white-space:nowrap;pointer-events:auto;cursor:pointer;-webkit-tap-highlight-color:transparent">
      ${selected ? selectionBubbleHtml(marker.title || marker.label || "") : ""}
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
    const html = `<div data-map-marker-id="${encodeURIComponent(marker.id)}" role="button" style="display:flex;flex-direction:column;align-items:center;transform:translate(-50%,-100%);pointer-events:auto;cursor:pointer;-webkit-tap-highlight-color:transparent">
      ${selected ? selectionBubbleHtml(marker.title || marker.label || "") : ""}
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
    const html = `<div data-map-marker-id="${encodeURIComponent(marker.id)}" role="button" style="display:flex;flex-direction:column;align-items:center;transform:translate(-50%,-100%);pointer-events:auto;cursor:pointer;-webkit-tap-highlight-color:transparent">
      ${selected ? selectionBubbleHtml(marker.title || marker.label || "") : ""}
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
    const width = 118;
    const height = 36;
    const markerIdAttr = encodeURIComponent(marker.id);
    // No bounce arrow on school tab — chip border already shows selection.
    const html = `<div data-map-marker-id="${markerIdAttr}" role="button" aria-label="${escapeHtml(marker.title || "학교")} 상세 보기" style="position:relative;width:${width}px;height:${height}px;pointer-events:auto;cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:rgba(15,23,42,.12)">
      <div style="position:absolute;left:50%;bottom:0;display:flex;flex-direction:column;align-items:center;transform:translateX(-50%);white-space:nowrap;pointer-events:auto;cursor:pointer">
        <div style="display:flex;align-items:center;gap:3px;padding:2px 5px 2px 2px;border-radius:8px;background:#fff;border:${ring};box-shadow:0 1px 2px rgba(15,23,42,.16);pointer-events:auto;cursor:pointer">
          <span style="display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;border-radius:5px;background:#1e3a5f;color:#fff;font:700 10px/1 system-ui,-apple-system,sans-serif;pointer-events:none">${badge}</span>
          <span style="font:600 10px/1.1 system-ui,-apple-system,sans-serif;color:#1e293b;max-width:88px;overflow:hidden;text-overflow:ellipsis;pointer-events:none">${label}</span>
        </div>
        <div style="width:2px;height:5px;background:${stroke};opacity:.85;pointer-events:none"></div>
      </div>
    </div>`;
    return {
      content: html,
      size: window.naver?.maps
        ? new window.naver.maps.Size(width, height)
        : undefined,
      anchor: window.naver?.maps
        ? new window.naver.maps.Point(width / 2, height)
        : undefined,
    };
  }

  const size = selected ? 10 : 7;
  const svg = `<svg data-map-marker-id="${encodeURIComponent(marker.id)}" style="pointer-events:auto;cursor:pointer" xmlns="http://www.w3.org/2000/svg" width="${size * 2}" height="${size * 2}" viewBox="0 0 24 24"><circle cx="12" cy="12" r="7" fill="${color}" stroke="#fff" stroke-width="2" opacity="0.92"/></svg>`;
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
  fitRadiusM = null,
  pointCloud = null,
  referenceRadiusM = null,
}: NaverMapProps) {
  const reactId = useId();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<NaverMapInstance | null>(null);
  const markerMapRef = useRef<Map<string, NaverMarkerInstance>>(new Map());
  const pointCloudOverlayRef = useRef<NaverOverlayViewInstance | null>(null);
  const referenceCircleRef = useRef<NaverCircleInstance | null>(null);
  const onMarkerClickRef = useRef(onMarkerClick);
  const markersRef = useRef(markers);
  const fitAnchorRef = useRef(fitAnchor);
  const centerRef = useRef(center);
  const fitRadiusMRef = useRef(fitRadiusM);
  /** Dedupe Marker click + DOM delegation for the same tap. */
  const lastMarkerClickRef = useRef<{ id: string; at: number } | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  const fireMarkerClick = useCallback((id: string) => {
    const now = Date.now();
    const prev = lastMarkerClickRef.current;
    if (prev && prev.id === id && now - prev.at < 450) return;
    lastMarkerClickRef.current = { id, at: now };
    onMarkerClickRef.current?.(id);
  }, []);

  useEffect(() => {
    onMarkerClickRef.current = onMarkerClick;
  }, [onMarkerClick]);

  // Capture-phase delegation on document: school chip/label taps survive
  // Naver HTML cloning and pane placement quirks.
  useEffect(() => {
    if (status !== "ready") return;

    const onPointer = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const hit = target.closest("[data-map-marker-id]");
      if (!(hit instanceof HTMLElement)) return;
      const encoded = hit.getAttribute("data-map-marker-id");
      if (!encoded) return;
      let id = encoded;
      try {
        id = decodeURIComponent(encoded);
      } catch {
        /* keep raw */
      }
      // Only handle markers that belong to this map instance.
      if (!markersRef.current.some((m) => m.id === id)) return;
      event.preventDefault();
      event.stopPropagation();
      fireMarkerClick(id);
    };

    document.addEventListener("click", onPointer, true);
    return () => {
      document.removeEventListener("click", onPointer, true);
    };
  }, [status, fireMarkerClick]);

  useEffect(() => {
    markersRef.current = markers;
  }, [markers]);

  useEffect(() => {
    fitAnchorRef.current = fitAnchor;
  }, [fitAnchor]);

  useEffect(() => {
    fitRadiusMRef.current = fitRadiusM;
  }, [fitRadiusM]);

  useEffect(() => {
    centerRef.current = center;
  }, [center]);

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

      if (isNaverMapAuthFailed()) {
        setStatus("error");
        setError(NAVER_AUTH_FAILURE_MESSAGE);
        return;
      }

      const maps = window.naver.maps;
      let map: NaverMapInstance;
      try {
        map = new maps.Map(hostRef.current, {
          center: new maps.LatLng(center.lat, center.lng),
          zoom,
          zoomControl: false,
        });
      } catch {
        setStatus("error");
        setError("지도를 표시할 수 없습니다.");
        return;
      }
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
      if (pointCloudOverlayRef.current) {
        pointCloudOverlayRef.current.setMap(null);
        pointCloudOverlayRef.current = null;
      }
      if (referenceCircleRef.current) {
        referenceCircleRef.current.setMap(null);
        referenceCircleRef.current = null;
      }
      try {
        mapRef.current?.destroy?.();
      } catch {
        /* ignore */
      }
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // NAVER rejects unregistered origins after the SDK has loaded; drop the map and show why.
  useEffect(() => {
    const onAuthFailure = () => {
      try {
        mapRef.current?.destroy?.();
      } catch {
        /* ignore */
      }
      mapRef.current = null;
      setStatus("error");
      setError(NAVER_AUTH_FAILURE_MESSAGE);
    };
    if (isNaverMapAuthFailed()) onAuthFailure();
    window.addEventListener(NAVER_AUTH_FAILURE_EVENT, onAuthFailure);
    return () => window.removeEventListener(NAVER_AUTH_FAILURE_EVENT, onAuthFailure);
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
                ? 70
                : 20;
      const icon = markerIconHtml(item, selected);
      const existing = markerMapRef.current.get(item.id);
      if (existing) {
        existing.setPosition(pos);
        existing.setIcon?.(icon);
        existing.setZIndex?.(zIndex);
        existing.setClickable?.(true);
        existing.setCursor?.("pointer");
        continue;
      }
      const marker = new maps.Marker({
        position: pos,
        map,
        title: item.title,
        icon,
        zIndex,
        clickable: true,
        cursor: "pointer",
      });
      maps.Event.addListener(marker, "click", () => {
        fireMarkerClick(item.id);
      });
      // NAVER가 씌우는 바깥 상자는 아이콘을 transform으로 옮겨도 제자리(기준점 오른쪽 아래)에 남아
      // 옆 마커 위를 덮고 클릭을 가로챈다 — 바깥 상자는 통과시키고, 보이는 아이콘(data-map-marker-id)만 눌리게.
      const el = (marker as { getElement?: () => HTMLElement | null }).getElement?.();
      if (el) el.style.pointerEvents = "none";
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
  }, [markers, selectedId, status, fireMarkerClick]);

  // Commerce SEMAS P2 point cloud — ONE OverlayView + ONE canvas (no Markers).
  useEffect(() => {
    const map = mapRef.current;
    const maps = window.naver?.maps;
    if (!map || !maps || status !== "ready") return;

    if (pointCloudOverlayRef.current) {
      pointCloudOverlayRef.current.setMap(null);
      pointCloudOverlayRef.current = null;
    }

    if (
      !pointCloud ||
      pointCloud.pointCount <= 0 ||
      !pointCloud.offsetsM?.length ||
      !maps.OverlayView
    ) {
      return;
    }

    const t0 =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    const overlay = createCommercePointCloudOverlay(maps, pointCloud);
    overlay.setMap(map);
    pointCloudOverlayRef.current = overlay;
    if (process.env.NODE_ENV !== "production") {
      const ms =
        (typeof performance !== "undefined" ? performance.now() : Date.now()) -
        t0;
      console.info(
        "[NaverMap] pointCloud overlay ready",
        pointCloud.pointCount,
        "pts in",
        Math.round(ms),
        "ms",
      );
    }

    return () => {
      if (pointCloudOverlayRef.current) {
        pointCloudOverlayRef.current.setMap(null);
        pointCloudOverlayRef.current = null;
      }
    };
  }, [pointCloud, status]);

  // Optional thin 1km reference ring (informational; not an official boundary).
  useEffect(() => {
    const map = mapRef.current;
    const maps = window.naver?.maps;
    if (!map || !maps || status !== "ready") return;

    if (referenceCircleRef.current) {
      referenceCircleRef.current.setMap(null);
      referenceCircleRef.current = null;
    }

    if (referenceRadiusM == null || referenceRadiusM <= 0 || !maps.Circle) {
      return;
    }

    const anchor = fitAnchor ?? center;
    referenceCircleRef.current = new maps.Circle({
      map,
      center: new maps.LatLng(anchor.lat, anchor.lng),
      radius: referenceRadiusM,
      fillColor: "#64748b",
      fillOpacity: 0,
      strokeColor: "#94a3b8",
      strokeOpacity: 0.45,
      strokeWeight: 1,
      clickable: false,
      zIndex: 5,
    });

    return () => {
      if (referenceCircleRef.current) {
        referenceCircleRef.current.setMap(null);
        referenceCircleRef.current = null;
      }
    };
  }, [referenceRadiusM, fitAnchor, center, status]);

  // Category / set change: apartment-centered zoom with morph animation.
  useEffect(() => {
    const map = mapRef.current;
    const maps = window.naver?.maps;
    if (!map || !maps || status !== "ready") return;
    if (!fitBoundsToken) return;

    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    const coverMaxM = fitCoverMaxM(fitBoundsToken);

    let cancelled = false;
    let fitted = false;
    let settleTimer: number | null = null;
    let retryTimer: number | null = null;
    let enforceTimer: number | null = null;

    const estimateZoom = (
      anchor: LatLng,
      latDelta: number,
      lngDelta: number,
    ): number => {
      const cos = Math.max(0.25, Math.cos((anchor.lat * Math.PI) / 180));
      const host = hostRef.current;
      let width = 360;
      let height = 320;
      if (host && host.clientWidth > 0) width = host.clientWidth;
      if (host && host.clientHeight > 0) height = host.clientHeight;
      try {
        maps.Event.trigger?.(map, "resize");
      } catch {
        /* ignore */
      }
      const usableW = Math.max(120, width - 48);
      const usableH = Math.max(120, height - 56);
      const northM = Math.max(latDelta * 111320, 40);
      const eastM = Math.max(lngDelta * 111320 * cos, 40);
      const mpp = Math.max((2 * eastM) / usableW, (2 * northM) / usableH);
      const z = Math.log2((156543.03392 * cos) / mpp);
      // 마커가 가까이 몰려도 너무 확대하지 않는다(최대 16 — 동네 한 블록 이상 보이게)
      return Math.max(12, Math.min(16, Math.floor(z)));
    };

    /** Native NAVER zoom — never step setZoom per-frame (that stutters). */
    const MORPH_MS = 700;

    const applyZoomNative = (anchorLatLng: unknown, z: number) => {
      try {
        map.setOptions?.({ zoomOrigin: anchorLatLng });
      } catch {
        /* ignore */
      }
      map.setCenter(anchorLatLng);
      // Second arg enables NAVER's built-in zoom effect.
      map.setZoom?.(z, true);
    };

    const applyZoom = (anchorLatLng: unknown, z: number) => {
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

      if (reduceMotion) {
        map.setCenter(anchorLatLng);
        map.setZoom?.(z);
        return;
      }

      // morph = continuous center+zoom (SDK-native). Avoid rAF setZoom stepping.
      if (typeof map.morph === "function") {
        map.morph(anchorLatLng, z, {
          duration: MORPH_MS,
          easing: "easeOutCubic",
        });
        // If morph kept the old zoom, finish with one native zoom effect.
        enforceTimer = window.setTimeout(() => {
          if (cancelled) return;
          const got =
            typeof map.getZoom === "function" ? map.getZoom() : undefined;
          if (typeof got === "number" && Math.abs(got - z) > 0.6) {
            applyZoomNative(anchorLatLng, z);
          }
        }, MORPH_MS + 80);
        return;
      }

      applyZoomNative(anchorLatLng, z);
    };

    const runFitOnce = () => {
      if (cancelled || fitted) return;

      const anchor = fitAnchorRef.current ?? centerRef.current;
      const poi = markersRef.current.filter((m) => m.id !== "complex");
      const radiusFit = fitRadiusMRef.current;
      // Markers may arrive just after tab switch — retry instead of fitting empty.
      // Commerce density: allow radius-only fit when no POI markers.
      if (poi.length === 0 && !(radiusFit != null && radiusFit > 0)) return;

      const hostH = hostRef.current?.clientHeight ?? 0;
      // Still in transport→taller-tab height transition.
      if (hostH > 0 && hostH < 300) return;

      fitted = true;
      const anchorLatLng = new maps.LatLng(anchor.lat, anchor.lng);

      let maxLatDelta = 0;
      let maxLngDelta = 0;
      let anyInCover = false;

      if (poi.length > 0) {
        for (const m of poi) {
          const distM = haversineMeters(anchor, m.position);
          if (Number.isFinite(distM) && distM > coverMaxM) continue;
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
      } else if (radiusFit != null && radiusFit > 0) {
        // Equirectangular delta for the requested cover radius.
        maxLatDelta = radiusFit / 111320;
        maxLngDelta =
          radiusFit /
          (111320 * Math.max(0.25, Math.cos((anchor.lat * Math.PI) / 180)));
      }

      // 여유를 두고, 가장 가까운 경우에도 단지 둘레 반경 약 500m는 보이게
      const pad = 1.2;
      const minDelta = 500 / 111320;
      const latDelta = Math.max(maxLatDelta * pad, minDelta);
      const lngDelta = Math.max(maxLngDelta * pad, minDelta);
      const z = Math.max(12, Math.min(16, estimateZoom(anchor, latDelta, lngDelta)));

      applyZoom(anchorLatLng, z);
    };

    // Poll briefly so commerce/school async markers + height transition both land.
    const startedAt = Date.now();
    const tick = () => {
      if (cancelled || fitted) return;
      runFitOnce();
      if (fitted || cancelled) return;
      if (Date.now() - startedAt >= 1600) return;
      retryTimer = window.setTimeout(tick, 80);
    };
    // Height already tall (living→commerce/school): fit on next frame.
    // Still short (transport→…): wait for CSS height transition.
    const hostH0 = hostRef.current?.clientHeight ?? 0;
    const needsLayoutSettle = hostH0 > 0 && hostH0 < 300;
    settleTimer = window.setTimeout(
      tick,
      needsLayoutSettle ? FIT_LAYOUT_SETTLE_MS : 32,
    );

    return () => {
      cancelled = true;
      if (settleTimer != null) window.clearTimeout(settleTimer);
      if (retryTimer != null) window.clearTimeout(retryTimer);
      if (enforceTimer != null) window.clearTimeout(enforceTimer);
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
      ref={wrapRef}
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

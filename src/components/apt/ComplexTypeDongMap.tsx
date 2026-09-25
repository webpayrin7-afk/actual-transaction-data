"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { loadNaverMapsSdk, type NaverMapInstance } from "@/lib/nearby-map/naver-sdk";
import type { Complex3d, Ring } from "@/lib/complex-3d/read";

async function fetch3d(complexId: string): Promise<Complex3d | null> {
  const res = await fetch(`/api/complex-3d/${complexId}`);
  if (!res.ok) return null;
  return res.json();
}

type Pt = { lat: number; lng: number };

function centroid(rings: Ring[]): Pt {
  const ring = rings[0] ?? [];
  let lat = 0;
  let lng = 0;
  for (const [x, y] of ring) {
    lng += x;
    lat += y;
  }
  const n = Math.max(1, ring.length);
  return { lat: lat / n, lng: lng / n };
}

/** 단지 경계 대신 쓰는 외곽선 — 동 모양 꼭짓점들의 볼록 껍질 */
function convexHull(points: Pt[]): Pt[] {
  const p = [...points].sort((a, b) => a.lng - b.lng || a.lat - b.lat);
  if (p.length < 3) return p;
  const cross = (o: Pt, a: Pt, b: Pt) => (a.lng - o.lng) * (b.lat - o.lat) - (a.lat - o.lat) * (b.lng - o.lng);
  const lower: Pt[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Pt[] = [];
  for (const q of [...p].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, q) <= 0) upper.pop();
    upper.push(q);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const FONT = "'Noto Sans KR',system-ui,sans-serif";

/** "131동 / 109.29A㎡ · 26층" 작은 말풍선 — 동이 많아도 지도를 덮지 않게 두 줄로 */
function labelHtml(dong: string, type: string, floors: number | null, on: boolean): string {
  const head = on ? "var(--lab-navy-950)" : "var(--lab-brand-primary)";
  return `<div style="transform:translate(-50%,-100%);display:flex;flex-direction:column;align-items:center;cursor:pointer;filter:drop-shadow(0 1px 1px rgba(15,23,42,.2))">
    <div style="border-radius:4px;overflow:hidden;border:1px solid ${head};background:#fff;text-align:center;white-space:nowrap">
      <div style="background:${head};color:#fff;font:600 10px/13px ${FONT};padding:0 4px">${esc(dong)}</div>
      <div style="color:var(--lab-navy-950);font:600 10px/13px ${FONT};padding:0 4px">${esc(type)}${floors ? `<span style="color:var(--lab-muted);font-weight:500"> · ${floors}층</span>` : ""}</div>
    </div>
    <div style="width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent;border-top:4px solid ${head};margin-top:-1px"></div>
  </div>`;
}

/**
 * 타입·동 지도 — 단지 동 모양 위에, 고른 타입이 있는 동을 색칠하고 "동 / 타입 / 층" 말풍선을 붙인다.
 * 동을 누르면 onPickDong. 동 모양(GIS)이 연결된 단지에서만 보인다.
 * 모바일은 고른 동(없으면 대표 동) 근처로 확대, 넓은 화면은 단지 전체.
 */
export function ComplexTypeDongMap({
  complexId,
  typeDongs,
  typeLabel,
  pickedDong,
  onPickDong,
}: {
  complexId: string;
  /** 고른 타입이 있는 동 이름들 */
  typeDongs: string[];
  typeLabel: string;
  pickedDong: string | null;
  onPickDong: (dong: string) => void;
}) {
  const query = useQuery({
    queryKey: ["complex-3d", complexId],
    queryFn: () => fetch3d(complexId),
    staleTime: 60 * 60 * 1000,
  });
  const buildings = useMemo(
    () => (query.data?.buildings ?? []).filter((b) => b.rings && b.rings.length && b.residential),
    [query.data],
  );
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<NaverMapInstance | null>(null);
  const [ready, setReady] = useState(false);
  const [wide, setWide] = useState(false);
  const pickRef = useRef(onPickDong);
  useEffect(() => {
    pickRef.current = onPickDong;
  }, [onPickDong]);

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 640px)");
    const sync = () => setWide(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  // 지도 한 번 만들기
  useEffect(() => {
    if (!buildings.length || !hostRef.current || mapRef.current) return;
    let cancelled = false;
    void (async () => {
      const loaded = await loadNaverMapsSdk();
      if (cancelled || !loaded.ok || !hostRef.current) return;
      const maps = loaded.naver.maps;
      const c = centroid(buildings[0]!.rings!);
      mapRef.current = new maps.Map(hostRef.current, {
        center: new maps.LatLng(c.lat, c.lng),
        zoom: 17,
        zoomControl: false,
        scaleControl: false,
        mapDataControl: false,
      });
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [buildings]);

  useEffect(
    () => () => {
      mapRef.current?.destroy?.();
      mapRef.current = null;
    },
    [],
  );

  // 동 모양·말풍선 그리기
  useEffect(() => {
    const map = mapRef.current;
    const maps = window.naver?.maps;
    if (!ready || !map || !maps?.Polygon) return;
    const onSet = new Set(typeDongs);
    const drawn: Array<{ setMap: (m: null) => void }> = [];
    const all: Pt[] = [];
    for (const b of buildings) {
      const has = !!b.dong && onSet.has(b.dong);
      const picked = has && b.dong === pickedDong;
      for (const ring of b.rings!) for (const [lng, lat] of ring) all.push({ lat, lng });
      const poly = new maps.Polygon({
        map,
        paths: b.rings!.map((ring) => ring.map(([lng, lat]) => new maps.LatLng(lat, lng))),
        fillColor: has ? (picked ? "#115E59" : "#0F766E") : "#94A3B8",
        fillOpacity: has ? (picked ? 0.75 : 0.45) : 0.12,
        strokeColor: has ? "#0F766E" : "#94A3B8",
        strokeOpacity: 0.9,
        strokeWeight: picked ? 2.5 : 1,
        clickable: has,
        zIndex: has ? 3 : 1,
      });
      if (has && b.dong) {
        const dong = b.dong;
        maps.Event.addListener(poly, "click", () => pickRef.current(dong));
        const c = centroid(b.rings!);
        const marker = new maps.Marker({
          position: new maps.LatLng(c.lat, c.lng),
          map,
          icon: { content: labelHtml(dong, typeLabel, b.floors, picked), anchor: new maps.Point(0, 0) },
          zIndex: picked ? 20 : 10,
        });
        maps.Event.addListener(marker, "click", () => pickRef.current(dong));
        drawn.push(marker);
      }
      drawn.push(poly);
    }
    const hull = convexHull(all);
    if (hull.length >= 3) {
      drawn.push(
        new maps.Polygon({
          map,
          paths: [hull.map((p) => new maps.LatLng(p.lat, p.lng))],
          fillOpacity: 0,
          strokeColor: "#4F46E5",
          strokeOpacity: 0.6,
          strokeWeight: 2,
          clickable: false,
          zIndex: 0,
        }),
      );
    }
    // 보는 범위: 넓은 화면은 단지 전체, 모바일은 고른 동(없으면 첫 동) 근처
    const focus = buildings.find((b) => b.dong && b.dong === pickedDong) ?? buildings.find((b) => b.dong && onSet.has(b.dong));
    if (wide || !focus) {
      const lats = all.map((p) => p.lat);
      const lngs = all.map((p) => p.lng);
      map.fitBounds?.(
        new maps.LatLngBounds(
          new maps.LatLng(Math.min(...lats), Math.min(...lngs)),
          new maps.LatLng(Math.max(...lats), Math.max(...lngs)),
        ),
        { top: 40, right: 20, bottom: 10, left: 20 },
      );
    } else {
      const c = centroid(focus.rings!);
      map.morph?.(new maps.LatLng(c.lat, c.lng), 17, { duration: 250 });
    }
    return () => {
      for (const d of drawn) d.setMap(null);
    };
  }, [ready, buildings, typeDongs, typeLabel, pickedDong, wide]);

  if (!buildings.length) return null;
  return (
    <div
      ref={hostRef}
      className="h-48 w-full overflow-hidden rounded-xl border border-[color:var(--lab-border)] sm:h-[420px]"
      role="application"
      aria-label="타입이 있는 동 지도"
    />
  );
}

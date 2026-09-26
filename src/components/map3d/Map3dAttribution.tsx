"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

/**
 * 3D 지도 출처 — MapLibre 기본 'i' 버튼 대신 왼쪽 아래 작은 한 줄(늘 보임, OSM 표기 지침).
 * 누르면 전체 출처 줄과 링크가 펼쳐진다. 바탕 지도: OpenFreeMap(OpenMapTiles, OpenStreetMap ODbL),
 * 건물: 국토교통부 GIS건물통합정보 · 도로명주소 건물 도형.
 */
const LINES: Array<{ text: string; href?: string }> = [
  { text: "© OpenStreetMap contributors (ODbL)", href: "https://www.openstreetmap.org/copyright" },
  { text: "© OpenMapTiles", href: "https://www.openmaptiles.org/" },
  { text: "OpenFreeMap", href: "https://openfreemap.org/" },
  { text: "건물 © 국토교통부 GIS건물통합정보" },
  { text: "건물 도형 일부 © 행정안전부 도로명주소" },
  { text: "MapLibre", href: "https://maplibre.org/" },
];

export function Map3dAttribution({ className = "" }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className={`absolute left-3 max-w-[calc(100%-76px)] sm:left-4 ${className}`} data-map3d-attribution>
      {open ? (
        <div
          id="map3d-attribution-full"
          role="dialog"
          aria-label="지도 출처"
          className="absolute bottom-[calc(100%+4px)] left-0 w-[260px] max-w-[calc(100vw-24px)] rounded-lg border border-[color:var(--lab-border)] bg-[color:var(--lab-surface)] py-2 pl-3 pr-9 text-[12px] leading-5 text-[color:var(--lab-muted)] shadow-[0_8px_24px_rgb(15_23_42/0.16)]"
        >
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="출처 닫기"
            className="absolute right-0.5 top-0.5 inline-flex h-9 w-9 items-center justify-center text-[color:var(--lab-muted)]"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
          <ul>
            {LINES.map((l) => (
              <li key={l.text}>
                {l.href ? (
                  <a href={l.href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
                    {l.text}
                  </a>
                ) : (
                  l.text
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={open ? "map3d-attribution-full" : undefined}
        aria-label="지도 출처 — © OpenStreetMap · OpenFreeMap · 국토교통부 (눌러서 자세히)"
        className="relative block max-w-full truncate text-left text-[10.5px] leading-4 text-[color:var(--lab-navy-950)] opacity-60 before:absolute before:inset-x-0 before:-inset-y-2.5 before:content-[''] hover:opacity-90"
      >
        © OpenStreetMap · OpenFreeMap · 국토교통부
      </button>
    </div>
  );
}

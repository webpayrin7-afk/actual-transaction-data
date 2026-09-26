"use client";

import { useEffect, useRef, useState } from "react";
import { Info, X } from "lucide-react";

/**
 * 지도 출처 — MapLibre 기본 '접히는 출처(compact attribution)'와 같은 동작.
 *  1) 처음 열면 짧은 출처 한 줄을 잠깐 펼쳐 보여 주고,
 *  2) 지도를 처음 만지거나(누르기·휠·키) 약 4초가 지나면 작은 ⓘ 버튼으로 접는다.
 *  3) ⓘ를 누르면 전체 출처(링크 포함)를 열고 닫는다.
 * 작은 화면에서 출처를 ⓘ 뒤에 두되 처음에 한 번 보여 주는 방식은 OSM 출처 표기 지침(Attribution Guidelines)에도 맞다.
 * 바탕 지도: OpenFreeMap(OpenMapTiles, OpenStreetMap ODbL), 건물: 국토교통부 GIS건물통합정보 · 도로명주소 건물 도형.
 */
export type AttributionLine = { text: string; href?: string };

export const MAP3D_ATTRIBUTION: AttributionLine[] = [
  { text: "© OpenStreetMap contributors (ODbL)", href: "https://www.openstreetmap.org/copyright" },
  { text: "© OpenMapTiles", href: "https://www.openmaptiles.org/" },
  { text: "OpenFreeMap", href: "https://openfreemap.org/" },
  { text: "건물 © 국토교통부 GIS건물통합정보" },
  { text: "건물 도형 일부 © 행정안전부 도로명주소" },
  { text: "MapLibre", href: "https://maplibre.org/" },
];
/** 위성영상을 켰을 때 더하는 출처 */
export const SATELLITE_ATTRIBUTION: AttributionLine = { text: "위성영상 © 국토교통부 브이월드", href: "https://www.vworld.kr/" };
const MAP3D_SHORT = "© OpenStreetMap · OpenFreeMap · 국토교통부";

const INTRO_MS = 4000;

type State = "intro" | "collapsed" | "open";

export function Map3dAttribution({
  className = "",
  style,
  lines = MAP3D_ATTRIBUTION,
  short = MAP3D_SHORT,
  align = "left",
  openDir = "up",
  id = "map3d-attribution-full",
}: {
  className?: string;
  style?: React.CSSProperties;
  lines?: AttributionLine[];
  /** 처음 잠깐 펼쳐 보여 주는 짧은 출처 */
  short?: string;
  /** ⓘ가 붙는 쪽 — 오른쪽 컨트롤 옆에 둘 때는 right */
  align?: "left" | "right";
  /** 전체 출처가 열리는 쪽 */
  openDir?: "up" | "down";
  id?: string;
}) {
  const [state, setState] = useState<State>("intro");
  const ref = useRef<HTMLDivElement | null>(null);

  // 처음 만지거나 4초 뒤 접기 (ⓘ·출처 자체를 누른 건 빼고)
  useEffect(() => {
    if (state !== "intro") return;
    const collapse = () => setState((s) => (s === "intro" ? "collapsed" : s));
    const t = window.setTimeout(collapse, INTRO_MS);
    const onAny = (e: Event) => {
      if (ref.current?.contains(e.target as Node)) return;
      collapse();
    };
    document.addEventListener("pointerdown", onAny, true);
    document.addEventListener("wheel", onAny, { capture: true, passive: true });
    window.addEventListener("keydown", onAny, true);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("pointerdown", onAny, true);
      document.removeEventListener("wheel", onAny, true);
      window.removeEventListener("keydown", onAny, true);
    };
  }, [state]);

  // 열린 출처 — 바깥을 누르거나 Esc면 닫기
  useEffect(() => {
    if (state !== "open") return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setState("collapsed");
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setState("collapsed");
    };
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [state]);

  const open = state === "open";
  const right = align === "right";
  const side = right ? "right-0" : "left-0";
  const pos = openDir === "up" ? "bottom-[calc(100%+6px)]" : "top-[calc(100%+6px)]";

  return (
    <div
      ref={ref}
      className={`absolute ${right ? "right-3" : "left-3 sm:left-4"} ${className}`}
      style={style}
      data-map3d-attribution
      data-state={state}
    >
      {open ? (
        <div
          id={id}
          role="dialog"
          aria-label="지도 출처"
          className={`absolute ${pos} ${side} w-[260px] max-w-[calc(100vw-24px)] rounded-lg border border-[color:var(--lab-border)] bg-[color:var(--lab-surface)] py-2 pl-3 pr-9 text-[12px] leading-5 text-[color:var(--lab-muted)] shadow-[0_8px_24px_rgb(15_23_42/0.16)]`}
        >
          <button
            type="button"
            onClick={() => setState("collapsed")}
            aria-label="출처 닫기"
            className="absolute right-0.5 top-0.5 inline-flex h-9 w-9 items-center justify-center text-[color:var(--lab-muted)]"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
          <ul>
            {lines.map((l) => (
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
      <div className={`flex items-center gap-1 ${right ? "flex-row-reverse" : ""}`}>
        <button
          type="button"
          onClick={() => setState((s) => (s === "open" ? "collapsed" : "open"))}
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          aria-label={open ? "지도 출처 닫기" : "지도 출처 보기"}
          className="relative inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[color:var(--lab-border)] bg-[color:var(--lab-surface)]/95 text-[color:var(--lab-navy-950)] shadow-sm before:absolute before:-inset-2 before:content-[''] active:scale-95"
        >
          <Info className="h-4 w-4 opacity-70" aria-hidden />
        </button>
        {state === "intro" ? (
          <button
            type="button"
            onClick={() => setState("open")}
            className="max-w-[min(240px,calc(100vw-96px))] truncate rounded-full bg-[color:var(--lab-surface)]/90 px-2 py-0.5 text-left text-[11px] leading-4 text-[color:var(--lab-navy-950)] shadow-sm"
          >
            {short}
          </button>
        ) : null}
      </div>
    </div>
  );
}

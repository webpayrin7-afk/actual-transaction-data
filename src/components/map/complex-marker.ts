/**
 * 단지 가격 마커 — 메인 지도(지도로 찾기)·동 상세 지도(2D)와 3D 지도 핀(complex-pins.ts)이 같은 카드를 쓴다.
 */
import type { MapComplex } from "@/lib/map/map-complexes";
import { displayAptName } from "@/lib/apt/display-name";

/** 억 단위 짧은 표기: 315000 → "31.5억", 98000 → "9.8억" */
export function shortEok(man: number): string {
  return `${Math.round((man / 10000) * 10) / 10}억`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export const FONT = "'Noto Sans KR',system-ui,sans-serif";

/**
 * 구 종합 랭킹 1~3위 왕관 — 순위마다 모양·색이 다르다.
 * 1위 금색 다섯 봉우리+보석 · 2위 은색 네 봉우리 · 3위 동색 세 봉우리.
 */
export const CROWNS: Record<1 | 2 | 3, { fill: string; stroke: string; path: string; jewels: string }> = {
  1: {
    fill: "#F6C343",
    stroke: "#A86B00",
    path: "M2 15 L1 4 L6 8 L8.5 1.5 L12 7 L15.5 1.5 L18 8 L23 4 L22 15 Z",
    jewels: '<circle cx="12" cy="11.2" r="1.6" fill="#E5484D"/><circle cx="6.5" cy="11.6" r="1.1" fill="#fff"/><circle cx="17.5" cy="11.6" r="1.1" fill="#fff"/>',
  },
  2: {
    fill: "#D5DCE5",
    stroke: "#5B6778",
    path: "M3 15 L2 5 L7.5 9 L10 3 L14 3 L16.5 9 L22 5 L21 15 Z",
    jewels: '<circle cx="12" cy="11.4" r="1.4" fill="#4C6FFF"/>',
  },
  3: {
    fill: "#E2A26D",
    stroke: "#8A4B1C",
    path: "M4 15 L3 6 L8.5 10 L12 4 L15.5 10 L21 6 L20 15 Z",
    jewels: '<circle cx="12" cy="12" r="1.3" fill="#fff"/>',
  },
};

export function crownHtml(rank: 1 | 2 | 3): string {
  const c = CROWNS[rank];
  return `<svg width="24" height="17" viewBox="0 0 24 17" aria-hidden="true" style="display:block;margin-bottom:-3px;position:relative;z-index:1;filter:drop-shadow(0 1px 1px rgba(15,23,42,.25))">
      <path d="${c.path}" fill="${c.fill}" stroke="${c.stroke}" stroke-width="1.3" stroke-linejoin="round"/>
      <path d="M2.5 13.2 H21.5" stroke="${c.stroke}" stroke-width="1" opacity=".55"/>
      ${c.jewels}
    </svg>`;
}

/**
 * 2D 마커 — 꼬리 끝이 좌표. 거래가 없는 단지는 작은 회색 건물 아이콘.
 * opts.name=false 면 이름 줄을 뺀 작은 카드 (겹칠 때 이름부터 뺀다).
 */
export function complexMarkerHtml(
  c: MapComplex,
  selected: boolean,
  metric: MarkerMetric,
  opts: { name?: boolean } = {},
): string {
  if (c.priceMan == null) {
    const stroke = selected ? "var(--lab-brand-primary)" : "#94a3b8";
    return `<div style="transform:translate(-50%,-100%);cursor:pointer">
      <svg width="18" height="20" viewBox="0 0 18 20" aria-hidden="true" style="display:block;filter:drop-shadow(0 1px 1px rgba(15,23,42,.2))">
        <path d="M4 1h10v5h3v13H1V6h3z" fill="#fff" stroke="${stroke}" stroke-width="1.5" stroke-linejoin="round"/>
        <path d="M6 5h2M10 5h2M6 9h2M10 9h2M6 13h2M10 13h2" stroke="${stroke}" stroke-width="1.5"/>
      </svg></div>`;
  }
  return `<div style="transform:translate(-50%,-100%);cursor:pointer">${markerCardHtml(complexMarkerCard(c, selected, metric, opts))}</div>`;
}

/**
 * 단지 마커 카드 — 2D·3D 같은 마크업.
 * 위에서부터: (고른 단지) 튀는 ▼ 화살표 · 구 1~3위 왕관 · 평형 탭("33평") · 값 상자(단지 이름 한 줄 + 값) · 꼬리.
 * 꼬리 끝이 단지 자리(3D는 지붕 위 점)를 가리킨다. 바깥 자리 잡기(translate)는 쓰는 쪽이 한다.
 */
export type MarkerCard = {
  /** 줄인 단지 이름 (markerName) — ""면 이름 줄 없음 */
  name: string;
  /** 평형 탭 — ""면 탭 없음 */
  pyeong: string;
  /** 값 — ""면 이름이 큰 줄이 된다 */
  value: string;
  valueColor?: string;
  crown?: 1 | 2 | 3 | null;
  /** 신고가 빨간 점 · 하락 파란 점 */
  move?: "singoga" | "drop" | null;
  selected: boolean;
  /** 고른 단지 튀는 ▼ 화살표 */
  arrow?: boolean;
};

/** 마커 이름 — 지번 괄호를 떼고 8자까지 ("래미안퍼스티지" · "헬리오시티…") */
export function markerName(aptName: string): string {
  const s = displayAptName(aptName);
  const chars = [...s];
  return chars.length > 8 ? `${chars.slice(0, 7).join("")}…` : s;
}

const BRAND = "var(--lab-brand-primary,#0f766e)";
const NAVY = "var(--lab-navy-950,#0f172a)";
const ARROW_H = 20;

/** 글자 폭 어림(px) — 한글 1em · 숫자·영문 ≈0.62em (겹침 판단용, 캔버스 없이) */
function textW(s: string, px: number): number {
  let w = 0;
  for (const ch of s) w += (ch.codePointAt(0) ?? 0) >= 0x1100 ? px : px * 0.62;
  return w;
}

/** 카드 크기 어림(px) — 꼬리 끝에서 위로 h, 가로 가운데 w */
export function markerCardSize(m: MarkerCard): { w: number; h: number } {
  const main = m.value || m.name;
  const cap = m.value ? m.name : "";
  const boxW = Math.max(48, Math.max(textW(main, 13), cap ? textW(cap, 10) : 0) + 16 + 3);
  const tabW = m.pyeong ? Math.max(30, textW(m.pyeong, 11) + 12) : 0;
  const w = Math.max(boxW, tabW, m.crown ? 24 : 0, m.arrow ? 18 : 0);
  const boxH = 4 + 3 + 18 + (cap ? 13 : 0);
  const h = (m.arrow ? ARROW_H : 0) + (m.crown ? 14 : 0) + (m.pyeong ? 16 : 0) + boxH + 5;
  return { w: Math.ceil(w), h };
}

const ARROW_HTML =
  '<style>@keyframes zl-mk-bounce{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}@media (prefers-reduced-motion:reduce){.zl-mk-arrow{animation:none!important}}</style>' +
  '<span class="zl-mk-arrow" aria-hidden="true" style="display:block;width:18px;height:18px;margin-bottom:2px;animation:zl-mk-bounce 1s ease-in-out infinite;filter:drop-shadow(0 1px 1px rgba(15,23,42,.35))">' +
  '<svg viewBox="0 0 18 18" width="18" height="18" style="display:block"><path d="M3 5.5h12L9 14z" fill="#0f766e" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></svg></span>';

/** 카드 마크업 (자리 잡기 없음 — 세로 칸, 맨 아래 꼬리) */
export function markerCardHtml(m: MarkerCard): string {
  const sel = m.selected;
  const main = m.value || m.name;
  const cap = m.value ? m.name : "";
  const bodyBg = sel ? BRAND : "#fff";
  const bodyFg = sel ? "#fff" : m.value ? (m.valueColor ?? NAVY) : NAVY;
  const top = sel ? NAVY : BRAND;
  // 신고가 빨간 점 · 하락(고점 대비 −10% 이하) 파란 점
  const dot = m.move
    ? `<span style="position:absolute;top:-4px;right:-4px;width:9px;height:9px;border-radius:50%;background:${
        m.move === "singoga" ? "#E5484D" : "#3B6FE0"
      };border:1.5px solid #fff"></span>`
    : "";
  const capHtml = cap
    ? `<span style="display:block;font:600 10px/13px ${FONT};color:${sel ? "rgba(255,255,255,.88)" : "#475569"};letter-spacing:-.2px">${escapeHtml(cap)}</span>`
    : "";
  const tab = m.pyeong
    ? `<span style="display:block;min-width:30px;padding:0 6px;height:16px;box-sizing:border-box;border-radius:5px 5px 0 0;background:${top};color:#fff;font:600 11px/16px ${FONT};text-align:center;white-space:nowrap">${escapeHtml(m.pyeong)}</span>`
    : "";
  return `<span style="display:flex;flex-direction:column;align-items:center;filter:drop-shadow(0 1px 2px rgba(15,23,42,.22))">${
    m.arrow ? ARROW_HTML : ""
  }${m.crown ? crownHtml(m.crown) : ""}${tab}<span style="display:block;position:relative;box-sizing:border-box;min-width:48px;padding:2px 8px;border-radius:7px;background:${bodyBg};color:${bodyFg};border:1.5px solid ${BRAND};font:700 13px/18px ${FONT};font-variant-numeric:tabular-nums;text-align:center;white-space:nowrap">${capHtml}${escapeHtml(
    main,
  )}${dot}</span><span style="display:block;width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;border-top:6px solid ${BRAND};margin-top:-1px"></span></span>`;
}

/**
 * 단지 → 카드. 거래가 없는 단지는 값·평형 없이 이름만 큰 줄로.
 * opts.name=false: 이름 줄 빼기(값이 있을 때만) · opts.pyeong=false: 평형 탭 빼기 · opts.arrow: 기본은 고른 단지만.
 */
export function complexMarkerCard(
  c: MapComplex,
  selected: boolean,
  metric: MarkerMetric,
  opts: { name?: boolean; pyeong?: boolean; arrow?: boolean } = {},
): MarkerCard {
  const v = c.priceMan != null ? markerValue(c, metric) : null;
  // 지표 값이 없으면 2D처럼 회색 "–" (거래가 없는 단지만 값 없이 이름만)
  const value = v?.text ?? "";
  // 평형 이름(단지 상세와 같은 "33평"), 모르면 전용㎡
  const pyeong =
    opts.pyeong === false || c.priceMan == null
      ? ""
      : (c.pyeongLabel ?? (c.mainAreaSqm ? `${Math.floor(c.mainAreaSqm)}㎡` : ""));
  return {
    name: opts.name === false && value ? "" : markerName(c.aptName),
    pyeong,
    value,
    valueColor: v?.color,
    crown: c.guRank ?? null,
    move: c.move,
    selected,
    arrow: opts.arrow ?? selected,
  };
}

/** 마커 표시 값 — 가격 · 평당가 · 전세가율 · 1년 변동 */
export type MarkerMetric = "price" | "perPyeong" | "jeonseRatio" | "change1y";
// 가격: 대표 평형 최근 실거래가 · 평당가: 최근 실거래가 ÷ 평형(공급 3.3㎡)
// 전세가율: 대표 평형 최근 전세가 ÷ 최근 매매가 · 1년 변동: 최근 6개월 vs 1년 전 같은 6개월 (같은 평형, 각 2건 이상)
export const MARKER_METRICS: Array<{ id: MarkerMetric; label: string }> = [
  { id: "price", label: "가격" },
  { id: "perPyeong", label: "평당가" },
  { id: "jeonseRatio", label: "전세가율" },
  { id: "change1y", label: "1년 변동" },
];
export function markerValue(c: MapComplex, metric: MarkerMetric): { text: string; color?: string } {
  const none = { text: "–", color: "#94a3b8" };
  if (metric === "perPyeong") return c.perPyeongMan != null ? { text: shortPerPyeong(c.perPyeongMan) } : none;
  if (metric === "jeonseRatio") return c.jeonseRatioPct != null ? { text: `${Math.round(c.jeonseRatioPct)}%` } : none;
  if (metric === "change1y") {
    const v = c.change1yPct;
    if (v == null) return none;
    if (v === 0) return { text: "0%" };
    return { text: `${v > 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}%`, color: v > 0 ? "#D93A3F" : "#2F62D6" };
  }
  return { text: shortEok(c.priceMan!) };
}

/** 평당가 짧은 표기: 13059 → "1.31억", 6465 → "6,465만" */
export function shortPerPyeong(man: number): string {
  return man >= 10_000 ? `${(man / 10_000).toFixed(2)}억` : `${man.toLocaleString("ko-KR")}만`;
}

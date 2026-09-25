/**
 * 단지 가격 마커 — 메인 지도(지도로 찾기)와 동 상세 지도가 같이 쓴다.
 */
import type { MapComplex } from "@/lib/map/map-complexes";

/** 억 단위 짧은 표기: 315000 → "31.5억", 98000 → "9.8억" */
export function shortEok(man: number): string {
  return `${Math.round((man / 10000) * 10) / 10}억`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export const FONT = "'Noto Sans KR',system-ui,sans-serif";

/**
 * 아파트 모양 마커 — 좁은 윗동(전용㎡) 위에 넓은 몸통(가격)을 얹은 계단형 건물 실루엣 + 꼬리.
 * 거래가 없는 단지는 작은 회색 건물 아이콘.
 */
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

export function complexMarkerHtml(c: MapComplex, selected: boolean, metric: MarkerMetric): string {
  if (c.priceMan == null) {
    const stroke = selected ? "var(--lab-brand-primary)" : "#94a3b8";
    return `<div style="transform:translate(-50%,-100%);cursor:pointer">
      <svg width="18" height="20" viewBox="0 0 18 20" aria-hidden="true" style="display:block;filter:drop-shadow(0 1px 1px rgba(15,23,42,.2))">
        <path d="M4 1h10v5h3v13H1V6h3z" fill="#fff" stroke="${stroke}" stroke-width="1.5" stroke-linejoin="round"/>
        <path d="M6 5h2M10 5h2M6 9h2M10 9h2M6 13h2M10 13h2" stroke="${stroke}" stroke-width="1.5"/>
      </svg></div>`;
  }
  // 평형 이름(단지 상세와 같은 "33평"), 모르면 전용㎡
  const pyeong = c.pyeongLabel ?? (c.mainAreaSqm ? `${Math.floor(c.mainAreaSqm)}㎡` : "");
  const value = markerValue(c, metric);
  const bodyBg = selected ? "var(--lab-brand-primary)" : "#fff";
  const bodyFg = selected ? "#fff" : value.color ?? "var(--lab-navy-950)";
  const edge = "var(--lab-brand-primary)";
  const top = selected ? "var(--lab-navy-950)" : edge;
  // 신고가 빨간 점 · 하락(고점 대비 −10% 이하) 파란 점
  const dot = c.move
    ? `<span style="position:absolute;top:-4px;right:-4px;width:9px;height:9px;border-radius:50%;background:${
        c.move === "singoga" ? "#E5484D" : "#3B6FE0"
      };border:1.5px solid #fff"></span>`
    : "";
  return `<div style="transform:translate(-50%,-100%);display:flex;flex-direction:column;align-items:center;cursor:pointer;filter:drop-shadow(0 1px 2px rgba(15,23,42,.22))">
    ${c.guRank ? crownHtml(c.guRank) : ""}
    ${
      pyeong
        ? `<div style="min-width:30px;padding:0 6px;height:16px;border-radius:5px 5px 0 0;background:${top};color:#fff;font:600 11px/16px ${FONT};text-align:center;white-space:nowrap">${escapeHtml(pyeong)}</div>`
        : ""
    }
    <div style="position:relative;min-width:48px;padding:2px 8px;border-radius:7px;background:${bodyBg};color:${bodyFg};border:1.5px solid ${edge};font:700 13px/18px ${FONT};font-variant-numeric:tabular-nums;text-align:center;white-space:nowrap">${escapeHtml(
      value.text,
    )}${dot}</div>
    <div style="width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;border-top:6px solid ${edge};margin-top:-1px"></div>
  </div>`;
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


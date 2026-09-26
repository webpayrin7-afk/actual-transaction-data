/**
 * 서울 3D 지도 — 바탕지도·건물·단지 레이어 설정 (MapLibre 전용, 3D 화면에서만 불러온다).
 */
import type { ExpressionSpecification, StyleSpecification } from "maplibre-gl";

/** 무료 OSM 바탕지도 (OpenFreeMap, 키 없음). 출처 표시는 스타일에 들어 있다. */
export const BASEMAP_STYLE_URL = "https://tiles.openfreemap.org/styles/positron";

/**
 * 건물 타일(PMTiles) 주소 — Vercel Blob에 올린 파일을 NEXT_PUBLIC_MAP3D_BUILDINGS_URL로 가리킨다.
 * 없으면 public/map3d/ (개발용, git에는 올리지 않음). 만드는 법: scripts/map3d/README.md
 */
export function buildingsTilesUrl(): string {
  const env = process.env.NEXT_PUBLIC_MAP3D_BUILDINGS_URL?.trim();
  if (env) return env;
  return `${window.location.origin}/map3d/seoul-buildings.pmtiles`;
}

export const BUILDINGS_ATTRIBUTION = "건물 © 국토교통부 GIS건물통합정보";

/** 건물 타일이 있는 범위 (서울) — 밖이면 안내 */
export const SEOUL_BOUNDS = { west: 126.76, south: 37.41, east: 127.19, north: 37.72 };

/** 집랩 색 — 바탕은 차분하게, 물·녹지는 옅게 */
const CALM = {
  background: "#f4f5f2",
  water: "#d6e4ea",
  park: "#e4ecdf",
  road: "#ffffff",
  roadCase: "#e3e5e8",
  label: "#5b6472",
};

/**
 * 바탕 스타일을 한 번 손본다:
 * - OSM 건물(평면·입체)은 숨긴다 → 우리 건물 타일로 대신
 * - 글자는 한국어 이름 우선 (name:ko → name)
 * - 색은 집랩 톤으로 차분하게
 */
export function calmBasemap(style: StyleSpecification): StyleSpecification {
  const layers = style.layers.flatMap((layer) => {
    const src = "source-layer" in layer ? layer["source-layer"] : undefined;
    if (src === "building") return [];
    const l = { ...layer } as typeof layer & { paint?: Record<string, unknown>; layout?: Record<string, unknown> };
    if (l.type === "background") l.paint = { ...l.paint, "background-color": CALM.background };
    if (l.type === "fill" && src === "water") l.paint = { ...l.paint, "fill-color": CALM.water };
    if (l.type === "fill" && (src === "park" || src === "landcover")) {
      l.paint = { ...l.paint, "fill-color": CALM.park };
    }
    if (l.type === "symbol" && l.layout && "text-field" in l.layout) {
      l.layout = {
        ...l.layout,
        "text-field": ["coalesce", ["get", "name:ko"], ["get", "name"]] as ExpressionSpecification,
      };
      l.paint = { ...l.paint, "text-color": CALM.label };
    }
    return [l];
  });
  return { ...style, layers } as StyleSpecification;
}

/** 건물 높이 — 줌 12.5까지는 솟아오르듯 (첫 화면 부담 줄이기) */
export const BUILDING_HEIGHT: ExpressionSpecification = [
  "interpolate",
  ["linear"],
  ["zoom"],
  12,
  0,
  13,
  ["get", "h"],
];

/** 건물 색 — 공동주택은 옅은 청록, 나머지는 옅은 회색. 높을수록 조금 진하게. */
export const BUILDING_COLOR: ExpressionSpecification = [
  "case",
  ["==", ["get", "a"], 1],
  ["interpolate", ["linear"], ["get", "h"], 0, "#d7ebe8", 80, "#a9d3cd"],
  ["interpolate", ["linear"], ["get", "h"], 0, "#e6e7ea", 100, "#c4c9d2"],
];

export type Map3dMetric = "perPyeong" | "change1y";

/** 평당가(만원/3.3㎡) 단계 색 — 옅은 청록 → 짙은 남색 */
export const PER_PYEONG_STEPS: Array<[number, string, string]> = [
  [0, "#9bdcd2", "3천만 미만"],
  [3000, "#5ec0b3", "3천만~"],
  [4500, "#2a9d8f", "4,500만~"],
  [6000, "#1f7a8c", "6천만~"],
  [8000, "#2b5a86", "8천만~"],
  [10000, "#1e2f5c", "1억~"],
];

/** 1년 변동(%) 단계 색 — 하락 파랑, 보합 회색, 상승 빨강 (사이트 공통) */
export const CHANGE_STEPS: Array<[number, string, string]> = [
  [-Infinity, "#2f62d6", "−5% 이하"],
  [-5, "#8fa8e8", "−5~−1%"],
  [-1, "#a3aab5", "±1%"],
  [1, "#f09a9c", "1~5%"],
  [5, "#d93a3f", "5% 이상"],
];

export const NO_VALUE_COLOR = "#cbd5e1";

export function stepColor(metric: Map3dMetric): ExpressionSpecification {
  const steps = metric === "perPyeong" ? PER_PYEONG_STEPS : CHANGE_STEPS;
  const expr: unknown[] = ["step", ["get", "v"], steps[0]![1]];
  for (const [min, color] of steps.slice(1)) expr.push(min, color);
  return ["case", ["!", ["has", "v"]], NO_VALUE_COLOR, expr] as unknown as ExpressionSpecification;
}

export const LOCALE_KO: Record<string, string> = {
  "AttributionControl.ToggleAttribution": "출처 보기",
  "NavigationControl.ResetBearing": "북쪽·기울기 초기화",
  "NavigationControl.ZoomIn": "확대",
  "NavigationControl.ZoomOut": "축소",
  "Map.Title": "지도",
  "Popup.Close": "닫기",
};

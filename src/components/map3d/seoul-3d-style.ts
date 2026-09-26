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
  // 서울 건물 타일 — Vercel Blob(ziplab-map3d, icn1). 환경변수로 바꿀 수 있고, 없으면 이 주소
  return "https://nknxeggbsjwx9abs.public.blob.vercel-storage.com/map3d/seoul-buildings-BbweA7LAohi5MYroVw1eAT0ZLOCVy8.pmtiles";
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
 * 바탕 스타일 필터의 숫자 비교(["<=", ["get", "ref_length"], 6] 등)는 그 값이 없는 도형에서
 * 'Expected value to be of type number, but found null' 경고를 콘솔에 반복해서 낸다 (OpenFreeMap positron 원본).
 * 값이 없으면 어차피 거짓이므로, 비교가 늘 거짓이 되는 값으로 채워 같은 결과에 경고만 없앤다.
 */
function quietNumericFilter(expr: unknown): unknown {
  if (!Array.isArray(expr)) return expr;
  const [op, a, b] = expr as [unknown, unknown, unknown];
  const isGet = (v: unknown) => Array.isArray(v) && v[0] === "get" && v.length === 2;
  if ((op === "<" || op === "<=" || op === ">" || op === ">=") && expr.length === 3) {
    const lt = op === "<" || op === "<=";
    if (isGet(a) && typeof b === "number") return [op, ["coalesce", a, lt ? 1e9 : -1e9], b];
    if (typeof a === "number" && isGet(b)) return [op, a, ["coalesce", b, lt ? -1e9 : 1e9]];
    return expr;
  }
  return expr.map((v, i) => (i === 0 ? v : quietNumericFilter(v)));
}

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
    if ("filter" in l && l.filter) l.filter = quietNumericFilter(l.filter) as typeof l.filter;
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

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
  return "https://nknxeggbsjwx9abs.public.blob.vercel-storage.com/map3d/seoul-buildings-v3-Koz8CXoA6JVui1h6JH0fsbYuFekwdk.pmtiles";
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
  // 역·명소 이름 — 지명(동·구) 글자 바로 아래에 끼워 넣는다 (지명이 겹침 우선)
  const at = layers.findIndex((l) => l.id === "label_other");
  const lm = landmarkLayers();
  if (at >= 0) layers.splice(at, 0, ...lm);
  else layers.push(...lm);
  return { ...style, layers } as StyleSpecification;
}

/* ─────────────── 역·명소 이름 (위치 잡기용) ─────────────── */

/** 역 점 아이콘 이름 — 지도의 styleimagemissing에서 stationDotImage()로 채운다 */
export const STATION_ICON = "zl-station-dot";

/**
 * 큰 환승역·철도역 — 줌 12부터 보인다 (나머지 역은 줌 14부터).
 * OSM 이름은 '용산'·'서울역'처럼 '역'이 붙기도 안 붙기도 해서 둘 다 넣는다.
 */
const HUB_STATIONS = [
  "서울", "용산", "영등포", "청량리", "신도림", "강남", "잠실", "고속터미널", "사당", "왕십리",
  "홍대입구", "여의도", "종로3가", "시청", "건대입구", "삼성", "노량진", "서울대입구",
  "구로디지털단지", "수서", "공덕", "동대문역사문화공원", "광화문", "성수", "천호", "노원",
  "김포공항", "교대", "양재", "신촌", "합정", "이태원", "선릉", "가산디지털단지", "상봉", "창동",
];

/**
 * 누구나 아는 명소 — 줌 13.5부터 이름만 맞으면 보인다 (OSM 이름 그대로).
 * 바탕 타일의 poi 순위(rank)는 타일 칸 안 순서라 롯데월드타워도 7위로 나와서, 이름으로 고른다.
 */
const KEY_LANDMARKS = [
  "롯데월드타워", "롯데월드", "코엑스", "남산서울타워", "N서울타워", "서울숲", "여의도공원", "올림픽공원",
  "경복궁", "창덕궁", "덕수궁", "창경궁", "광화문광장", "서울광장", "동대문디자인플라자", "국립중앙박물관",
  "전쟁기념관", "용산가족공원", "용산어린이정원", "63빌딩", "63스퀘어", "더현대 서울", "IFC몰",
  "잠실야구장", "서울월드컵경기장", "고척스카이돔", "올림픽 주경기장", "서울어린이대공원", "어린이대공원",
  "북서울꿈의숲", "보라매공원", "월드컵공원", "하늘공원", "선유도공원", "노들섬", "여의도한강공원",
  "반포한강공원", "뚝섬한강공원", "잠실한강공원", "서울아산병원", "삼성서울병원", "서울대학교병원",
  "세브란스병원", "서울성모병원", "서울대학교", "연세대학교", "고려대학교", "서강대학교", "이화여자대학교",
  "한양대학교", "성균관대학교", "건국대학교", "경희대학교", "중앙대학교", "숙명여자대학교",
  "동국대학교 서울캠퍼스", "청와대", "국회의사당", "서울특별시청", "서울시청", "센트럴시티", "석촌호수",
  "서울식물원", "몽촌토성", "명동성당", "남대문시장", "광장시장", "가락시장",
];

const NAME: ExpressionSpecification = ["coalesce", ["get", "name:ko"], ["get", "name"]];
const RANK: ExpressionSpecification = ["coalesce", ["get", "rank"], 99];
const HUB_NAMES = [...new Set(HUB_STATIONS.flatMap((n) => [n, `${n}역`]))];
const IS_STATION: ExpressionSpecification = [
  "all",
  ["==", ["get", "class"], "railway"],
  ["match", ["get", "subclass"], ["station", "subway"], true, false],
  ["has", "name"],
];
const IS_HUB: ExpressionSpecification = ["match", NAME, HUB_NAMES, true, false];
const IS_KEY_LANDMARK: ExpressionSpecification = ["match", NAME, [...new Set(KEY_LANDMARKS)], true, false];
/** 가까이 볼 때만 — 대학·큰 병원·명소·박물관·경기장·공원 (편의점·의원·버스정류장 등은 빼고) */
const IS_MINOR_LANDMARK: ExpressionSpecification = [
  "all",
  ["has", "name"],
  ["!", IS_KEY_LANDMARK],
  [
    "any",
    ["all", ["==", ["get", "class"], "college"], ["==", ["get", "subclass"], "university"]],
    ["all", ["==", ["get", "class"], "hospital"], ["in", "병원", NAME], ["!", ["in", "의원", NAME]]],
    ["all", ["==", ["get", "class"], "attraction"], ["==", ["get", "subclass"], "attraction"]],
    ["match", ["get", "class"], ["museum", "stadium"], true, false],
    ["all", ["==", ["get", "class"], "park"], ["!", ["in", "어린이", NAME]], ["in", "공원", NAME]],
  ],
];
/** 역 이름은 '역'으로 끝나게 ('용산' → '용산역') */
const STATION_TEXT: ExpressionSpecification = [
  "case",
  ["==", ["slice", NAME, ["-", ["length", NAME], 1]], "역"],
  NAME,
  ["concat", NAME, "역"],
];

const LABEL_NAVY = "#1e2f5c";
const LABEL_SLATE = "#3f4a5c";
const LABEL_PARK = "#3b6b45";
const HALO = { "text-halo-color": "rgba(255,255,255,0.95)", "text-halo-width": 1.6, "text-halo-blur": 0.3 };

function stationLayer(id: string, hub: boolean): StyleSpecification["layers"][number] {
  return {
    id,
    type: "symbol",
    source: "openmaptiles",
    "source-layer": "poi",
    minzoom: hub ? 12 : 14,
    filter: ["all", IS_STATION, hub ? IS_HUB : ["!", IS_HUB]],
    layout: {
      "icon-image": STATION_ICON,
      "icon-size": hub ? 1 : 0.85,
      "text-field": STATION_TEXT,
      "text-font": [hub ? "Noto Sans Bold" : "Noto Sans Regular"],
      "text-size": hub ? ["interpolate", ["linear"], ["zoom"], 12, 11, 15, 12.5] : 11.5,
      "text-anchor": "left",
      "text-offset": [0.7, 0],
      "text-max-width": 8,
      "symbol-sort-key": hub ? 0 : 1,
      "text-padding": 4,
    },
    paint: { "text-color": LABEL_NAVY, ...HALO },
  };
}

function landmarkLayer(
  id: string,
  minzoom: number,
  filter: ExpressionSpecification,
  key = false,
): StyleSpecification["layers"][number] {
  return {
    id,
    type: "symbol",
    source: "openmaptiles",
    "source-layer": "poi",
    minzoom,
    filter,
    layout: {
      "text-field": NAME,
      // 이름난 명소는 굵게 — 도로 이름(같은 회색 계열)과 구별
      "text-font": [key ? "Noto Sans Bold" : "Noto Sans Regular"],
      "text-size": ["interpolate", ["linear"], ["zoom"], 14, 10.5, 17, 11.5],
      "text-max-width": 7,
      "text-padding": 6,
      "symbol-sort-key": RANK,
    },
    paint: {
      "text-color": ["match", ["get", "class"], "park", LABEL_PARK, LABEL_SLATE],
      ...HALO,
      "text-opacity": ["interpolate", ["linear"], ["zoom"], minzoom, 0, minzoom + 0.4, 1],
    },
  };
}

/**
 * 역·명소 이름 레이어 — 중요할수록 먼저(앞 레이어가 겹침 우선), 줌이 커질수록 많이:
 * 큰 환승역(줌 12~) → 모든 역(14~) → 이름난 명소(13.5~) → 대학·큰 병원·공원 등(15.5~ 칸 순위 2 이하, 16.5~ 4 이하)
 */
export function landmarkLayers(): StyleSpecification["layers"] {
  // 스타일 배열 뒤쪽이 겹침 우선이라, 덜 중요한 것을 앞에 둔다
  return [
    landmarkLayer("zl-landmark-more", 16.5, ["all", IS_MINOR_LANDMARK, [">", RANK, 2], ["<=", RANK, 4]]),
    landmarkLayer("zl-landmark-minor", 15.5, ["all", IS_MINOR_LANDMARK, ["<=", RANK, 2]]),
    stationLayer("zl-station", false),
    landmarkLayer("zl-landmark-key", 13.5, ["all", ["!=", ["get", "class"], "railway"], IS_KEY_LANDMARK], true),
    stationLayer("zl-station-hub", true),
  ];
}

/** 역 점 — 흰 속 + 남색 테두리 (2배 해상도, 화면에선 약 8px) */
export function stationDotImage(): { width: number; height: number; data: Uint8Array } {
  const size = 16;
  const data = new Uint8Array(size * size * 4);
  const c = (size - 1) / 2;
  const outer = 7.5;
  const ring = 2.6;
  const navy = [0x1e, 0x2f, 0x5c];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      const a = Math.max(0, Math.min(1, outer - d)); // 가장자리 부드럽게
      const t = Math.max(0, Math.min(1, d - (outer - ring))); // 0=속(흰), 1=테두리(남색)
      const i = (y * size + x) * 4;
      data[i] = Math.round(255 + (navy[0]! - 255) * t);
      data[i + 1] = Math.round(255 + (navy[1]! - 255) * t);
      data[i + 2] = Math.round(255 + (navy[2]! - 255) * t);
      data[i + 3] = Math.round(255 * a);
    }
  }
  return { width: size, height: size, data };
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

/** 단지를 골랐을 때 나머지 건물 — 채도를 빼고 조금 옅게 (고른 단지가 눈에 띄게) */
export const BUILDING_COLOR_DIM: ExpressionSpecification = [
  "interpolate",
  ["linear"],
  ["get", "h"],
  0,
  "#e9eaec",
  100,
  "#cfd2d7",
];

/** 고른 단지 — 집랩 청록(#0f766e)보다 조금 밝게 */
export const SELECTED_BUILDING_COLOR = "#1a9e90";
export const SELECTED_SITE_LINE = "#0f766e";
export const SELECTED_SITE_FILL = "#14b8a6";

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

/** 단지 점 색 — 값이 속한 단계 색, 값이 없으면 회색 */
export function metricColor(v: number | null, metric: Map3dMetric): string {
  if (v == null || !Number.isFinite(v)) return NO_VALUE_COLOR;
  const steps = metric === "perPyeong" ? PER_PYEONG_STEPS : CHANGE_STEPS;
  let color = steps[0]![1];
  for (const [min, c] of steps) if (v >= min) color = c;
  return color;
}

export const LOCALE_KO: Record<string, string> = {
  "AttributionControl.ToggleAttribution": "출처 보기",
  "NavigationControl.ResetBearing": "북쪽·기울기 초기화",
  "NavigationControl.ZoomIn": "확대",
  "NavigationControl.ZoomOut": "축소",
  "Map.Title": "지도",
  "Popup.Close": "닫기",
};

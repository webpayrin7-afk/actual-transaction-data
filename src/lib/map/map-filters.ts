/**
 * 지도 조건 — 집랩 방식: 가격·단지·환경 세 묶음 + 레시피(프리셋).
 * 전용면적만 서버에서 거르고(중위가가 면적 범위에 따라 달라지므로), 나머지는 받은 단지를 화면에서 거른다.
 */
import type { MapComplex, MapDealKind } from "@/lib/map/map-complexes";

export type RangeValue = { min: number; max: number };

export type RangeFilterId =
  | "area"
  | "price"
  | "households"
  | "age"
  | "jeonseRatio"
  | "gap"
  | "rentYield"
  | "far"
  | "bcr"
  | "parking";

export type FilterGroup = "price" | "complex" | "env";

export const FILTER_GROUPS: Array<{ id: FilterGroup; label: string }> = [
  { id: "price", label: "가격" },
  { id: "complex", label: "단지" },
  { id: "env", label: "환경" },
];

export type RangeFilterDef = {
  id: RangeFilterId;
  group: FilterGroup;
  label: string;
  /** 슬라이더 양 끝. max는 '이상'(끝까지 포함)으로 읽는다. */
  min: number;
  max: number;
  step: number;
  ticks: number[];
  /** 값 표기 */
  format: (v: number) => string;
  /** 눈금 표기 (좁은 폭용). 없으면 format */
  tick?: (v: number) => string;
  /** 단지에서 값 꺼내기 (null = 정보 없음) */
  value: (c: MapComplex, deal: MapDealKind) => number | null;
  /** 일부 단지에만 있는 값이면 true — '정보 있는 단지 기준' 표시 */
  sparse?: boolean;
  /** 짧은 설명 */
  hint?: string;
};

const eok = (man: number) => (man >= 10_000 ? `${Math.round(man / 1000) / 10}억` : `${Math.round(man / 100) / 100}억`);

function priceMax(deal: MapDealKind) {
  return deal === "trade" ? 400_000 : 200_000;
}

export function rangeDefs(deal: MapDealKind): RangeFilterDef[] {
  const pMax = priceMax(deal);
  return [
    {
      id: "price",
      group: "price",
      label: deal === "trade" ? "매매가" : "전세가",
      min: 0,
      max: pMax,
      step: 5_000,
      ticks: deal === "trade" ? [0, 100_000, 200_000, 300_000, 400_000] : [0, 50_000, 100_000, 150_000, 200_000],
      format: eok,
      value: (c) => c.medianPriceMan,
      hint: "최근 12개월 중위가",
    },
    {
      id: "jeonseRatio",
      group: "price",
      label: "전세가율",
      min: 0,
      max: 120,
      step: 5,
      ticks: [0, 40, 60, 80, 100, 120],
      format: (v) => `${v}%`,
      value: (c) => c.jeonseRatioPct,
      hint: "전세 중위 ÷ 매매 중위",
    },
    {
      id: "gap",
      group: "price",
      label: "갭가격",
      min: -50_000,
      max: 150_000,
      step: 5_000,
      ticks: [-50_000, 0, 50_000, 100_000, 150_000],
      format: (v) => (v < 0 ? `−${eok(-v)}` : eok(v)),
      value: (c) => c.gapMan,
      hint: "매매 중위 − 전세 중위 · 0 아래는 역전",
    },
    {
      id: "rentYield",
      group: "price",
      label: "월세수익률",
      min: 0,
      max: 8,
      step: 0.5,
      ticks: [0, 2, 4, 6, 8],
      format: (v) => `${v}%`,
      value: (c) => c.rentYieldPct,
      hint: "월세×12 ÷ (매매 중위 − 보증금)",
    },
    {
      id: "area",
      group: "complex",
      label: "전용면적",
      min: 0,
      max: 165,
      step: 5,
      ticks: [0, 40, 60, 85, 135, 165],
      format: (v) => `${v}㎡`,
      tick: (v) => String(v),
      value: (c) => c.mainAreaSqm,
      hint: "이 범위의 거래로 가격을 다시 계산해요",
    },
    {
      id: "households",
      group: "complex",
      label: "세대수",
      min: 0,
      max: 3000,
      step: 100,
      ticks: [0, 500, 1000, 2000, 3000],
      format: (v) => `${v.toLocaleString("ko-KR")}세대`,
      tick: (v) => (v >= 1000 ? `${v / 1000}천` : String(v)),
      value: (c) => c.householdCount,
    },
    {
      id: "age",
      group: "complex",
      label: "입주년차",
      min: 0,
      max: 40,
      step: 1,
      ticks: [0, 10, 20, 30, 40],
      format: (v) => `${v}년`,
      value: (c) => (c.buildYear ? new Date().getFullYear() - c.buildYear : null),
    },
    {
      id: "far",
      group: "env",
      label: "용적률",
      min: 0,
      max: 500,
      step: 10,
      ticks: [0, 100, 200, 300, 400, 500],
      format: (v) => `${v}%`,
      value: (c) => c.farRatio,
      sparse: true,
      hint: "낮을수록 재건축 여력이 커요",
    },
    {
      id: "bcr",
      group: "env",
      label: "건폐율",
      min: 0,
      max: 60,
      step: 5,
      ticks: [0, 15, 30, 45, 60],
      format: (v) => `${v}%`,
      value: (c) => c.bcrRatio,
      sparse: true,
      hint: "낮을수록 동 사이가 넓어요",
    },
    {
      id: "parking",
      group: "env",
      label: "세대당 주차",
      min: 0,
      max: 2,
      step: 0.1,
      ticks: [0, 0.5, 1, 1.5, 2],
      format: (v) => `${Math.round(v * 10) / 10}대`,
      value: (c) => c.parkingPerHousehold,
      sparse: true,
    },
  ];
}

export type HeatingKind = "개별" | "지역" | "중앙";
export const HEATING_KINDS: HeatingKind[] = ["개별", "지역", "중앙"];

export type MapConditions = {
  deal: MapDealKind;
  ranges: Partial<Record<RangeFilterId, RangeValue>>;
  heating: HeatingKind[];
};

export const EMPTY_CONDITIONS: MapConditions = { deal: "trade", ranges: {}, heating: [] };

/** 범위가 전체(양 끝)면 조건 없음으로 본다. */
export function isFullRange(def: RangeFilterDef, r: RangeValue | undefined): boolean {
  return !r || (r.min <= def.min && r.max >= def.max);
}

export function activeCount(cond: MapConditions, deal: MapDealKind = cond.deal): number {
  const defs = rangeDefs(deal);
  return defs.filter((d) => !isFullRange(d, cond.ranges[d.id])).length + (cond.heating.length > 0 ? 1 : 0);
}

/** 서버로 보낼 전용면적 범위 (끝 값은 '이상'이라 열어 둔다) */
export function areaQuery(cond: MapConditions): { min: number; max: number } {
  const def = rangeDefs(cond.deal).find((d) => d.id === "area")!;
  const r = cond.ranges.area;
  if (isFullRange(def, r)) return { min: 0, max: 10_000 };
  return { min: r!.min, max: r!.max >= def.max ? 10_000 : r!.max + 0.99 };
}

/** 단지가 조건을 모두 만족하나. 전용면적은 서버가 이미 걸렀으므로 건너뛴다. */
export function matches(c: MapComplex, cond: MapConditions, defs = rangeDefs(cond.deal)): boolean {
  for (const d of defs) {
    if (d.id === "area") continue;
    const r = cond.ranges[d.id];
    if (isFullRange(d, r)) continue;
    const v = d.value(c, cond.deal);
    if (v == null) return false;
    // 양 끝은 열린 구간: 최소가 슬라이더 시작이면 하한 없음, 최대가 끝이면 상한 없음
    if (r!.min > d.min && v < r!.min) return false;
    if (r!.max < d.max && v > r!.max) return false;
  }
  if (cond.heating.length > 0) {
    const h = c.heatingType ?? "";
    if (!cond.heating.some((k) => h.includes(k))) return false;
  }
  return true;
}

/** 레시피 — 자주 찾는 조건 묶음. 누르면 해당 범위만 덮어쓴다. */
export type Recipe = {
  id: string;
  label: string;
  hint: string;
  apply: (c: MapConditions) => MapConditions;
};

const withRanges = (c: MapConditions, ranges: MapConditions["ranges"]): MapConditions => ({
  ...c,
  ranges: { ...c.ranges, ...ranges },
});

export const RECIPES: Recipe[] = [
  {
    id: "new-large",
    label: "신축 대단지",
    hint: "입주 10년 이내 · 1,000세대 이상",
    apply: (c) => withRanges(c, { age: { min: 0, max: 10 }, households: { min: 1000, max: 3000 } }),
  },
  {
    id: "small-gap",
    label: "갭 작은 단지",
    hint: "전세가율 70% 이상",
    apply: (c) => withRanges(c, { jeonseRatio: { min: 70, max: 120 } }),
  },
  {
    id: "rebuild",
    label: "재건축 기대",
    hint: "30년 이상 · 용적률 200% 이하",
    apply: (c) => withRanges(c, { age: { min: 30, max: 40 }, far: { min: 0, max: 200 } }),
  },
  {
    id: "parking",
    label: "주차 여유",
    hint: "세대당 1.3대 이상",
    apply: (c) => withRanges(c, { parking: { min: 1.3, max: 2 } }),
  },
  {
    id: "yield",
    label: "월세 수익형",
    hint: "월세수익률 4% 이상",
    apply: (c) => withRanges(c, { rentYield: { min: 4, max: 8 } }),
  },
];

/** 레시피가 지금 조건에 그대로 들어 있나 (칩 선택 표시용) */
export function recipeActive(recipe: Recipe, cond: MapConditions): boolean {
  const applied = recipe.apply({ ...cond, ranges: {} });
  return Object.entries(applied.ranges).every(([k, v]) => {
    const cur = cond.ranges[k as RangeFilterId];
    return cur && v && cur.min === v.min && cur.max === v.max;
  });
}

/** 슬라이더 위 분포 막대 — 지금 화면 단지들의 값을 20칸으로. */
export function histogram(values: number[], def: RangeFilterDef, bins = 20): number[] {
  const out = new Array<number>(bins).fill(0);
  const span = def.max - def.min;
  for (const v of values) {
    const clamped = Math.min(def.max, Math.max(def.min, v));
    const i = Math.min(bins - 1, Math.floor(((clamped - def.min) / span) * bins));
    out[i]! += 1;
  }
  return out;
}

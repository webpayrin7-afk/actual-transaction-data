/**
 * Complex vs dong vs gu vs Seoul price position.
 *
 * Same area band, same reference month, median price per sqm.
 * This is not the region-overview PRICE_PER_SQM board: that board ranks
 * complexes on a trailing half-open 3-month window. Here every scope is
 * compared on the complex's latest sale month, and trends use equal
 * 3-calendar-month rolling medians.
 */

import { median } from "./objective-rank";
import { AREA_BAND_VERSION, type RegionalAreaBandId } from "./area-band";

export const PRICE_POSITION_VERSION = "price-position-v1";
export const PRICE_POSITION_AS_OF = "2026-09-17";
/** 3Y baseline start when the reference month is the as-of month. */
export const HISTORY_FLOOR_MONTH = "2023-07";
export const PYEONG_PER_SQM = 3.305785;
export const CHANGE_UNIT = "percentage_points" as const;
export const PRICE_LEVEL_MIN_SAMPLE = 1;

export const PRICE_SCOPES = ["COMPLEX", "DONG", "GU", "SEOUL"] as const;
export type PriceScope = (typeof PRICE_SCOPES)[number];

export const TREND_HORIZONS = ["3M", "6M", "1Y", "3Y"] as const;
export type TrendHorizon = (typeof TREND_HORIZONS)[number];

export const HORIZON_SHIFT_MONTHS: Record<TrendHorizon, number> = {
  "3M": 3,
  "6M": 6,
  "1Y": 12,
  "3Y": 36,
};

export const TREND_MIN_SAMPLE: Record<PriceScope, number> = {
  COMPLEX: 2,
  DONG: 3,
  GU: 5,
  SEOUL: 20,
};

export type MonthWindow = { start: string; end: string };
export type WindowKind = "month" | "roll3";

export type SalePoint = {
  complexId: string;
  lawdCd: string;
  bjdongCd: string;
  yearMonth: string;
  pricePerSqm: number;
};

export type ComplexIdentity = {
  complexId: string;
  lawdCd: string;
  bjdongCd: string;
  aptName: string;
  legalDongName: string;
};

export type StoredBucket = {
  scope: PriceScope;
  scopeKey: string;
  windowKind: WindowKind;
  windowEnd: string;
  medianPricePerSqm: number | null;
  tradeCount: number;
};

export type PriceLevelCell = {
  scope: PriceScope;
  label: string;
  medianPricePerSqm: number | null;
  medianPricePerPyeong: number | null;
  tradeCount: number | null;
  sampleCount: number | null;
  referenceMonth: string | null;
  status: "ok" | "INSUFFICIENT_SAMPLE";
};

export type TrendCell = {
  scope: PriceScope;
  label: string;
  changePercent: number | null;
  currentMedianPricePerSqm: number | null;
  baselineMedianPricePerSqm: number | null;
  currentTradeCount: number | null;
  baselineTradeCount: number | null;
  currentWindow: MonthWindow;
  baselineWindow: MonthWindow;
  status: "ok" | "INSUFFICIENT_SAMPLE";
};

export type PricePositionBody = {
  status: "ok" | "INSUFFICIENT_SAMPLE";
  complexId: string;
  aptName: string | null;
  areaBand: RegionalAreaBandId;
  areaBandVersion: string;
  transactionAsOf: string;
  referenceMonth: string | null;
  changeUnit: typeof CHANGE_UNIT;
  priceLevelDefinition: "reference_month_median_price_per_sqm";
  trendDefinition: "rolling_3_calendar_month_median_vs_equal_window";
  priceLevel: PriceLevelCell[];
  trends: Record<TrendHorizon, TrendCell[]>;
  maxAvailableValue: {
    priceLevel: number | null;
    trends: Record<TrendHorizon, number | null>;
  };
};

export function pricePositionSnapshotId(asOf: string = PRICE_POSITION_AS_OF): string {
  return `${PRICE_POSITION_VERSION}|${asOf}`;
}

export function dongScopeKey(lawdCd: string, bjdongCd: string): string {
  return `${lawdCd}${bjdongCd}`;
}

export function shiftYearMonth(yearMonth: string, deltaMonths: number): string {
  const match = /^(\d{4})-(\d{2})$/.exec(yearMonth);
  if (!match) throw new Error(`bad month ${yearMonth}`);
  const absolute = Number(match[1]) * 12 + (Number(match[2]) - 1) + deltaMonths;
  const year = Math.floor(absolute / 12);
  const month = absolute - year * 12 + 1;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

export function rollingWindow(endInclusive: string, length = 3): MonthWindow {
  if (length < 1) throw new Error("window length");
  return { start: shiftYearMonth(endInclusive, -(length - 1)), end: endInclusive };
}

export function trendWindows(referenceMonth: string): {
  current: MonthWindow;
  baselines: Record<TrendHorizon, MonthWindow>;
} {
  const current = rollingWindow(referenceMonth, 3);
  const baselines = {
    "3M": rollingWindow(shiftYearMonth(referenceMonth, -HORIZON_SHIFT_MONTHS["3M"]), 3),
    "6M": rollingWindow(shiftYearMonth(referenceMonth, -HORIZON_SHIFT_MONTHS["6M"]), 3),
    "1Y": rollingWindow(shiftYearMonth(referenceMonth, -HORIZON_SHIFT_MONTHS["1Y"]), 3),
    "3Y": rollingWindow(shiftYearMonth(referenceMonth, -HORIZON_SHIFT_MONTHS["3Y"]), 3),
  };
  return { current, baselines };
}

export function windowCovered(window: MonthWindow, floor: string = HISTORY_FLOOR_MONTH): boolean {
  return window.start >= floor;
}

export function roundTo(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

export function pricePerPyeong(pricePerSqm: number): number {
  return roundTo(pricePerSqm * PYEONG_PER_SQM, 4);
}

/** Percentage points. 5.2 means +5.2%. UI must not multiply again. */
export function changePercent(current: number, baseline: number): number | null {
  if (!(baseline > 0) || !Number.isFinite(current) || !Number.isFinite(baseline)) return null;
  return roundTo((current / baseline - 1) * 100, 2);
}

function monthsOf(window: MonthWindow): string[] {
  const out: string[] = [];
  let cursor = window.start;
  while (cursor <= window.end) {
    out.push(cursor);
    cursor = shiftYearMonth(cursor, 1);
    if (out.length > 48) throw new Error("window too long");
  }
  return out;
}

function pushMonth(map: Map<string, Map<string, number[]>>, key: string, month: string, price: number) {
  let months = map.get(key);
  if (!months) {
    months = new Map();
    map.set(key, months);
  }
  const list = months.get(month);
  if (list) list.push(price);
  else months.set(month, [price]);
}

function valuesFor(map: Map<string, Map<string, number[]>>, key: string, months: string[]): number[] {
  const byMonth = map.get(key);
  if (!byMonth) return [];
  const out: number[] = [];
  for (const month of months) {
    const list = byMonth.get(month);
    if (list) out.push(...list);
  }
  return out;
}

function bucketFor(
  scope: PriceScope,
  scopeKey: string,
  windowKind: WindowKind,
  window: MonthWindow,
  values: number[],
): StoredBucket | null {
  if (!windowCovered(window)) return null;
  const med = median(values);
  return {
    scope,
    scopeKey,
    windowKind,
    windowEnd: window.end,
    medianPricePerSqm: med,
    tradeCount: values.length,
  };
}

export function buildSnapshotStats(points: readonly SalePoint[]): {
  references: Array<ComplexIdentity & { referenceMonth: string }>;
  buckets: StoredBucket[];
} {
  const byComplex = new Map<string, Map<string, number[]>>();
  const byDong = new Map<string, Map<string, number[]>>();
  const byGu = new Map<string, Map<string, number[]>>();
  const bySeoul = new Map<string, Map<string, number[]>>();
  const identity = new Map<string, ComplexIdentity & { referenceMonth: string }>();

  for (const point of points) {
    if (!Number.isFinite(point.pricePerSqm) || point.pricePerSqm <= 0) continue;
    if (point.yearMonth < HISTORY_FLOOR_MONTH) continue;
    const dongKey = dongScopeKey(point.lawdCd, point.bjdongCd);
    pushMonth(byComplex, point.complexId, point.yearMonth, point.pricePerSqm);
    pushMonth(byDong, dongKey, point.yearMonth, point.pricePerSqm);
    pushMonth(byGu, point.lawdCd, point.yearMonth, point.pricePerSqm);
    pushMonth(bySeoul, "SEOUL", point.yearMonth, point.pricePerSqm);
    const prev = identity.get(point.complexId);
    if (!prev || point.yearMonth > prev.referenceMonth) {
      identity.set(point.complexId, {
        complexId: point.complexId,
        lawdCd: point.lawdCd,
        bjdongCd: point.bjdongCd,
        aptName: "",
        legalDongName: "",
        referenceMonth: point.yearMonth,
      });
    }
  }

  const bucketKey = (row: StoredBucket) =>
    `${row.scope}|${row.scopeKey}|${row.windowKind}|${row.windowEnd}`;
  const buckets = new Map<string, StoredBucket>();
  const remember = (row: StoredBucket | null) => {
    if (!row) return;
    buckets.set(bucketKey(row), row);
  };

  const needed = new Map<string, { scope: PriceScope; scopeKey: string; referenceMonth: string }>();
  for (const row of identity.values()) {
    needed.set(`COMPLEX|${row.complexId}|${row.referenceMonth}`, {
      scope: "COMPLEX",
      scopeKey: row.complexId,
      referenceMonth: row.referenceMonth,
    });
    needed.set(`DONG|${dongScopeKey(row.lawdCd, row.bjdongCd)}|${row.referenceMonth}`, {
      scope: "DONG",
      scopeKey: dongScopeKey(row.lawdCd, row.bjdongCd),
      referenceMonth: row.referenceMonth,
    });
    needed.set(`GU|${row.lawdCd}|${row.referenceMonth}`, {
      scope: "GU",
      scopeKey: row.lawdCd,
      referenceMonth: row.referenceMonth,
    });
    needed.set(`SEOUL|SEOUL|${row.referenceMonth}`, {
      scope: "SEOUL",
      scopeKey: "SEOUL",
      referenceMonth: row.referenceMonth,
    });
  }

  for (const item of needed.values()) {
    const source =
      item.scope === "COMPLEX" ? byComplex
        : item.scope === "DONG" ? byDong
          : item.scope === "GU" ? byGu
            : bySeoul;
    const windows = trendWindows(item.referenceMonth);
    remember(bucketFor(
      item.scope,
      item.scopeKey,
      "month",
      { start: item.referenceMonth, end: item.referenceMonth },
      valuesFor(source, item.scopeKey, [item.referenceMonth]),
    ));
    remember(bucketFor(item.scope, item.scopeKey, "roll3", windows.current, valuesFor(source, item.scopeKey, monthsOf(windows.current))));
    for (const horizon of TREND_HORIZONS) {
      const window = windows.baselines[horizon];
      remember(bucketFor(item.scope, item.scopeKey, "roll3", window, valuesFor(source, item.scopeKey, monthsOf(window))));
    }
  }

  return { references: [...identity.values()], buckets: [...buckets.values()] };
}

export function materializePayloads(params: {
  areaBand: RegionalAreaBandId;
  references: readonly (ComplexIdentity & { referenceMonth: string })[];
  buckets: readonly StoredBucket[];
  guName: (lawdCd: string) => string;
  transactionAsOf?: string;
}): PricePositionBody[] {
  const index = new Map<string, StoredBucket>();
  for (const row of params.buckets) {
    index.set(`${row.scope}|${row.scopeKey}|${row.windowKind}|${row.windowEnd}`, row);
  }
  return params.references.map((ref) => {
    const windows = trendWindows(ref.referenceMonth);
    const scopeKey: Record<PriceScope, string> = {
      COMPLEX: ref.complexId,
      DONG: dongScopeKey(ref.lawdCd, ref.bjdongCd),
      GU: ref.lawdCd,
      SEOUL: "SEOUL",
    };
    const ends = [
      windows.current.end,
      windows.baselines["3M"].end,
      windows.baselines["6M"].end,
      windows.baselines["1Y"].end,
      windows.baselines["3Y"].end,
    ];
    const buckets: StoredBucket[] = [];
    for (const scope of PRICE_SCOPES) {
      const key = scopeKey[scope];
      const month = index.get(`${scope}|${key}|month|${ref.referenceMonth}`);
      if (month) buckets.push(month);
      for (const end of ends) {
        const row = index.get(`${scope}|${key}|roll3|${end}`);
        if (row) buckets.push(row);
      }
    }
    return assemblePricePosition({
      complexId: ref.complexId,
      aptName: ref.aptName || null,
      areaBand: params.areaBand,
      transactionAsOf: params.transactionAsOf,
      referenceMonth: ref.referenceMonth,
      labels: {
        COMPLEX: "이 단지",
        DONG: ref.legalDongName || "동",
        GU: params.guName(ref.lawdCd) || "구",
        SEOUL: "서울",
      },
      buckets,
    });
  });
}

export function attachIdentity(
  references: Array<ComplexIdentity & { referenceMonth: string }>,
  names: ReadonlyMap<string, { aptName: string; legalDongName: string }>,
): Array<ComplexIdentity & { referenceMonth: string }> {
  return references.map((row) => {
    const name = names.get(row.complexId);
    return {
      ...row,
      aptName: name?.aptName ?? row.aptName,
      legalDongName: name?.legalDongName ?? row.legalDongName,
    };
  });
}

function findBucket(
  buckets: readonly StoredBucket[],
  scope: PriceScope,
  kind: WindowKind,
  windowEnd: string,
): StoredBucket | undefined {
  return buckets.find((row) => row.scope === scope && row.windowKind === kind && row.windowEnd === windowEnd);
}

function priced(stat: StoredBucket | undefined, minSample: number): {
  medianPricePerSqm: number | null;
  medianPricePerPyeong: number | null;
  tradeCount: number | null;
  status: "ok" | "INSUFFICIENT_SAMPLE";
} {
  const tradeCount = stat ? stat.tradeCount : null;
  if (!stat || stat.medianPricePerSqm == null || stat.tradeCount < minSample) {
    return { medianPricePerSqm: null, medianPricePerPyeong: null, tradeCount, status: "INSUFFICIENT_SAMPLE" };
  }
  const medianPricePerSqm = roundTo(stat.medianPricePerSqm, 4);
  return {
    medianPricePerSqm,
    medianPricePerPyeong: pricePerPyeong(medianPricePerSqm),
    tradeCount,
    status: "ok",
  };
}

export function assemblePricePosition(params: {
  complexId: string;
  aptName: string | null;
  areaBand: RegionalAreaBandId;
  transactionAsOf?: string;
  referenceMonth: string | null;
  labels: Record<PriceScope, string>;
  buckets: readonly StoredBucket[];
}): PricePositionBody {
  const transactionAsOf = params.transactionAsOf ?? PRICE_POSITION_AS_OF;
  const labels = params.labels;
  const referenceMonth = params.referenceMonth;
  const windows = referenceMonth ? trendWindows(referenceMonth) : null;

  const priceLevel: PriceLevelCell[] = PRICE_SCOPES.map((scope) => {
    const stat = referenceMonth
      ? findBucket(params.buckets, scope, "month", referenceMonth)
      : undefined;
    const cell = priced(stat, PRICE_LEVEL_MIN_SAMPLE);
    return {
      scope,
      label: labels[scope],
      medianPricePerSqm: cell.medianPricePerSqm,
      medianPricePerPyeong: cell.medianPricePerPyeong,
      tradeCount: cell.tradeCount,
      sampleCount: cell.tradeCount,
      referenceMonth,
      status: cell.status,
    };
  });

  const trends = {
    "3M": [] as TrendCell[],
    "6M": [] as TrendCell[],
    "1Y": [] as TrendCell[],
    "3Y": [] as TrendCell[],
  };

  if (windows) {
    for (const horizon of TREND_HORIZONS) {
      const baselineWindow = windows.baselines[horizon];
      trends[horizon] = PRICE_SCOPES.map((scope) => {
        const currentStat = findBucket(params.buckets, scope, "roll3", windows.current.end);
        const baselineStat = findBucket(params.buckets, scope, "roll3", baselineWindow.end);
        const minSample = TREND_MIN_SAMPLE[scope];
        const current = priced(currentStat, minSample);
        const baseline = priced(baselineStat, minSample);
        const ready = current.status === "ok" && baseline.status === "ok"
          && current.medianPricePerSqm != null
          && baseline.medianPricePerSqm != null;
        return {
          scope,
          label: labels[scope],
          changePercent: ready ? changePercent(current.medianPricePerSqm!, baseline.medianPricePerSqm!) : null,
          currentMedianPricePerSqm: ready ? current.medianPricePerSqm : null,
          baselineMedianPricePerSqm: ready ? baseline.medianPricePerSqm : null,
          currentTradeCount: current.tradeCount,
          baselineTradeCount: baseline.tradeCount,
          currentWindow: windows.current,
          baselineWindow,
          status: ready ? "ok" as const : "INSUFFICIENT_SAMPLE" as const,
        };
      });
    }
  } else {
    const emptyWindow = { start: "", end: "" };
    for (const horizon of TREND_HORIZONS) {
      trends[horizon] = PRICE_SCOPES.map((scope) => ({
        scope,
        label: labels[scope],
        changePercent: null,
        currentMedianPricePerSqm: null,
        baselineMedianPricePerSqm: null,
        currentTradeCount: null,
        baselineTradeCount: null,
        currentWindow: emptyWindow,
        baselineWindow: emptyWindow,
        status: "INSUFFICIENT_SAMPLE" as const,
      }));
    }
  }

  const priceValues = priceLevel
    .filter((row) => row.status === "ok" && row.medianPricePerSqm != null)
    .map((row) => row.medianPricePerSqm!);
  const trendScale = {
    "3M": null as number | null,
    "6M": null as number | null,
    "1Y": null as number | null,
    "3Y": null as number | null,
  };
  for (const horizon of TREND_HORIZONS) {
    const values = trends[horizon]
      .filter((row) => row.status === "ok" && row.changePercent != null)
      .map((row) => Math.abs(row.changePercent!));
    trendScale[horizon] = values.length > 0 ? roundTo(Math.max(...values), 2) : null;
  }

  return {
    status: referenceMonth ? "ok" : "INSUFFICIENT_SAMPLE",
    complexId: params.complexId,
    aptName: params.aptName,
    areaBand: params.areaBand,
    areaBandVersion: AREA_BAND_VERSION,
    transactionAsOf,
    referenceMonth,
    changeUnit: CHANGE_UNIT,
    priceLevelDefinition: "reference_month_median_price_per_sqm",
    trendDefinition: "rolling_3_calendar_month_median_vs_equal_window",
    priceLevel,
    trends,
    maxAvailableValue: {
      priceLevel: priceValues.length > 0 ? Math.max(...priceValues) : null,
      trends: trendScale,
    },
  };
}

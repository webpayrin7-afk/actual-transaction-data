/**
 * Selected-pyeong management fee estimates from portal OpenAPI derived 원/㎡.
 * expectedFee = per_area_total_fee × exclusive residential area (min/max range).
 * Do not invent TV방송수신료. Do not fall back to complex÷households.
 */

import {
  continuousMonthsFromLatest,
  formatWonAsManwon,
  type PortalAreaFeeMonthV1,
} from "@/lib/complex-detail/get-complex-detail-v1";

export type WonRange = {
  wonMin: number;
  wonMax: number;
  perM2: number;
};

export type ComponentEstimate = WonRange & {
  label: string;
};

export type PeriodEstimate = WonRange & {
  monthsUsed: string[];
  monthCount: number;
  /** e.g. "2개월 평균" when season incomplete */
  hint?: string;
};

export type SelectedPyeongMgmtFeeEstimate = {
  source: "portal_openapi";
  sourceLabelKo: string;
  kaptCode: string | null;
  areaBasis: "residential_exclusive";
  areaBasisLabelKo: string;
  exclusiveAreaMin: number;
  exclusiveAreaMax: number;
  latestMonth: string;
  latest: PeriodEstimate;
  components: {
    common: ComponentEstimate | null;
    individual: ComponentEstimate | null;
    reserve: ComponentEstimate | null;
  };
  winter: PeriodEstimate | null;
  summer: PeriodEstimate | null;
  trailingAverage: PeriodEstimate | null;
  disclaimer: string;
  knownMissingNote: string;
};

const DISCLAIMER =
  "공공데이터 OpenAPI 제공항목을 주거전용면적 기준으로 환산한 예상값입니다. 실제 세대별 사용량과 일부 부과항목에 따라 청구액과 차이가 있을 수 있습니다.";

const SOURCE_LABEL_KO = "국토교통부 공동주택관리정보 공공데이터";

const KNOWN_MISSING_NOTE =
  "개별사용료 OpenAPI에는 TV방송수신료가 포함되지 않습니다(잠실엘스 2026-07 기준 K-apt 완성값 대비 약 -0.68%). 보정하지 않고 예상 관리비로 사용합니다.";

function wonRange(perM2: number, areaMin: number, areaMax: number): WonRange {
  const lo = Math.min(areaMin, areaMax);
  const hi = Math.max(areaMin, areaMax);
  return {
    perM2,
    wonMin: perM2 * lo,
    wonMax: perM2 * hi,
  };
}

/** Compact 만원 label; single value when min/max round equal. */
export function formatWonRangeAsManwon(
  wonMin: number | null | undefined,
  wonMax: number | null | undefined,
): string {
  if (
    wonMin == null ||
    wonMax == null ||
    !Number.isFinite(wonMin) ||
    !Number.isFinite(wonMax)
  ) {
    return "—";
  }
  const a = Math.round(Math.min(wonMin, wonMax) / 10000);
  const b = Math.round(Math.max(wonMin, wonMax) / 10000);
  if (a === b) return formatWonAsManwon(a * 10000);
  return `${a.toLocaleString("ko-KR")}~${b.toLocaleString("ko-KR")}만원`;
}

function yearNum(ym: string): number {
  return Number(ym.slice(0, 4));
}

function monthNum(ym: string): number {
  return Number(ym.slice(4, 6));
}

function avg(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return nums.reduce((s, n) => s + n, 0) / nums.length;
}

/**
 * Same-calendar-year summer (6·7·8) ≤ latestMonth.
 * Uses only COMPLETE portal months — does not mix prior-year August.
 */
export function computeSameYearSummerPerM2(
  monthsDesc: PortalAreaFeeMonthV1[],
  latestMonth: string,
): { avgTotalPerM2: number; monthsUsed: string[] } | null {
  const y = yearNum(latestMonth);
  const byYm = new Map(monthsDesc.map((m) => [m.periodYyyymm, m]));
  const candidates = [6, 7, 8]
    .map((mo) => `${y}${String(mo).padStart(2, "0")}`)
    .filter((ym) => ym <= latestMonth && byYm.has(ym));
  if (candidates.length < 2) return null;
  const rates = candidates
    .map((ym) => byYm.get(ym)!.perAreaTotal)
    .filter((v): v is number => v != null && Number.isFinite(v));
  if (rates.length < 2) return null;
  const a = avg(rates);
  if (a == null) return null;
  return { avgTotalPerM2: a, monthsUsed: candidates };
}

/**
 * Contiguous winter 12/1/2 ending at or before latestMonth.
 * Prefer the season whose Feb year matches latest when possible.
 */
export function computeWinterPerM2(
  monthsDesc: PortalAreaFeeMonthV1[],
  latestMonth: string,
): { avgTotalPerM2: number; monthsUsed: string[] } | null {
  const byYm = new Map(monthsDesc.map((m) => [m.periodYyyymm, m]));
  const latestY = yearNum(latestMonth);
  const latestM = monthNum(latestMonth);

  // Candidate season years: if latest is Jan/Feb, that winter year; else latest year
  // and prior year (most recent first).
  const seasonYears: number[] = [];
  if (latestM >= 1) seasonYears.push(latestY);
  seasonYears.push(latestY - 1);

  for (const y of seasonYears) {
    const candidates = [
      `${y - 1}12`,
      `${y}01`,
      `${y}02`,
    ].filter((ym) => ym <= latestMonth && byYm.has(ym));
    if (candidates.length < 2) continue;
    const rates = candidates
      .map((ym) => byYm.get(ym)!.perAreaTotal)
      .filter((v): v is number => v != null && Number.isFinite(v));
    if (rates.length < 2) continue;
    const a = avg(rates);
    if (a == null) continue;
    return { avgTotalPerM2: a, monthsUsed: candidates };
  }
  return null;
}

/**
 * Build selected-pyeong estimate from COMPLETE portal per-area months.
 */
export function estimateSelectedPyeongFromPortal(params: {
  monthsDesc: PortalAreaFeeMonthV1[];
  exclusiveAreaMin: number;
  exclusiveAreaMax: number;
  kaptCode?: string | null;
}): SelectedPyeongMgmtFeeEstimate | null {
  const areaMin = params.exclusiveAreaMin;
  const areaMax = params.exclusiveAreaMax;
  if (
    !Number.isFinite(areaMin) ||
    !Number.isFinite(areaMax) ||
    areaMin <= 0 ||
    areaMax <= 0
  ) {
    return null;
  }

  const complete = params.monthsDesc.filter(
    (m) =>
      m.feeStatus === "COMPLETE" &&
      m.perAreaTotal != null &&
      Number.isFinite(m.perAreaTotal) &&
      m.privArea > 0 &&
      // Unpublished months can return all-zero success payloads — exclude.
      (m.portalTotal == null || m.portalTotal > 0),
  );
  if (complete.length === 0) return null;

  const monthsDesc = [...complete].sort((a, b) =>
    b.periodYyyymm.localeCompare(a.periodYyyymm),
  );
  const continuous = continuousMonthsFromLatest(
    monthsDesc.map((m) => ({ periodYyyymm: m.periodYyyymm })),
    12,
  );
  const continuousSet = new Set(continuous.map((m) => m.periodYyyymm));
  const continuousRows = monthsDesc.filter((m) =>
    continuousSet.has(m.periodYyyymm),
  );
  const latestRow = continuousRows[0] ?? monthsDesc[0];
  if (!latestRow || latestRow.perAreaTotal == null) return null;

  const latest: PeriodEstimate = {
    ...wonRange(latestRow.perAreaTotal, areaMin, areaMax),
    monthsUsed: [latestRow.periodYyyymm],
    monthCount: 1,
  };

  const components = {
    common:
      latestRow.perAreaCommon != null
        ? {
            label: "공용관리비",
            ...wonRange(latestRow.perAreaCommon, areaMin, areaMax),
          }
        : null,
    individual:
      latestRow.perAreaIndividual != null
        ? {
            label: "개별사용료",
            ...wonRange(latestRow.perAreaIndividual, areaMin, areaMax),
          }
        : null,
    reserve:
      latestRow.perAreaReserve != null
        ? {
            label: "장기수선충당금",
            ...wonRange(latestRow.perAreaReserve, areaMin, areaMax),
          }
        : null,
  };

  const winterComputed = computeWinterPerM2(
    continuousRows.length >= 2 ? monthsDesc : monthsDesc,
    latestRow.periodYyyymm,
  );
  const winter: PeriodEstimate | null = winterComputed
    ? {
        ...wonRange(winterComputed.avgTotalPerM2, areaMin, areaMax),
        monthsUsed: winterComputed.monthsUsed,
        monthCount: winterComputed.monthsUsed.length,
        hint:
          winterComputed.monthsUsed.length < 3
            ? `${winterComputed.monthsUsed.length}개월 평균`
            : undefined,
      }
    : null;

  const summerComputed = computeSameYearSummerPerM2(
    monthsDesc,
    latestRow.periodYyyymm,
  );
  const summer: PeriodEstimate | null = summerComputed
    ? {
        ...wonRange(summerComputed.avgTotalPerM2, areaMin, areaMax),
        monthsUsed: summerComputed.monthsUsed,
        monthCount: summerComputed.monthsUsed.length,
        hint:
          summerComputed.monthsUsed.length < 3
            ? `${summerComputed.monthsUsed.length}개월 평균`
            : undefined,
      }
    : null;

  const trailingRates = continuousRows
    .map((m) => m.perAreaTotal)
    .filter((v): v is number => v != null);
  const trailingAvg = avg(trailingRates);
  const trailingAverage: PeriodEstimate | null =
    trailingAvg != null && trailingRates.length >= 2
      ? {
          ...wonRange(trailingAvg, areaMin, areaMax),
          monthsUsed: continuousRows.map((m) => m.periodYyyymm),
          monthCount: continuousRows.length,
          hint: `최근 ${continuousRows.length}개월 평균`,
        }
      : null;

  return {
    source: "portal_openapi",
    sourceLabelKo: SOURCE_LABEL_KO,
    kaptCode: params.kaptCode ?? null,
    areaBasis: "residential_exclusive",
    areaBasisLabelKo: "주거전용면적",
    exclusiveAreaMin: Math.min(areaMin, areaMax),
    exclusiveAreaMax: Math.max(areaMin, areaMax),
    latestMonth: latestRow.periodYyyymm,
    latest,
    components,
    winter,
    summer,
    trailingAverage,
    disclaimer: DISCLAIMER,
    knownMissingNote: KNOWN_MISSING_NOTE,
  };
}

/** @deprecated fixture path — prefer estimateSelectedPyeongFromPortal */
export { estimateSelectedPyeongFromPortal as estimateSelectedPyeongMgmtFee };

/** Component KRW sum vs latest total — should match within float noise. */
export function reconcileLatestComponents(
  estimate: SelectedPyeongMgmtFeeEstimate,
): {
  ok: boolean;
  sumMin: number;
  sumMax: number;
  deltaMin: number;
  deltaMax: number;
} {
  const { common, individual, reserve } = estimate.components;
  if (!common || !individual || !reserve) {
    return {
      ok: false,
      sumMin: NaN,
      sumMax: NaN,
      deltaMin: NaN,
      deltaMax: NaN,
    };
  }
  const sumMin = common.wonMin + individual.wonMin + reserve.wonMin;
  const sumMax = common.wonMax + individual.wonMax + reserve.wonMax;
  const deltaMin = Math.abs(sumMin - estimate.latest.wonMin);
  const deltaMax = Math.abs(sumMax - estimate.latest.wonMax);
  return {
    ok: deltaMin < 0.02 && deltaMax < 0.02,
    sumMin,
    sumMax,
    deltaMin,
    deltaMax,
  };
}

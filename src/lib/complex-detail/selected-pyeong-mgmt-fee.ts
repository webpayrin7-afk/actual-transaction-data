/**
 * Selected-pyeong management fee estimates from K-apt area-unit fixtures.
 * amount = perM2 × exclusive residential area (min/max range).
 * No DB writes. No runtime fetch.
 */

import {
  type KaptAreaFeeFixture,
  type KaptAreaFeeMonth,
} from "@/lib/complex-detail/kapt-area-fee-fixture";
import { formatWonAsManwon } from "@/lib/complex-detail/get-complex-detail-v1";

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
  source: "K-apt";
  kaptCode: string;
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
};

const DISCLAIMER =
  "K-apt 단지 관리비를 주거전용면적 기준으로 환산해 선택 평형에 적용한 예상값입니다. 실제 세대별 관리비는 사용량과 부과 기준에 따라 달라질 수 있습니다.";

function sortMonthsDesc(months: KaptAreaFeeMonth[]): KaptAreaFeeMonth[] {
  return [...months].sort((a, b) => b.month.localeCompare(a.month));
}

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

/**
 * Same-calendar-year summer (6·7·8) ≤ latestMonth.
 * Uses only fixture month rows — does not mix prior-year August.
 */
export function computeSameYearSummerPerM2(
  fixture: KaptAreaFeeFixture,
  latestMonth: string,
): { avgTotalPerM2: number; monthsUsed: string[] } | null {
  const y = yearNum(latestMonth);
  const byYm = new Map(fixture.months.map((m) => [m.month, m]));
  const candidates = [6, 7, 8]
    .map((mo) => `${y}${String(mo).padStart(2, "0")}`)
    .filter((ym) => ym <= latestMonth && byYm.has(ym));
  if (candidates.length < 2) return null;
  const rates = candidates.map((ym) => byYm.get(ym)!.totalPerM2);
  const avg = rates.reduce((s, r) => s + r, 0) / rates.length;
  return { avgTotalPerM2: avg, monthsUsed: candidates };
}

/**
 * Build selected-pyeong estimate from a verified fixture + exclusive area range.
 */
export function estimateSelectedPyeongMgmtFee(params: {
  fixture: KaptAreaFeeFixture;
  exclusiveAreaMin: number;
  exclusiveAreaMax: number;
}): SelectedPyeongMgmtFeeEstimate | null {
  const { fixture } = params;
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

  const monthsDesc = sortMonthsDesc(fixture.months);
  const latestRow = monthsDesc[0];
  if (!latestRow) return null;

  const latest: PeriodEstimate = {
    ...wonRange(latestRow.totalPerM2, areaMin, areaMax),
    monthsUsed: [latestRow.month],
    monthCount: 1,
  };

  const components = {
    common:
      latestRow.commonPerM2 != null
        ? {
            label: "공용관리비",
            ...wonRange(latestRow.commonPerM2, areaMin, areaMax),
          }
        : null,
    individual:
      latestRow.individualPerM2 != null
        ? {
            label: "개별사용료",
            ...wonRange(latestRow.individualPerM2, areaMin, areaMax),
          }
        : null,
    reserve:
      latestRow.reservePerM2 != null
        ? {
            label: "장기수선충당금",
            ...wonRange(latestRow.reservePerM2, areaMin, areaMax),
          }
        : null,
  };

  const winterAvg = fixture.verifiedPeriodAverages.find(
    (p) => p.kind === "winter",
  );
  const winter: PeriodEstimate | null = winterAvg
    ? {
        ...wonRange(winterAvg.avgTotalPerM2, areaMin, areaMax),
        monthsUsed: winterAvg.months,
        monthCount: winterAvg.monthCount,
      }
    : null;

  const summerComputed = computeSameYearSummerPerM2(fixture, latestRow.month);
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

  const trailing = fixture.verifiedPeriodAverages.find(
    (p) =>
      p.kind === "trailing_average" &&
      (p.endMonth == null || p.endMonth === latestRow.month),
  );
  const trailingAverage: PeriodEstimate | null = trailing
    ? {
        ...wonRange(trailing.avgTotalPerM2, areaMin, areaMax),
        monthsUsed: trailing.months,
        monthCount: trailing.monthCount,
        hint: `최근 ${trailing.monthCount}개월 평균`,
      }
    : null;

  return {
    source: fixture.source,
    kaptCode: fixture.kaptCode,
    areaBasis: fixture.areaBasis,
    areaBasisLabelKo: fixture.areaBasisLabelKo,
    exclusiveAreaMin: Math.min(areaMin, areaMax),
    exclusiveAreaMax: Math.max(areaMin, areaMax),
    latestMonth: latestRow.month,
    latest,
    components,
    winter,
    summer,
    trailingAverage,
    disclaimer: DISCLAIMER,
  };
}

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

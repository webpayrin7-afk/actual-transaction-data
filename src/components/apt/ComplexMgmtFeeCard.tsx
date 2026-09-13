"use client";

import { useMemo } from "react";
import { LabCard } from "@/components/ui/lab";
import { InfoChip } from "@/components/ui/InfoChip";
import {
  computeSeasonMetric,
  formatWonAsManwon,
  formatYyyymmBasisLabel,
  type ComplexManagementV1,
} from "@/lib/complex-detail/get-complex-detail-v1";

function SummaryCell({
  label,
  valueWon,
  hint,
}: {
  label: string;
  valueWon: number | null;
  hint?: string;
}) {
  return (
    <div className="min-w-0 px-1 py-1 text-center sm:px-2 sm:text-left">
      <p className="text-[10px] font-medium leading-tight text-slate-500 sm:text-[11px]">
        {label}
      </p>
      <p className="lab-kpi-value mt-0.5 truncate text-[13px] font-semibold leading-tight tabular-nums text-slate-900 sm:text-base">
        {formatWonAsManwon(valueWon)}
      </p>
      {hint ? (
        <p className="mt-0.5 truncate text-[9px] leading-snug text-slate-400 sm:text-[10px]">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Compact management-fee summary for Complex Detail.
 * Chart removed — numeric winter / summer / average + component breakdown only.
 * Values remain per-household simple conversions (단지총액 ÷ 세대수).
 */
export function ComplexMgmtFeeCard({
  management,
}: {
  management: ComplexManagementV1;
}) {
  const { latest, average, householdCount, monthlySeries, averageLabel } =
    management;

  const winter = useMemo(
    () =>
      computeSeasonMetric(monthlySeries, latest.periodYyyymm, "winter"),
    [monthlySeries, latest.periodYyyymm],
  );
  const summer = useMemo(
    () =>
      computeSeasonMetric(monthlySeries, latest.periodYyyymm, "summer"),
    [monthlySeries, latest.periodYyyymm],
  );

  const avgPerHh = average.perHouseholdComponentSum;
  const commonPerHh =
    average.commonFee != null
      ? Math.round(average.commonFee / householdCount)
      : null;
  const individualPerHh =
    average.individualFee != null
      ? Math.round(average.individualFee / householdCount)
      : null;
  const reservePerHh =
    average.longTermRepairReserve != null
      ? Math.round(average.longTermRepairReserve / householdCount)
      : null;

  const winterHint =
    winter.valueWon == null
      ? "자료 부족"
      : winter.monthsUsed.length < 3
        ? `${winter.monthsUsed.length}개월 평균`
        : undefined;
  const summerHint =
    summer.valueWon == null
      ? "자료 부족"
      : summer.monthsUsed.length < 3
        ? `${summer.monthsUsed.length}개월 평균`
        : undefined;

  return (
    <LabCard className="p-3.5 sm:p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <h2 className="text-base font-semibold tracking-tight text-slate-900 sm:text-lg">
            관리비
          </h2>
          <InfoChip label="안내" aria-label="관리비 환산 안내">
            <p>{management.disclaimer}</p>
          </InfoChip>
        </div>
        <p className="shrink-0 text-[11px] text-slate-500 sm:text-xs">
          {formatYyyymmBasisLabel(latest.periodYyyymm)}
        </p>
      </div>

      <div className="mt-2.5 grid grid-cols-3 divide-x divide-slate-100 rounded-xl border border-slate-100 bg-slate-50/40">
        <SummaryCell
          label="겨울"
          valueWon={winter.valueWon}
          hint={winterHint}
        />
        <SummaryCell
          label="여름"
          valueWon={summer.valueWon}
          hint={summerHint}
        />
        <SummaryCell label="평균" valueWon={avgPerHh} hint={averageLabel} />
      </div>

      <div className="mt-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-[11px] font-medium text-slate-500 sm:text-xs">
            관리비 구성
          </h3>
          <p className="shrink-0 text-[11px] text-slate-500 sm:text-xs">
            {averageLabel}
          </p>
        </div>
        <div className="mt-2.5 grid grid-cols-3 divide-x divide-slate-100 rounded-xl border border-slate-100 bg-slate-50/40">
          <SummaryCell label="공용관리비" valueWon={commonPerHh} />
          <SummaryCell label="개별사용료" valueWon={individualPerHh} />
          <SummaryCell label="장기수선충당금" valueWon={reservePerHh} />
        </div>
      </div>
    </LabCard>
  );
}

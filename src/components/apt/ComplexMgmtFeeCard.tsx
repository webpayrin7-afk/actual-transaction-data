"use client";

import { LabCard, LabSectionHeading } from "@/components/ui/lab";
import {
  formatWonAsManwon,
  formatYyyymmLabel,
  type ComplexManagementV1,
} from "@/lib/complex-detail/get-complex-detail-v1";

function BreakdownRow({
  label,
  valueWon,
}: {
  label: string;
  valueWon: number | null;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="text-slate-600">{label}</span>
      <span className="font-medium tabular-nums text-slate-900">
        {formatWonAsManwon(valueWon)}
      </span>
    </div>
  );
}

function MgmtSparkline({
  series,
}: {
  series: ComplexManagementV1["monthlySeries"];
}) {
  const values = series
    .map((m) => m.perHouseholdComponentSum)
    .filter((v): v is number => v != null && v > 0);
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(max - min, 1);
  const w = 240;
  const h = 48;
  const pts = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * w;
      const y = h - ((v - min) / span) * (h - 6) - 3;
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="mt-3 h-12 w-full text-teal-700"
      role="img"
      aria-label="세대당 환산 관리비 추이"
    >
      <polyline
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
        points={pts}
      />
    </svg>
  );
}

export function ComplexMgmtFeeCard({
  management,
}: {
  management: ComplexManagementV1;
}) {
  const { latest, average, householdCount } = management;

  return (
    <LabCard className="p-4 sm:p-5">
      <LabSectionHeading
        title="관리비"
        description={`${formatYyyymmLabel(latest.periodYyyymm)} 기준 · 세대당 단순 환산`}
      />

      <div className="mt-4 grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-slate-200/80 bg-slate-50/80 px-3.5 py-3">
          <p className="text-[11px] font-medium text-slate-500">
            세대당 단순 환산 · 최근 월
          </p>
          <p className="mt-1 text-xl font-semibold tabular-nums text-slate-900 sm:text-2xl">
            {formatWonAsManwon(latest.perHouseholdComponentSum)}
          </p>
        </div>
        <div className="rounded-xl border border-slate-200/80 bg-slate-50/80 px-3.5 py-3">
          <p className="text-[11px] font-medium text-slate-500">
            {management.averageLabel}
          </p>
          <p className="mt-1 text-xl font-semibold tabular-nums text-slate-900 sm:text-2xl">
            {formatWonAsManwon(average.perHouseholdComponentSum)}
          </p>
        </div>
      </div>

      <div className="mt-4 space-y-2 border-t border-slate-100 pt-3">
        <p className="text-[11px] font-medium text-slate-400">
          구성 (세대당 환산)
        </p>
        <BreakdownRow
          label="공용관리비"
          valueWon={
            latest.commonFee != null
              ? Math.round(latest.commonFee / householdCount)
              : null
          }
        />
        <BreakdownRow
          label="개별사용료"
          valueWon={
            latest.individualFee != null
              ? Math.round(latest.individualFee / householdCount)
              : null
          }
        />
        <BreakdownRow
          label="장기수선충당금"
          valueWon={
            latest.longTermRepairReserve != null
              ? Math.round(latest.longTermRepairReserve / householdCount)
              : null
          }
        />
      </div>

      <MgmtSparkline series={management.monthlySeries} />

      <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
        {management.disclaimer}
      </p>
    </LabCard>
  );
}

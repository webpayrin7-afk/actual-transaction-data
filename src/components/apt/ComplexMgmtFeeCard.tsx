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

function shortManwon(won: number): string {
  const man = Math.round(won / 10000);
  if (man >= 10000) return `${(man / 10000).toFixed(1)}억`;
  return `${man.toLocaleString("ko-KR")}만`;
}

function MgmtSparkline({
  series,
}: {
  series: ComplexManagementV1["monthlySeries"];
}) {
  const points = series.filter(
    (m): m is ComplexManagementV1["monthlySeries"][number] & {
      perHouseholdComponentSum: number;
    } =>
      m.perHouseholdComponentSum != null && m.perHouseholdComponentSum > 0,
  );
  if (points.length < 2) return null;

  const values = points.map((m) => m.perHouseholdComponentSum);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(max - min, 1);

  const w = 280;
  const h = 88;
  const padL = 34;
  const padR = 8;
  const padT = 10;
  const padB = 18;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  const pts = values
    .map((v, i) => {
      const x = padL + (i / (values.length - 1)) * plotW;
      const y = padT + plotH - ((v - min) / span) * plotH;
      return `${x},${y}`;
    })
    .join(" ");

  const firstLabel = formatYyyymmLabel(points[0]!.periodYyyymm);
  const lastLabel = formatYyyymmLabel(points[points.length - 1]!.periodYyyymm);

  return (
    <div className="mt-4 rounded-xl border border-slate-200/90 bg-slate-50/70 px-2.5 py-2.5">
      <p className="mb-1.5 text-[11px] font-medium text-slate-500">
        세대당 환산 추이
      </p>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="h-[4.75rem] w-full text-teal-700"
        role="img"
        aria-label="세대당 환산 관리비 추이"
      >
        <rect
          x={padL}
          y={padT}
          width={plotW}
          height={plotH}
          rx={6}
          className="fill-white stroke-slate-200"
          strokeWidth={1}
        />
        <line
          x1={padL}
          y1={padT + plotH / 2}
          x2={padL + plotW}
          y2={padT + plotH / 2}
          className="stroke-slate-100"
          strokeWidth={1}
        />
        <text
          x={padL - 4}
          y={padT + 3}
          textAnchor="end"
          dominantBaseline="hanging"
          className="fill-slate-400"
          fontSize={8}
        >
          {shortManwon(max)}
        </text>
        <text
          x={padL - 4}
          y={padT + plotH}
          textAnchor="end"
          dominantBaseline="auto"
          className="fill-slate-400"
          fontSize={8}
        >
          {shortManwon(min)}
        </text>
        <text
          x={padL}
          y={h - 3}
          textAnchor="start"
          className="fill-slate-400"
          fontSize={8}
        >
          {firstLabel}
        </text>
        <text
          x={padL + plotW}
          y={h - 3}
          textAnchor="end"
          className="fill-slate-400"
          fontSize={8}
        >
          {lastLabel}
        </text>
        <polyline
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
          points={pts}
        />
      </svg>
    </div>
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

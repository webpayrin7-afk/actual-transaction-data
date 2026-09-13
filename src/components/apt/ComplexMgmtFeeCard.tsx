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

/** Keep months within the trailing 24-month window ending at the latest point. */
function lastTwoYears(
  points: Array<
    ComplexManagementV1["monthlySeries"][number] & {
      perHouseholdComponentSum: number;
    }
  >,
) {
  if (points.length === 0) return points;
  const end = points[points.length - 1]!.periodYyyymm;
  const endY = Number(end.slice(0, 4));
  const endM = Number(end.slice(4, 6));
  let startY = endY - 2;
  let startM = endM + 1;
  if (startM > 12) {
    startY += 1;
    startM -= 12;
  }
  const startKey = `${startY}${String(startM).padStart(2, "0")}`;
  const filtered = points.filter((p) => p.periodYyyymm >= startKey);
  return filtered.length >= 2 ? filtered : points.slice(-Math.min(24, points.length));
}

/**
 * Region-browse style mini chart: compact card, value row, path + dots,
 * footer range labeled as the recent 2-year window.
 */
function MgmtSparkline({
  series,
}: {
  series: ComplexManagementV1["monthlySeries"];
}) {
  const allPoints = series.filter(
    (m): m is ComplexManagementV1["monthlySeries"][number] & {
      perHouseholdComponentSum: number;
    } =>
      m.perHouseholdComponentSum != null && m.perHouseholdComponentSum > 0,
  );
  const points = lastTwoYears(allPoints);
  if (points.length < 2) return null;

  const values = points.map((m) => m.perHouseholdComponentSum);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(max - min, 1);
  const latest = points[points.length - 1]!;
  const first = points[0]!;

  const width = 320;
  const height = 48;
  const padX = 8;
  const padY = 8;
  const coords = values.map((v, i) => {
    const x = padX + (i / (values.length - 1)) * (width - padX * 2);
    const y = padY + (1 - (v - min) / range) * (height - padY * 2);
    return { x, y };
  });
  const path = coords
    .map((c, i) => `${i === 0 ? "M" : "L"}${c.x.toFixed(1)} ${c.y.toFixed(1)}`)
    .join(" ");
  const firstCoord = coords[0]!;
  const lastCoord = coords[coords.length - 1]!;

  return (
    <div className="mt-4 rounded-md border border-slate-200 bg-slate-50/70 px-2 py-1.5">
      <div className="flex items-baseline justify-between gap-2 text-[10px] tabular-nums text-slate-500">
        <span>{shortManwon(first.perHouseholdComponentSum)}</span>
        <span className="font-medium text-slate-700">
          최근 {shortManwon(latest.perHouseholdComponentSum)}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="mt-0.5 h-12 w-full text-teal-700"
        role="img"
        aria-label="세대당 환산 관리비 최근 2년 추이"
      >
        <path
          d={path}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <circle
          cx={firstCoord.x}
          cy={firstCoord.y}
          r="2.2"
          fill="currentColor"
        />
        <circle
          cx={lastCoord.x}
          cy={lastCoord.y}
          r="3.2"
          fill="currentColor"
        />
      </svg>
      {/* Horizontal labels: recent 2-year window endpoints */}
      <div className="mt-0.5 flex items-center justify-between gap-2 text-[10px] tabular-nums leading-4 text-slate-500">
        <span>{formatYyyymmLabel(first.periodYyyymm)}</span>
        <span className="text-slate-400">최근 2년 · 세대당 환산</span>
        <span>{formatYyyymmLabel(latest.periodYyyymm)}</span>
      </div>
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

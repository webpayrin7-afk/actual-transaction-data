import { formatEok } from "@/lib/utils/format";

function dayTime(date: string): number {
  return new Date(`${date.slice(0, 10)}T00:00:00`).getTime();
}

function yearMonthDot(date: string): string {
  const d = date.slice(0, 10);
  return `${d.slice(0, 4)}.${d.slice(5, 7)}`;
}

export function TypePriceSparkline({
  points,
  currentAmount,
  currentDate,
}: {
  points: { date: string; amount: number }[];
  currentAmount: number;
  currentDate: string;
}) {
  if (points.length < 3) return null;

  const width = 320;
  const height = 48;
  const padX = 8;
  const padY = 8;
  const amounts = points.map((p) => p.amount);
  const min = Math.min(...amounts);
  const max = Math.max(...amounts);
  const range = max - min || 1;
  const times = points.map((p) => dayTime(p.date));
  const t0 = Math.min(...times);
  const t1 = Math.max(...times);
  const span = t1 - t0 || 1;
  const currentDay = currentDate.slice(0, 10);
  const coords = points.map((point, index) => {
    const x = padX + ((times[index]! - t0) / span) * (width - padX * 2);
    const y =
      padY + (1 - (point.amount - min) / range) * (height - padY * 2);
    const isCurrent =
      point.date.slice(0, 10) === currentDay && point.amount === currentAmount;
    return { x, y, isCurrent };
  });
  const path = coords
    .map((c, i) => `${i === 0 ? "M" : "L"}${c.x.toFixed(1)} ${c.y.toFixed(1)}`)
    .join(" ");
  const first = coords[0]!;
  const current =
    [...coords].reverse().find((c) => c.isCurrent) ?? coords[coords.length - 1]!;
  const firstPoint = points[0]!;
  const lastPoint = points[points.length - 1]!;

  return (
    <div className="mt-2 rounded-md border border-slate-200 bg-slate-50/70 px-2 py-1.5">
      <div className="flex items-baseline justify-between gap-2 text-[10px] tabular-nums text-slate-500">
        <span>{formatEok(firstPoint.amount)}</span>
        <span className="font-medium text-slate-700">
          현재 {formatEok(currentAmount)}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="mt-0.5 h-12 w-full text-teal-700"
        role="img"
        aria-label="동일 전용면적 최근 거래 가격 추이"
      >
        <path
          d={path}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <circle cx={first.x} cy={first.y} r="2.2" fill="currentColor" />
        <circle cx={current.x} cy={current.y} r="3.2" fill="currentColor" />
      </svg>
      <p className="mt-0.5 text-[10px] leading-4 text-slate-500">
        {yearMonthDot(firstPoint.date)}–{yearMonthDot(lastPoint.date)} · 동일 전용면적
      </p>
    </div>
  );
}

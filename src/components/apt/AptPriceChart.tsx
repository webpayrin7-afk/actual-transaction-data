"use client";

import { useMemo, useRef } from "react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipProps,
} from "recharts";
import type { AptChartPoint } from "@/lib/molit/apt-client";
import { labSecondaryTabClass } from "@/components/ui/lab";

const CHART_COLORS = {
  trade: "#2563eb",
  jeonse: "#ea580c",
  volume: "#0f766e",
  volumeBar: "#2dd4bf",
} as const;

function seriesTextColor(name: string): string {
  if (name === "거래량") return CHART_COLORS.volume;
  if (name === "매매 평균") return CHART_COLORS.trade;
  if (name === "전세 평균") return CHART_COLORS.jeonse;
  return "#334155";
}

function ChartTooltip({
  active,
  payload,
}: TooltipProps<number, string>) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload as AptChartPoint | undefined;
  const ym = row?.yearMonth;

  return (
    <div className="max-w-[min(16rem,calc(100vw-2rem))] rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs shadow-md">
      <p className="mb-1.5 font-medium text-slate-800">
        {ym ? formatYmLabel(ym) : ""}
      </p>
      <ul className="space-y-0.5">
        {payload.map((item) => {
          const name = String(item.name ?? "");
          const isVolume = name === "거래량";
          const value = item.value;
          return (
            <li
              key={name}
              className="flex items-center justify-between gap-3 font-medium sm:gap-4"
              style={{
                color: seriesTextColor(name),
              }}
            >
              <span className="shrink-0">{name}</span>
              <span className="tabular-nums">
                {value == null ? "—" : isVolume ? `${value}건` : `${value}억`}
              </span>
            </li>
          );
        })}
      </ul>
      {row?.tradeMax != null && row.tradeMax > 0 ? (
        <p className="mt-1.5 border-t border-slate-100 pt-1.5 text-[11px] text-slate-500">
          당월 매매 최고{" "}
          <span className="font-semibold tabular-nums text-slate-700">
            {toEok(row.tradeMax)}억
          </span>
        </p>
      ) : null}
    </div>
  );
}

function toEok(manwon: number | null | undefined): number | null {
  if (manwon == null || !Number.isFinite(manwon) || manwon <= 0) return null;
  return Math.round((manwon / 10000) * 100) / 100;
}

function formatYmLabel(ym: string): string {
  if (ym.length !== 6) return ym;
  return `${ym.slice(2, 4)}년 ${Number(ym.slice(4, 6))}월`;
}

export function AptPriceChart({
  points,
}: {
  points: AptChartPoint[];
}) {
  const data = useMemo(
    () =>
      points.map((p) => ({
        ...p,
        tradeEok: toEok(p.tradeAvg),
        jeonseEok: toEok(p.jeonseAvg),
      })),
    [points],
  );

  if (data.length === 0) {
    return (
      <div className="flex h-56 items-center justify-center rounded-xl border border-dashed border-slate-300 text-sm text-slate-500">
        선택한 기간의 시세 데이터가 없습니다.
      </div>
    );
  }

  return (
    <div className="h-56 w-full sm:h-64">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          data={data}
          margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
          <XAxis
            dataKey="yearMonth"
            tickFormatter={(ym: string) =>
              ym.endsWith("01") ? `${ym.slice(2, 4)}년` : ""
            }
            interval="preserveStartEnd"
            minTickGap={28}
            tick={{ fill: "#475569", fontSize: 11 }}
            axisLine={{ stroke: "#cbd5e1" }}
            tickLine={false}
          />
          <YAxis
            yAxisId="price"
            tickFormatter={(v: number) => `${v}억`}
            tick={{ fill: "#64748b", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={42}
          />
          <YAxis
            yAxisId="volume"
            orientation="right"
            tickFormatter={(v: number) => `${v}건`}
            tick={{ fill: CHART_COLORS.volume, fontSize: 11, fontWeight: 600 }}
            axisLine={false}
            tickLine={false}
            width={40}
            allowDecimals={false}
          />
          <Tooltip
            content={<ChartTooltip />}
            allowEscapeViewBox={{ x: true, y: true }}
            wrapperStyle={{ zIndex: 40, outline: "none" }}
            offset={12}
          />
          <Legend
            verticalAlign="top"
            height={28}
            iconType="circle"
            wrapperStyle={{ fontSize: 12, color: "#334155" }}
            formatter={(value) => (
              <span
                style={{
                  color: seriesTextColor(String(value)),
                  fontWeight: 600,
                }}
              >
                {value}
              </span>
            )}
          />
          <Bar
            yAxisId="volume"
            dataKey="volume"
            name="거래량"
            fill={CHART_COLORS.volumeBar}
            opacity={0.9}
            barSize={6}
            radius={[2, 2, 0, 0]}
          />
          <Line
            yAxisId="price"
            type="monotone"
            dataKey="tradeEok"
            name="매매 평균"
            stroke={CHART_COLORS.trade}
            strokeWidth={2.4}
            dot={{ r: 2.5, fill: CHART_COLORS.trade, strokeWidth: 0 }}
            activeDot={{ r: 4 }}
            connectNulls
          />
          <Line
            yAxisId="price"
            type="monotone"
            dataKey="jeonseEok"
            name="전세 평균"
            stroke={CHART_COLORS.jeonse}
            strokeWidth={2}
            dot={{ r: 2, fill: CHART_COLORS.jeonse, strokeWidth: 0 }}
            activeDot={{ r: 4 }}
            connectNulls
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

type DragHandle = "start" | "end";

export function PeriodRangeSlider({
  months,
  startIndex,
  endIndex,
  onChange,
  onRecentYears,
  onFullRange,
  activePreset = null,
  showPresets = true,
}: {
  months: string[];
  startIndex: number;
  endIndex: number;
  onChange: (start: number, end: number) => void;
  onRecentYears?: (years: number) => void;
  onFullRange?: () => void;
  activePreset?: "recent1" | "recent3" | "recent5" | "full" | null;
  /** When false, presets are expected in the parent section header. */
  showPresets?: boolean;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const valuesRef = useRef({ startIndex, endIndex });

  if (months.length === 0) return null;

  const startYm = months[startIndex] ?? months[0];
  const endYm = months[endIndex] ?? months[months.length - 1];
  const max = months.length - 1;
  const startPct = max <= 0 ? 0 : (startIndex / max) * 100;
  const endPct = max <= 0 ? 100 : (endIndex / max) * 100;

  const indexFromClientX = (clientX: number) => {
    const track = trackRef.current;
    if (!track || max <= 0) return 0;
    const rect = track.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return Math.round(ratio * max);
  };

  const applyDrag = (clientX: number, handle: DragHandle) => {
    const next = indexFromClientX(clientX);
    const { startIndex: s, endIndex: e } = valuesRef.current;
    if (handle === "start") {
      const start = Math.min(next, e);
      valuesRef.current = { startIndex: start, endIndex: e };
      onChange(start, e);
    } else {
      const end = Math.max(next, s);
      valuesRef.current = { startIndex: s, endIndex: end };
      onChange(s, end);
    }
  };

  const pickHandle = (clientX: number): DragHandle => {
    const idx = indexFromClientX(clientX);
    const { startIndex: s, endIndex: e } = valuesRef.current;
    return Math.abs(idx - s) <= Math.abs(idx - e) ? "start" : "end";
  };

  const beginDrag = (
    event: React.PointerEvent<HTMLElement>,
    handle?: DragHandle,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    valuesRef.current = { startIndex, endIndex };
    const selected = handle ?? pickHandle(event.clientX);
    applyDrag(event.clientX, selected);

    const onMove = (ev: PointerEvent) => applyDrag(ev.clientX, selected);
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const presetBtn = (active: boolean) => labSecondaryTabClass(active);

  return (
    <div className="mt-2 space-y-1">
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-xs">
        <p className="font-medium tabular-nums text-slate-700">
          {formatYmLabel(startYm)}
          <span className="mx-1 text-slate-400">~</span>
          {formatYmLabel(endYm)}
        </p>
        {showPresets ? (
          <div className="flex w-fit flex-wrap items-center gap-1">
            {onRecentYears
              ? ([1, 3, 5] as const).map((years) => {
                  const key =
                    years === 1 ? "recent1" : years === 3 ? "recent3" : "recent5";
                  const pressed = activePreset === key;
                  return (
                    <button
                      key={years}
                      type="button"
                      onClick={() => onRecentYears(years)}
                      aria-pressed={pressed}
                      className={presetBtn(pressed)}
                    >
                      {years}년
                    </button>
                  );
                })
              : null}
            {onFullRange ? (
              <button
                type="button"
                onClick={onFullRange}
                aria-pressed={activePreset === "full"}
                className={presetBtn(activePreset === "full")}
              >
                전체
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="relative h-7 touch-none select-none">
        <div
          ref={trackRef}
          className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 cursor-pointer rounded-full bg-slate-200"
          onPointerDown={(e) => beginDrag(e)}
        >
          <div
            className="absolute top-0 h-full rounded-full bg-teal-600"
            style={{
              left: `${startPct}%`,
              width: `${Math.max(endPct - startPct, 0)}%`,
            }}
          />
        </div>

        <button
          type="button"
          role="slider"
          aria-label="시작 기간"
          aria-valuemin={0}
          aria-valuemax={max}
          aria-valuenow={startIndex}
          className="absolute top-1/2 z-30 h-4 w-4 -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-full border-2 border-teal-700 bg-white shadow-md active:cursor-grabbing"
          style={{ left: `${startPct}%` }}
          onPointerDown={(e) => beginDrag(e, "start")}
        />
        <button
          type="button"
          role="slider"
          aria-label="종료 기간"
          aria-valuemin={0}
          aria-valuemax={max}
          aria-valuenow={endIndex}
          className="absolute top-1/2 z-30 h-4 w-4 -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-full border-2 border-teal-700 bg-white shadow-md active:cursor-grabbing"
          style={{ left: `${endPct}%` }}
          onPointerDown={(e) => beginDrag(e, "end")}
        />
      </div>

      <div className="flex justify-between text-[10px] leading-none text-slate-500">
        <span>{formatYmLabel(months[0])}</span>
        <span>{formatYmLabel(months[months.length - 1])}</span>
      </div>
    </div>
  );
}

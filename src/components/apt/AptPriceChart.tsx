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
} from "recharts";
import type { AptChartPoint } from "@/lib/molit/apt";

function toEok(manwon: number | null | undefined): number | null {
  if (manwon == null || !Number.isFinite(manwon) || manwon <= 0) return null;
  return Math.round((manwon / 10000) * 100) / 100;
}

function formatYmLabel(ym: string): string {
  if (ym.length !== 6) return ym;
  return `${ym.slice(2, 4)}년 ${Number(ym.slice(4, 6))}월`;
}

/** Recharts category tick — "24.01" 숫자 파싱을 피하기 위해 slash 라벨 사용 */
function axisLabelFromYm(ym: string): string {
  if (ym.length !== 6) return ym;
  return `${ym.slice(2, 4)}/${ym.slice(4, 6)}`;
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
        axisLabel: axisLabelFromYm(p.yearMonth),
        tradeEok: toEok(p.tradeAvg),
        jeonseEok: toEok(p.jeonseAvg),
      })),
    [points],
  );

  /** 약 6개 눈금 + 시작·끝 월 항상 표시 (interval만 쓰면 끝 라벨이 빠짐) */
  const xTicks = useMemo(() => {
    const n = data.length;
    if (n === 0) return [] as string[];
    if (n <= 6) return data.map((d) => d.axisLabel);
    const idxs = new Set<number>([0, n - 1]);
    for (let i = 1; i <= 4; i += 1) {
      idxs.add(Math.round((i * (n - 1)) / 5));
    }
    return [...idxs]
      .sort((a, b) => a - b)
      .map((i) => data[i]!.axisLabel);
  }, [data]);

  if (data.length === 0) {
    return (
      <div className="flex h-56 items-center justify-center rounded-xl border border-dashed border-slate-300 text-sm text-slate-500">
        선택한 기간의 시세 데이터가 없습니다.
      </div>
    );
  }

  return (
    <div className="h-64 w-full sm:h-72">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          data={data}
          margin={{ top: 8, right: 8, left: 0, bottom: 4 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
          <XAxis
            type="category"
            dataKey="axisLabel"
            ticks={xTicks}
            interval={0}
            tick={{ fill: "#64748b", fontSize: 11 }}
            axisLine={{ stroke: "#cbd5e1" }}
            tickLine={false}
            allowDuplicatedCategory={false}
            height={28}
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
            tick={{ fill: "#0f766e", fontSize: 11, fontWeight: 600 }}
            axisLine={false}
            tickLine={false}
            width={40}
            allowDecimals={false}
          />
          <Tooltip
            contentStyle={{
              borderRadius: 12,
              border: "1px solid #e2e8f0",
              boxShadow: "0 8px 24px rgba(15,23,42,0.08)",
            }}
            labelFormatter={(_label, payload) => {
              const ym = payload?.[0]?.payload?.yearMonth;
              return ym ? formatYmLabel(String(ym)) : String(_label ?? "");
            }}
            formatter={(value: number | string, name: string) => {
              if (name === "거래량") return [`${value}건`, name];
              if (value == null || value === "") return ["-", name];
              return [`${value}억`, name];
            }}
          />
          <Legend
            verticalAlign="top"
            height={28}
            iconType="circle"
            wrapperStyle={{ fontSize: 12, color: "#334155" }}
            formatter={(value) => (
              <span
                style={{
                  color: value === "거래량" ? "#0f766e" : "#334155",
                  fontWeight: value === "거래량" ? 600 : 500,
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
            fill="#2dd4bf"
            opacity={0.9}
            barSize={6}
            radius={[2, 2, 0, 0]}
          />
          <Line
            yAxisId="price"
            type="monotone"
            dataKey="tradeEok"
            name="매매 평균"
            stroke="#0f766e"
            strokeWidth={2.4}
            dot={{ r: 2.5, fill: "#0f766e", strokeWidth: 0 }}
            activeDot={{ r: 4 }}
            connectNulls
          />
          <Line
            yAxisId="price"
            type="monotone"
            dataKey="jeonseEok"
            name="전세 평균"
            stroke="#ea580c"
            strokeWidth={2}
            dot={{ r: 2, fill: "#ea580c", strokeWidth: 0 }}
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
}: {
  months: string[];
  startIndex: number;
  endIndex: number;
  onChange: (start: number, end: number) => void;
  onRecentYears?: (years: number) => void;
  onFullRange?: () => void;
  activePreset?: "recent3" | "full" | null;
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

  const presetBtn = (active: boolean) =>
    `rounded-lg px-3 py-1.5 text-sm font-medium transition ${
      active
        ? "bg-teal-700 text-white shadow-sm"
        : "bg-slate-100 text-slate-600 hover:bg-slate-200 hover:text-slate-900"
    }`;

  return (
    <div className="mt-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <p className="font-medium text-slate-800">
          {formatYmLabel(startYm)}
          <span className="mx-1.5 text-slate-400">~</span>
          {formatYmLabel(endYm)}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {onRecentYears ? (
            <button
              type="button"
              onClick={() => onRecentYears(3)}
              aria-pressed={activePreset === "recent3"}
              className={presetBtn(activePreset === "recent3")}
            >
              최근 3년
            </button>
          ) : null}
          {onFullRange ? (
            <button
              type="button"
              onClick={onFullRange}
              aria-pressed={activePreset === "full"}
              className={presetBtn(activePreset === "full")}
            >
              전체 기간
            </button>
          ) : null}
        </div>
      </div>

      <div className="relative h-10 touch-none select-none">
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
          className="absolute top-1/2 z-30 h-5 w-5 -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-full border-2 border-teal-700 bg-white shadow-md active:cursor-grabbing"
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
          className="absolute top-1/2 z-30 h-5 w-5 -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-full border-2 border-teal-700 bg-white shadow-md active:cursor-grabbing"
          style={{ left: `${endPct}%` }}
          onPointerDown={(e) => beginDrag(e, "end")}
        />
      </div>

      <div className="flex justify-between text-[11px] text-slate-500">
        <span>{formatYmLabel(months[0])}</span>
        <span>{formatYmLabel(months[months.length - 1])}</span>
      </div>
    </div>
  );
}

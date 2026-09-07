"use client";

import { useMemo } from "react";
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
    <div className="h-64 w-full sm:h-72">
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
            tick={{ fill: "#64748b", fontSize: 11 }}
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
            tick={{ fill: "#94a3b8", fontSize: 11 }}
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
            labelFormatter={(ym) => formatYmLabel(String(ym))}
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
            wrapperStyle={{ fontSize: 12, color: "#475569" }}
          />
          <Bar
            yAxisId="volume"
            dataKey="volume"
            name="거래량"
            fill="#99f6e4"
            opacity={0.85}
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

export function PeriodRangeSlider({
  months,
  startIndex,
  endIndex,
  onChange,
  onRecentYears,
}: {
  months: string[];
  startIndex: number;
  endIndex: number;
  onChange: (start: number, end: number) => void;
  onRecentYears?: (years: number) => void;
}) {
  if (months.length === 0) return null;

  const startYm = months[startIndex] ?? months[0];
  const endYm = months[endIndex] ?? months[months.length - 1];
  const max = months.length - 1;

  return (
    <div className="mt-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <p className="font-medium text-slate-800">
          {formatYmLabel(startYm)}
          <span className="mx-1.5 text-slate-400">~</span>
          {formatYmLabel(endYm)}
        </p>
        {onRecentYears ? (
          <button
            type="button"
            onClick={() => onRecentYears(3)}
            className="text-sm font-medium text-teal-700 hover:text-teal-800 hover:underline"
          >
            최근 3년 보기
          </button>
        ) : null}
      </div>

      <div className="relative h-8">
        <div className="absolute top-1/2 right-0 left-0 h-1.5 -translate-y-1/2 rounded-full bg-slate-200" />
        <div
          className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-teal-600"
          style={{
            left: `${(startIndex / Math.max(max, 1)) * 100}%`,
            right: `${100 - (endIndex / Math.max(max, 1)) * 100}%`,
          }}
        />
        <input
          aria-label="시작 기간"
          type="range"
          min={0}
          max={max}
          value={startIndex}
          onChange={(e) => {
            const next = Number(e.target.value);
            onChange(Math.min(next, endIndex), endIndex);
          }}
          className="pointer-events-none absolute inset-0 w-full appearance-none bg-transparent [&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:cursor-pointer [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-teal-700 [&::-moz-range-thumb]:bg-white [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:relative [&::-webkit-slider-thumb]:z-20 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-teal-700 [&::-webkit-slider-thumb]:bg-white"
        />
        <input
          aria-label="종료 기간"
          type="range"
          min={0}
          max={max}
          value={endIndex}
          onChange={(e) => {
            const next = Number(e.target.value);
            onChange(startIndex, Math.max(next, startIndex));
          }}
          className="pointer-events-none absolute inset-0 w-full appearance-none bg-transparent [&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:cursor-pointer [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-teal-700 [&::-moz-range-thumb]:bg-white [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:relative [&::-webkit-slider-thumb]:z-30 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-teal-700 [&::-webkit-slider-thumb]:bg-white"
        />
      </div>

      <div className="flex justify-between text-[11px] text-slate-500">
        <span>{formatYmLabel(months[0])}</span>
        <span>{formatYmLabel(months[months.length - 1])}</span>
      </div>
    </div>
  );
}

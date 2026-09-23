"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Area,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { LabTabs } from "@/components/ui/LabTabs";
import { InfoTip } from "@/components/ui/InfoTip";
import type {
  RegionPriceTrend,
  RegionPriceTrendPoint,
} from "@/lib/region/region-price-trend";
import { seoulToday, yearMonthFromSeoulDate } from "@/lib/market/time";

const PERIODS = [
  { id: "3y", label: "최근 3년" },
  { id: "all", label: "전체 기간" },
] as const;
type PeriodId = (typeof PERIODS)[number]["id"];

type ChartRow = RegionPriceTrendPoint & { label: string; partial: boolean };

function ymDot(ym: string): string {
  return `${ym.slice(0, 4)}.${ym.slice(4, 6)}`;
}

function formatManwon(n: number): string {
  return `${Math.round(n).toLocaleString("ko-KR")}만원`;
}

function formatAxisManwon(n: number): string {
  const thousands = Math.round(n / 1000);
  if (thousands >= 10) return `${(thousands / 10).toFixed(1).replace(/\.0$/, "")}억`;
  return `${thousands}천`;
}

function signedManwon(n: number): string {
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return `${sign}${Math.abs(Math.round(n)).toLocaleString("ko-KR")}만원`;
}

function toneClass(n: number | null): string {
  if (n == null || n === 0) return "text-slate-500";
  return n > 0 ? "text-rose-600" : "text-blue-600";
}

export function RegionPriceTrendChart({
  lawdCd,
  regionName,
}: {
  lawdCd: string;
  regionName: string;
}) {
  const [period, setPeriod] = useState<PeriodId>("3y");
  const [selected, setSelected] = useState<string | null>(null);
  const currentYm = yearMonthFromSeoulDate(seoulToday());

  const query = useQuery({
    queryKey: ["region-price-trend", lawdCd],
    queryFn: async () => {
      const res = await fetch(`/api/region-price-trend?lawd_cd=${lawdCd}`);
      if (!res.ok) throw new Error("trend");
      return (await res.json()) as RegionPriceTrend;
    },
    staleTime: 30 * 60_000,
    retry: 1,
  });

  const all = useMemo<ChartRow[]>(
    () =>
      (query.data?.points ?? []).map((p) => ({
        ...p,
        label: ymDot(p.yearMonth),
        partial: p.yearMonth === currentYm,
      })),
    [query.data, currentYm],
  );
  const rows = useMemo(
    () => (period === "3y" ? all.slice(-36) : all),
    [all, period],
  );

  const selectedIndex = Math.max(
    0,
    selected ? rows.findIndex((r) => r.yearMonth === selected) : rows.length - 1,
  );
  const current = rows[selectedIndex] ?? null;
  const prevRow = selectedIndex > 0 ? rows[selectedIndex - 1] : null;
  const yearAgo =
    current != null
      ? all.find(
          (r) =>
            r.yearMonth ===
            `${Number(current.yearMonth.slice(0, 4)) - 1}${current.yearMonth.slice(4, 6)}`,
        ) ?? null
      : null;
  const momDiff = current && prevRow ? current.medianPyeongPrice - prevRow.medianPyeongPrice : null;
  const yoyDiff = current && yearAgo ? current.medianPyeongPrice - yearAgo.medianPyeongPrice : null;
  const pct = (diff: number | null, base: RegionPriceTrendPoint | null) =>
    diff != null && base && base.medianPyeongPrice > 0
      ? ` (${((diff / base.medianPyeongPrice) * 100).toFixed(1)}%)`
      : "";

  if (query.isError) return null;

  const yearTicks = rows
    .filter((r) => r.yearMonth.endsWith("01"))
    .map((r) => r.label);

  return (
    <div className="flex flex-col gap-2.5 border-t border-slate-100 pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center">
          <p className="text-[14px] font-semibold text-slate-900">
            {regionName} 월별 평당가
          </p>
          <InfoTip aria-label="월별 평당가 안내">
            <p>
              계약월별 매매 실거래의 전용면적 기준 평당가 중앙값입니다. 전체
              평형을 합산하므로 위의 평형대별 대표 평당가와 기준이 다릅니다.
              이번 달 값은 거래 신고 기간 중이라 바뀔 수 있습니다.
            </p>
          </InfoTip>
        </div>
        <LabTabs
          variant="compact"
          ariaLabel="그래프 기간"
          equalWidth={false}
          items={PERIODS}
          value={period}
          onChange={(next) => {
            setPeriod(next);
            setSelected(null);
          }}
        />
      </div>

      {query.isLoading ? (
        <div className="h-56 animate-pulse rounded-lg bg-slate-100" />
      ) : rows.length < 2 ? (
        <p className="text-sm text-slate-500">그래프를 그릴 거래가 부족합니다.</p>
      ) : (
        <>
          <div className="h-56 w-full sm:h-64">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart
                data={rows}
                margin={{ top: 8, right: 4, bottom: 0, left: -12 }}
                onClick={(state) => {
                  const ym = rows[Number(state?.activeTooltipIndex)]?.yearMonth;
                  if (ym) setSelected(ym);
                }}
                onMouseMove={(state) => {
                  const ym = rows[Number(state?.activeTooltipIndex)]?.yearMonth;
                  if (ym && ym !== selected) setSelected(ym);
                }}
              >
                <XAxis
                  dataKey="label"
                  ticks={yearTicks}
                  tickFormatter={(v: string) => v.slice(0, 4)}
                  tick={{ fontSize: 11, fill: "#64748b" }}
                  tickLine={false}
                  axisLine={{ stroke: "#e2e8f0" }}
                  interval={0}
                />
                <YAxis
                  yAxisId="price"
                  domain={["auto", "auto"]}
                  tickFormatter={formatAxisManwon}
                  tick={{ fontSize: 11, fill: "#64748b" }}
                  tickLine={false}
                  axisLine={false}
                  width={44}
                />
                <YAxis
                  yAxisId="volume"
                  orientation="right"
                  hide
                  domain={[0, (max: number) => max * 2.6]}
                />
                <Tooltip
                  cursor={{ stroke: "#94a3b8", strokeDasharray: "3 3" }}
                  content={() => null}
                />
                <Area
                  yAxisId="volume"
                  dataKey="tradeCount"
                  type="monotone"
                  stroke="none"
                  fill="#99f6e4"
                  fillOpacity={0.55}
                  isAnimationActive={false}
                  name="거래량"
                />
                <Line
                  yAxisId="price"
                  dataKey="medianPyeongPrice"
                  type="monotone"
                  stroke="#0f766e"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4, fill: "#0f766e", stroke: "#fff", strokeWidth: 2 }}
                  isAnimationActive={false}
                  name="평당가"
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <p className="-mt-1 flex items-center gap-3 text-[11px] text-slate-500">
            <span className="inline-flex items-center gap-1">
              <span className="h-0.5 w-3 rounded bg-teal-700" aria-hidden /> 평당가
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-3 rounded-sm bg-teal-200" aria-hidden /> 거래량
            </span>
          </p>

          {current ? (
            <div className="rounded-lg bg-slate-50 px-3 py-2.5" aria-live="polite">
              <div className="flex items-baseline justify-between gap-2">
                <p className="text-[13px] font-semibold tabular-nums text-slate-800">
                  {current.label}
                  {current.partial ? (
                    <span className="ml-1 text-[11px] font-normal text-slate-500">
                      (진행 중)
                    </span>
                  ) : null}
                </p>
                <p className="text-[12px] tabular-nums text-slate-500">
                  거래 {current.tradeCount.toLocaleString("ko-KR")}건
                </p>
              </div>
              <p className="mt-1 text-[20px] font-bold leading-none tabular-nums text-slate-900">
                {formatManwon(current.medianPyeongPrice)}
              </p>
              <div className="mt-2 grid grid-cols-2 gap-2 text-[12px] tabular-nums">
                <p className="flex justify-between gap-1">
                  <span className="text-slate-500">전월 대비</span>
                  <span className={toneClass(momDiff)}>
                    {momDiff != null ? `${signedManwon(momDiff)}${pct(momDiff, prevRow)}` : "—"}
                  </span>
                </p>
                <p className="flex justify-between gap-1">
                  <span className="text-slate-500">전년 대비</span>
                  <span className={toneClass(yoyDiff)}>
                    {yoyDiff != null ? `${signedManwon(yoyDiff)}${pct(yoyDiff, yearAgo)}` : "—"}
                  </span>
                </p>
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

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
import type {
  RegionMarketDetail,
  RegionMonthBreakdownRow,
  RegionMonthDetail,
} from "@/lib/region/region-market-detail";
import { seoulToday, yearMonthFromSeoulDate } from "@/lib/market/time";

const PERIODS = [
  { id: "3y", label: "최근 3년" },
  { id: "all", label: "전체 기간" },
] as const;
type PeriodId = (typeof PERIODS)[number]["id"];

const BREAKDOWNS = [
  { id: "dong", label: "동" },
  { id: "area", label: "면적" },
] as const;
type BreakdownId = (typeof BREAKDOWNS)[number]["id"];

const BREAKDOWN_PREVIEW = 5;

const CHART_TRADE = "#087F83";
const CHART_VOLUME = "#0F766E";
const DIR_UP = "var(--lab-change-up)";
const DIR_DOWN = "var(--lab-change-down)";
const DIR_OTHER = "#CBD5E1";

type ChartRow = RegionPriceTrendPoint & { label: string; partial: boolean };

function ymDot(ym: string): string {
  return `${ym.slice(0, 4)}.${ym.slice(4, 6)}`;
}

function ymKorean(ym: string): string {
  return `${ym.slice(0, 4)}년 ${ym.slice(4, 6)}월`;
}

function formatManwon(n: number): string {
  return `${Math.round(n).toLocaleString("ko-KR")}만원`;
}

function formatAxisManwon(n: number): string {
  if (n >= 10000) return `${(Math.round(n / 1000) / 10).toFixed(1).replace(/\.0$/, "")}억`;
  return `${(Math.round(n / 100) / 10).toFixed(1).replace(/\.0$/, "")}천`;
}

function signedManwon(n: number): string {
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return `${sign}${Math.abs(Math.round(n)).toLocaleString("ko-KR")}만원`;
}

function changeClass(n: number | null): string {
  if (n == null || n === 0) return "text-[color:var(--lab-muted)]";
  return n > 0 ? "detail-change-up" : "detail-change-down";
}

function pctText(diff: number | null, base: number | null): string {
  if (diff == null || base == null || base <= 0) return "";
  return ` (${((diff / base) * 100).toFixed(1)}%)`;
}

function total(row: { up: number; down: number; other: number }): number {
  return row.up + row.down + row.other;
}

function DirectionBar({
  row,
  scale,
  label,
}: {
  row: { up: number; down: number; other: number };
  scale: number;
  label: string;
}) {
  const sum = total(row);
  const width = scale > 0 ? (sum / scale) * 100 : 0;
  return (
    <div
      className="flex h-3 overflow-hidden rounded-sm bg-slate-100"
      role="img"
      aria-label={`${label} 상승 ${row.up}건, 하락 ${row.down}건, 기타 ${row.other}건`}
    >
      <div className="flex h-full" style={{ width: `${width}%` }}>
        {(["up", "other", "down"] as const).map((k) =>
          row[k] > 0 ? (
            <span
              key={k}
              className="h-full"
              style={{
                width: `${(row[k] / sum) * 100}%`,
                background: k === "up" ? DIR_UP : k === "down" ? DIR_DOWN : DIR_OTHER,
              }}
            />
          ) : null,
        )}
      </div>
    </div>
  );
}

function MonthBreakdown({ detail }: { detail: RegionMonthDetail }) {
  const [mode, setMode] = useState<BreakdownId>("dong");
  const [expanded, setExpanded] = useState(false);
  const d = detail.direction;
  const sum = total(d);
  const rows: RegionMonthBreakdownRow[] = mode === "dong" ? detail.byDong : detail.byArea;
  const visible = expanded ? rows : rows.slice(0, BREAKDOWN_PREVIEW);
  const scale = Math.max(1, ...rows.map(total));
  const share = (n: number) => (sum > 0 ? Math.round((n / sum) * 100) : 0);

  return (
    <div className="flex flex-col gap-3 border-t border-[color:var(--lab-border)] pt-3">
      <div>
        <DirectionBar row={d} scale={sum} label="전체" />
        <ul className="mt-2 grid grid-cols-3 gap-2">
          {(
            [
              ["up", "상승 거래", "detail-change-up"],
              ["down", "하락 거래", "detail-change-down"],
              ["other", "기타 거래", "text-[color:var(--lab-muted)]"],
            ] as const
          ).map(([k, label, cls]) => (
            <li key={k} className="min-w-0">
              <p className="detail-meta flex items-center gap-1">
                <span
                  className="inline-block h-2 w-2 shrink-0 rounded-full"
                  style={{
                    background: k === "up" ? DIR_UP : k === "down" ? DIR_DOWN : DIR_OTHER,
                  }}
                  aria-hidden
                />
                {label}
              </p>
              <p className={`detail-data-value-emphasis ${cls}`}>
                {d[k].toLocaleString("ko-KR")}건
                <span className="detail-meta ml-1">({share(d[k])}%)</span>
              </p>
            </li>
          ))}
        </ul>
        <p className="detail-meta mt-1">
          같은 단지·면적의 직전 거래와 비교합니다. 직전 거래가 없거나 같은 가격이면
          기타로 분류합니다.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <LabTabs
          variant="compact"
          ariaLabel="거래량 구분"
          equalWidth={false}
          items={BREAKDOWNS}
          value={mode}
          onChange={(next) => {
            setMode(next);
            setExpanded(false);
          }}
        />
        <ul className="flex flex-col gap-2">
          {visible.map((row) => (
            <li
              key={row.key}
              className="grid grid-cols-[5.5rem_minmax(0,1fr)_2.75rem] items-center gap-2"
            >
              <span className="detail-label truncate text-[color:var(--lab-body)]">
                {row.label}
              </span>
              <DirectionBar row={row} scale={scale} label={row.label} />
              <span className="detail-data-value text-right">
                {total(row).toLocaleString("ko-KR")}건
              </span>
            </li>
          ))}
        </ul>
        {rows.length > BREAKDOWN_PREVIEW ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            className="lab-button lab-button-secondary self-center"
          >
            {expanded ? "접기" : `더보기 (${rows.length - BREAKDOWN_PREVIEW}개)`}
          </button>
        ) : null}
      </div>
    </div>
  );
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
    enabled: !!lawdCd,
    staleTime: 30 * 60_000,
    retry: 1,
  });
  const detailQuery = useQuery({
    queryKey: ["region-market-detail", lawdCd],
    queryFn: async () => {
      const res = await fetch(`/api/region-market-detail?lawd_cd=${lawdCd}`);
      if (!res.ok) throw new Error("detail");
      return (await res.json()) as RegionMarketDetail;
    },
    enabled: !!lawdCd,
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
  const allIndex = current ? all.findIndex((r) => r.yearMonth === current.yearMonth) : -1;
  const prevRow = allIndex > 0 ? all[allIndex - 1]! : null;
  const yearAgo = current
    ? all.find(
        (r) =>
          r.yearMonth ===
          `${Number(current.yearMonth.slice(0, 4)) - 1}${current.yearMonth.slice(4, 6)}`,
      ) ?? null
    : null;
  const peak =
    allIndex >= 0
      ? all.slice(0, allIndex + 1).reduce<ChartRow | null>(
          (best, r) =>
            !best || r.smoothedPyeongPrice > best.smoothedPyeongPrice ? r : best,
          null,
        )
      : null;
  const value = current?.smoothedPyeongPrice ?? null;
  const momDiff = value != null && prevRow ? value - prevRow.smoothedPyeongPrice : null;
  const yoyDiff = value != null && yearAgo ? value - yearAgo.smoothedPyeongPrice : null;
  const peakDiff = value != null && peak ? value - peak.smoothedPyeongPrice : null;
  const monthDetail = current ? detailQuery.data?.months?.[current.yearMonth] ?? null : null;

  if (query.isError) return null;

  const prices = rows.map((r) => r.smoothedPyeongPrice);
  const span = prices.length ? Math.max(...prices) - Math.min(...prices) : 0;
  const step = span > 5000 ? 2000 : span > 2500 ? 1000 : 500;
  const yMin = prices.length ? Math.floor(Math.min(...prices) / step) * step : 0;
  const yMax = prices.length ? Math.ceil(Math.max(...prices) / step) * step : step;
  const priceTicks = Array.from(
    { length: Math.round((yMax - yMin) / step) + 1 },
    (_, i) => yMin + i * step,
  );
  const yearTicks = rows
    .filter((r) => r.yearMonth.endsWith("01"))
    .map((r) => r.label);
  const selectRow = (index: unknown) => {
    const ym = rows[Number(index)]?.yearMonth;
    if (ym && ym !== selected) setSelected(ym);
  };

  return (
    <div className="flex flex-col gap-3 border-t border-[color:var(--lab-border)] pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center">
          <h3 className="detail-subsection-title">{regionName} 평당가 추이</h3>
          <InfoTip aria-label="평당가 추이 안내">
            <p>
              월별 매매 실거래 평당가(전용면적 기준 중앙값)를 최근 3개월 거래량으로
              가중 평균해 흐름을 보여줍니다. 막대 영역은 월별 거래량입니다. 이번 달
              값은 거래 신고 기간 중이라 바뀔 수 있습니다.
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
        <div className="h-[220px] animate-pulse rounded-lg bg-slate-100" />
      ) : rows.length < 2 ? (
        <p className="detail-body">그래프를 그릴 거래가 부족합니다.</p>
      ) : (
        <>
          <div className="h-[220px] w-full lg:h-[280px]">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart
                data={rows}
                margin={{ top: 8, right: 4, bottom: 0, left: -12 }}
                onClick={(state) => selectRow(state?.activeTooltipIndex)}
                onMouseMove={(state) => selectRow(state?.activeTooltipIndex)}
              >
                <XAxis
                  dataKey="label"
                  ticks={yearTicks}
                  tickFormatter={(v: string) => v.slice(0, 4)}
                  tick={{ fontSize: 12, fill: "#64748b" }}
                  tickLine={false}
                  axisLine={{ stroke: "#e2e8f0" }}
                  interval={0}
                />
                <YAxis
                  yAxisId="price"
                  domain={[yMin, yMax]}
                  ticks={priceTicks}
                  tickFormatter={formatAxisManwon}
                  tick={{ fontSize: 12, fill: "#64748b" }}
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
                  fill={CHART_VOLUME}
                  fillOpacity={0.14}
                  isAnimationActive={false}
                  name="거래량"
                />
                <Line
                  yAxisId="price"
                  dataKey="smoothedPyeongPrice"
                  type="monotone"
                  stroke={CHART_TRADE}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4, fill: CHART_TRADE, stroke: "#fff", strokeWidth: 2 }}
                  isAnimationActive={false}
                  name="평당가"
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <p className="detail-meta -mt-1 flex items-center gap-3">
            <span className="inline-flex items-center gap-1">
              <span className="h-0.5 w-3 rounded" style={{ background: CHART_TRADE }} aria-hidden />
              평당가 (만원/평)
            </span>
            <span className="inline-flex items-center gap-1">
              <span
                className="h-2 w-3 rounded-sm"
                style={{ background: CHART_VOLUME, opacity: 0.3 }}
                aria-hidden
              />
              거래량 (건)
            </span>
          </p>

          {current ? (
            <div
              className="flex flex-col gap-3 rounded-xl border border-[color:var(--lab-border)] p-4"
              aria-live="polite"
            >
              <div className="flex items-baseline justify-between gap-2">
                <p className="detail-subsection-title">
                  {ymKorean(current.yearMonth)}
                  {current.partial ? <span className="detail-meta ml-1">(진행 중)</span> : null}
                </p>
              </div>
              <div>
                <p className="detail-label">평당가</p>
                <p className="detail-summary-value">{formatManwon(current.smoothedPyeongPrice)}</p>
                <p className="detail-meta">
                  이 달 실거래 중앙값 {formatManwon(current.medianPyeongPrice)}
                </p>
              </div>
              <dl className="flex flex-col gap-1.5">
                {(
                  [
                    ["전월 대비", momDiff, prevRow?.smoothedPyeongPrice ?? null],
                    ["전년 대비", yoyDiff, yearAgo?.smoothedPyeongPrice ?? null],
                    ["최고점 대비", peakDiff, peak?.smoothedPyeongPrice ?? null],
                  ] as const
                ).map(([label, diff, base]) => (
                  <div key={label} className="flex items-baseline justify-between gap-2">
                    <dt className="detail-label">{label}</dt>
                    <dd className={`detail-data-value-emphasis ${changeClass(diff)}`}>
                      {diff != null ? `${signedManwon(diff)}${pctText(diff, base)}` : "—"}
                    </dd>
                  </div>
                ))}
              </dl>
              <div className="flex items-baseline justify-between gap-2 border-t border-[color:var(--lab-border)] pt-3">
                <p className="detail-label">총 거래량</p>
                <p className="detail-summary-value">
                  {current.tradeCount.toLocaleString("ko-KR")}건
                </p>
              </div>
              {monthDetail ? (
                <MonthBreakdown key={current.yearMonth} detail={monthDetail} />
              ) : detailQuery.isLoading ? (
                <div className="h-24 animate-pulse rounded-lg bg-slate-100" />
              ) : (
                <p className="detail-meta">이 달의 거래 구성은 최근 5년까지 제공합니다.</p>
              )}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

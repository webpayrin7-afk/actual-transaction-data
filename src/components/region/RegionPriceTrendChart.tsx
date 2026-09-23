"use client";

import { LAB_LIST_PREVIEW, LabMoreButton } from "@/components/ui/LabMoreButton";
import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import {
  Area,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { LabTabs } from "@/components/ui/LabTabs";
import { InfoTip } from "@/components/ui/InfoTip";
import { LabStatTiles } from "@/components/ui/LabStatTiles";
import { LabSubsectionHeader } from "@/components/ui/LabSection";
import {
  LAB_DIRECTION_SEGMENTS,
  LabStackedBar,
  directionSegments,
} from "@/components/ui/LabStackedBar";
import {
  RegionSeoulRankBadges,
  type SeoulRank,
} from "@/components/region/RegionSeoulRankBadges";
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

const BREAKDOWN_PREVIEW = LAB_LIST_PREVIEW;

const PANEL_RULE = "mt-4 border-t border-[color:var(--lab-border)] pt-4";

const CHART_TRADE = "#087F83";
const CHART_VOLUME = "#0F766E";
const DIRECTIONS = LAB_DIRECTION_SEGMENTS;

type ChartRow = RegionPriceTrendPoint & { label: string; partial: boolean };

function ymDot(ym: string): string {
  return `${ym.slice(0, 4)}.${ym.slice(4, 6)}`;
}

function ymKorean(ym: string): string {
  return `${ym.slice(0, 4)}년 ${ym.slice(4, 6)}월`;
}


function formatAxisManwon(n: number): string {
  if (n >= 10000) return `${(Math.round(n / 1000) / 10).toFixed(1).replace(/\.0$/, "")}억`;
  return `${(Math.round(n / 100) / 10).toFixed(1).replace(/\.0$/, "")}천`;
}




function total(row: { up: number; down: number; other: number }): number {
  return row.up + row.down + row.other;
}

function MonthStepper({
  label,
  canPrev,
  canNext,
  onPrev,
  onNext,
}: {
  label: string;
  canPrev: boolean;
  canNext: boolean;
  onPrev: () => void;
  onNext: () => void;
}) {
  const btn =
    "inline-flex h-11 w-11 shrink-0 items-center justify-center text-[color:var(--lab-muted)] transition hover:bg-slate-50 disabled:opacity-30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--lab-brand-primary)]";
  return (
    <div className="flex w-full items-center rounded-xl border border-[color:var(--lab-border)] bg-white">
      <button type="button" className={`${btn} rounded-l-xl`} onClick={onPrev} disabled={!canPrev} aria-label="이전 달">
        <ChevronLeft className="h-5 w-5" aria-hidden />
      </button>
      <p className="detail-subsection-title flex-1 text-center tabular-nums" aria-live="polite">
        {label}
      </p>
      <button type="button" className={`${btn} rounded-r-xl`} onClick={onNext} disabled={!canNext} aria-label="다음 달">
        <ChevronRight className="h-5 w-5" aria-hidden />
      </button>
    </div>
  );
}


function MonthComposition({
  detail,
  monthLabel,
  tradeCount,
}: {
  detail: RegionMonthDetail;
  monthLabel: string;
  tradeCount: number;
}) {
  const [mode, setMode] = useState<BreakdownId>("dong");
  const [expanded, setExpanded] = useState(false);
  const d = detail.direction;
  const sum = total(d);
  const rows: RegionMonthBreakdownRow[] = mode === "dong" ? detail.byDong : detail.byArea;
  const visible = expanded ? rows : rows.slice(0, BREAKDOWN_PREVIEW);
  const scale = Math.max(1, ...rows.map(total));
  const share = (n: number) => (sum > 0 ? Math.round((n / sum) * 100) : 0);

  return (
    <>
      <div className={PANEL_RULE}>
        <LabSubsectionHeader
          as="h4"
          title="이 달 거래 구성"
          tip={
            <p>
              오름·내림은 같은 단지·면적의 직전 거래와 비교한 결과입니다. 직전
              거래가 없거나 같은 가격이면 보합·기타로 분류합니다.
            </p>
          }
        />
        <p className="detail-meta tabular-nums">
          {monthLabel} · 매매 {tradeCount.toLocaleString("ko-KR")}건
        </p>
        <div className="mt-3">
          <LabStackedBar segments={directionSegments(d)} className="h-2.5" />
          <dl
            className="mt-2 grid grid-cols-3 gap-2"
            aria-label={`${monthLabel} 오름 ${d.up}건, 보합·기타 ${d.other}건, 내림 ${d.down}건`}
          >
            {DIRECTIONS.map((dir) => (
              <div key={dir.key} className="min-w-0">
                <dt className="detail-meta flex items-center gap-1.5 whitespace-nowrap">
                  <span className="inline-block h-2 w-2 shrink-0 rounded-sm" style={{ background: dir.color }} aria-hidden />
                  {dir.label}
                </dt>
                <dd className="whitespace-nowrap tabular-nums">
                  <span className={`detail-data-value-emphasis ${dir.cls}`}>{share(d[dir.key])}%</span>
                  <span className="detail-meta ml-1">{d[dir.key].toLocaleString("ko-KR")}건</span>
                </dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="mt-4 flex items-center justify-between gap-2 border-t border-[color:var(--lab-border)] pt-3">
          <h5 className="detail-data-value-emphasis">어디서 거래됐나</h5>
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
        </div>
        <ul className="mt-3 flex flex-col gap-2.5">
          {visible.map((row) => {
            const n = total(row);
            return (
              <li key={row.key} className="flex flex-col gap-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="detail-data-value truncate">{row.label}</span>
                  <span className="detail-data-value shrink-0">
                    {n.toLocaleString("ko-KR")}건
                    <span className="detail-meta ml-1.5">{share(n)}%</span>
                  </span>
                </div>
                <LabStackedBar segments={directionSegments(row)} widthPct={(n / scale) * 100} />
                <p className="detail-meta flex flex-wrap gap-x-2 tabular-nums">
                  {DIRECTIONS.map((dir) => (
                    <span key={dir.key} className="whitespace-nowrap">
                      {dir.label}{" "}
                      <span className={dir.cls ? `font-semibold ${dir.cls}` : "font-semibold"}>
                        {row[dir.key].toLocaleString("ko-KR")}
                      </span>
                    </span>
                  ))}
                </p>
              </li>
            );
          })}
        </ul>
        {rows.length > BREAKDOWN_PREVIEW ? (
          <div className="mt-3">
            <LabMoreButton
              expanded={expanded}
              onToggle={() => setExpanded((v) => !v)}
              label={`${rows.length - BREAKDOWN_PREVIEW}${mode === "dong" ? "개 동" : "개"} 더보기`}
            />
          </div>
        ) : null}
      </div>
    </>
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
  const rankQuery = useQuery({
    queryKey: ["region-seoul-rank", lawdCd],
    queryFn: async (): Promise<SeoulRank | null> => {
      const res = await fetch(`/api/region-seoul-rank?lawd_cd=${lawdCd}`);
      if (!res.ok) return null;
      const body = (await res.json()) as SeoulRank | { status: string };
      return body.status === "ok" ? (body as SeoulRank) : null;
    },
    enabled: !!lawdCd,
    staleTime: 60 * 60_000,
    retry: 0,
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

  const foundIndex = selected ? rows.findIndex((r) => r.yearMonth === selected) : -1;
  const selectedIndex = foundIndex >= 0 ? foundIndex : rows.length - 1;
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
            r.pyeongPrice != null &&
            (!best || r.pyeongPrice > (best.pyeongPrice ?? 0))
              ? r
              : best,
          null,
        )
      : null;
  const value = current?.pyeongPrice ?? null;
  const diffTo = (base: ChartRow | null) =>
    value != null && base?.pyeongPrice != null ? value - base.pyeongPrice : null;
  const threeYearsAgo = allIndex >= 36 ? all[allIndex - 36]! : null;
  const changeTiles = [
    { key: "1m", label: "1개월 전", base: prevRow },
    { key: "1y", label: "1년 전", base: yearAgo },
    { key: "3y", label: "3년 전", base: threeYearsAgo },
    { key: "peak", label: "최고점", base: peak },
  ].map((t) => {
    const diff = diffTo(t.base);
    const baseValue = t.base?.pyeongPrice ?? null;
    const pct = diff != null && baseValue ? (diff / baseValue) * 100 : null;
    return { ...t, diff, pct };
  });
  const monthDetail = current ? detailQuery.data?.months?.[current.yearMonth] ?? null : null;

  if (query.isError) return null;

  const prices = rows
    .map((r) => r.pyeongPrice)
    .filter((v): v is number => v != null);
  const span = prices.length ? Math.max(...prices) - Math.min(...prices) : 0;
  const step = span > 5000 ? 2000 : span > 1500 ? 1000 : 500;
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
  const stepMonth = (delta: number) => {
    const next = rows[selectedIndex + delta];
    if (next) setSelected(next.yearMonth);
  };

  const pctText2 = (pct: number | null) =>
    pct == null ? "—" : `${pct > 0 ? "▲" : pct < 0 ? "▼" : ""} ${Math.abs(pct).toFixed(2)}%`.trim();

  return (
    <div className="flex flex-col gap-3">
      {current ? (
        <MonthStepper
          label={`${ymKorean(current.yearMonth)}${current.partial ? " (진행 중)" : ""}`}
          canPrev={selectedIndex > 0}
          canNext={selectedIndex < rows.length - 1}
          onPrev={() => stepMonth(-1)}
          onNext={() => stepMonth(1)}
        />
      ) : null}
      <div className="pt-1" aria-live="polite">
        <p className="detail-label">시세 평당가</p>
        {query.isLoading ? (
          <div className="mt-2 h-8 w-40 animate-pulse rounded bg-slate-100" />
        ) : (
          <p className="detail-hero-value mt-0.5 whitespace-nowrap">
            {value != null ? `${Math.round(value).toLocaleString("ko-KR")}만원/평` : "—"}
          </p>
        )}
        {current ? (
          <p className="detail-meta mt-0.5 tabular-nums">
            이 달 매매 {current.tradeCount.toLocaleString("ko-KR")}건 · 단지{" "}
            {current.complexCount.toLocaleString("ko-KR")}곳 기준
          </p>
        ) : null}
        {current && rankQuery.data && rankQuery.data.yearMonth === current.yearMonth ? (
          <RegionSeoulRankBadges rank={rankQuery.data} />
        ) : null}
      </div>

      <LabStatTiles
        columns={4}
        layout="inline"
        items={changeTiles.map((t) => ({
          key: t.key,
          label: t.label,
          value: query.isLoading ? "…" : pctText2(t.pct),
          tone: t.pct == null || t.pct === 0 ? "neutral" : t.pct > 0 ? "up" : "down",
          srValue: t.pct == null || t.pct === 0 ? undefined : t.pct > 0 ? " 상승" : " 하락",
        }))}
      />

      <div className={`${PANEL_RULE} flex flex-wrap items-center justify-between gap-2`}>
        <div className="flex min-w-0 items-center">
          <h3 className="detail-subsection-title">{regionName} 시세 평당가 추이</h3>
          <InfoTip aria-label="평당가 추이 안내">
            <p>
              월별 지역 시세 평당가(공급면적 기준)와 계약월 매매 거래량입니다. 이번
              달 거래는 신고 기간 중이라 값이 바뀔 수 있습니다.
            </p>
            <p className="mt-1.5">
              그래프를 누르거나 맨 위 ◀ ▶ 버튼으로 달을 바꾸면 평당가, 변화율, 그
              달의 거래 구성이 함께 바뀝니다.
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
                  cursor={{ stroke: "#cbd5e1", strokeDasharray: "3 3" }}
                  content={() => null}
                />
                <Area
                  yAxisId="volume"
                  dataKey="tradeCount"
                  type="monotone"
                  stroke="none"
                  fill={CHART_VOLUME}
                  fillOpacity={0.12}
                  activeDot={{ r: 3.5, fill: CHART_VOLUME, stroke: "#fff", strokeWidth: 1.5 }}
                  isAnimationActive={false}
                  name="거래량"
                />
                {current ? (
                  <ReferenceLine
                    yAxisId="price"
                    x={current.label}
                    stroke={CHART_TRADE}
                    strokeOpacity={0.55}
                    strokeWidth={1.5}
                  />
                ) : null}
                <Line
                  yAxisId="price"
                  dataKey="pyeongPrice"
                  type="monotone"
                  stroke={CHART_TRADE}
                  strokeWidth={2}
                  dot={(props: { cx?: number; cy?: number; index?: number }) =>
                    props.index === selectedIndex && props.cx != null && props.cy != null ? (
                      <circle
                        key="sel"
                        cx={props.cx}
                        cy={props.cy}
                        r={4.5}
                        fill={CHART_TRADE}
                        stroke="#fff"
                        strokeWidth={2}
                      />
                    ) : (
                      <g key={`d-${props.index}`} />
                    )
                  }
                  activeDot={{ r: 4, fill: CHART_TRADE, stroke: "#fff", strokeWidth: 2 }}
                  isAnimationActive={false}
                  connectNulls
                  name="평당가"
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <p className="detail-meta -mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="inline-flex items-center gap-1">
              <span className="h-0.5 w-3 rounded" style={{ background: CHART_TRADE }} aria-hidden />
              평당가 (만원/공급평)
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-3 rounded-sm" style={{ background: CHART_VOLUME, opacity: 0.3 }} aria-hidden />
              거래량 (건)
            </span>
          </p>

          {current ? (
            monthDetail ? (
              <MonthComposition
                key={current.yearMonth}
                detail={monthDetail}
                monthLabel={ymKorean(current.yearMonth)}
                tradeCount={current.tradeCount}
              />
            ) : detailQuery.isLoading ? (
              <div className="h-24 animate-pulse rounded-lg bg-slate-100" />
            ) : (
              <p className="detail-meta">
                {ymKorean(current.yearMonth)} · 매매{" "}
                {current.tradeCount.toLocaleString("ko-KR")}건 · 거래 구성은 최근
                5년까지 제공합니다.
              </p>
            )
          ) : null}
        </>
      )}
    </div>
  );
}

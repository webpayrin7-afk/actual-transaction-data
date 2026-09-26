"use client";

import { useMemo } from "react";
import {
  Bar,
  BarChart,
  Cell,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { LabSection, LabSubsectionHeader, LAB_SUBSECTION_RULE } from "@/components/ui/LabSection";
import { LabStatTiles } from "@/components/ui/LabStatTiles";
import type { TrendPoint } from "@/lib/market/trends";
import type { TrendPeriod } from "@/lib/market/trends-regions";
import {
  CHART_AXIS_LINE,
  CHART_BOX,
  CHART_DOWN,
  CHART_JEONSE,
  CHART_TICK,
  CHART_TRADE,
  CHART_UP,
  ChartLegend,
  ChartLoading,
  ChartTooltipBox,
  SectionError,
  niceTicks,
  signedPct,
  sliceByPeriod,
  srTone,
  toneOf,
  yearTicks,
  ymDot,
  ymShift,
} from "@/components/stats/trends-chart-kit";

type Row = { ym: string; trade: number | null; jeonse: number | null };

type YearRow = { year: string; label: string; pct: number; partial: boolean };

function changeFrom(series: TrendPoint[], months: number): number | null {
  const last = series.at(-1);
  if (!last) return null;
  const base = series.find((p) => p.ym === ymShift(last.ym, -months));
  if (!base || base.value <= 0) return null;
  return (last.value / base.value - 1) * 100;
}

/** 해마다 12월 지수 ÷ 전년 12월 지수. 올해는 최신 달까지. */
function yearlyChanges(series: TrendPoint[]): YearRow[] {
  const byYm = new Map(series.map((p) => [p.ym, p.value]));
  const last = series.at(-1);
  if (!last) return [];
  const firstYear = Number(series[0]!.ym.slice(0, 4));
  const lastYear = Number(last.ym.slice(0, 4));
  const out: YearRow[] = [];
  for (let y = firstYear + 1; y <= lastYear; y++) {
    const base = byYm.get(`${y - 1}12`);
    const partial = y === lastYear && !last.ym.endsWith("12");
    const end = partial ? last.value : byYm.get(`${y}12`);
    if (base == null || end == null || base <= 0) continue;
    out.push({
      year: String(y),
      label: partial ? `${y}년 1~${Number(last.ym.slice(4, 6))}월` : `${y}년`,
      pct: Math.round((end / base - 1) * 1000) / 10,
      partial,
    });
  }
  return out;
}

export function TrendsPriceIndexSection({
  regionLabel,
  tradeIndex,
  jeonseIndex,
  period,
  loading,
  error,
  onRetry,
  title = "가격 흐름",
  footer,
}: {
  regionLabel: string;
  tradeIndex: TrendPoint[] | null;
  jeonseIndex: TrendPoint[] | null;
  period: TrendPeriod;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  /** 영역 제목 (시장 홈에서는 "시장 흐름") */
  title?: string;
  /** 영역 맨 아래에 붙는 내용 (예: 자세히 보기 버튼) — 영역 카드 안에 들어간다 */
  footer?: React.ReactNode;
}) {
  const allRows = useMemo<Row[]>(() => {
    const jeonse = new Map((jeonseIndex ?? []).map((p) => [p.ym, p.value]));
    return (tradeIndex ?? []).map((p) => ({ ym: p.ym, trade: p.value, jeonse: jeonse.get(p.ym) ?? null }));
  }, [tradeIndex, jeonseIndex]);
  const rows = useMemo(() => sliceByPeriod(allRows, period), [allRows, period]);
  const years = useMemo(() => {
    const all = yearlyChanges(tradeIndex ?? []);
    const from = rows[0]?.ym.slice(0, 4);
    return from ? all.filter((y) => y.year > from || (period === "all" && y.year >= from)) : all;
  }, [tradeIndex, rows, period]);

  const series = tradeIndex ?? [];
  const latest = series.at(-1) ?? null;
  const peak = series.reduce<TrendPoint | null>((best, p) => (!best || p.value >= best.value ? p : best), null);
  const fromPeak = latest && peak ? (latest.value / peak.value - 1) * 100 : null;
  const tiles = [
    { key: "1y", label: "1년", pct: changeFrom(series, 12) },
    { key: "3y", label: "3년", pct: changeFrom(series, 36) },
    { key: "5y", label: "5년", pct: changeFrom(series, 60) },
    { key: "peak", label: "고점 대비", pct: fromPeak },
  ];

  const values = rows.flatMap((r) => [r.trade, r.jeonse]).filter((v): v is number => v != null);
  const ticks = values.length ? niceTicks(Math.min(...values), Math.max(...values)) : [];
  const xTicks = yearTicks(rows);
  const best = years.reduce<YearRow | null>((b, y) => (!b || y.pct > b.pct ? y : b), null);
  const worst = years.reduce<YearRow | null>((b, y) => (!b || y.pct < b.pct ? y : b), null);

  return (
    <LabSection
      id="price-index"
      title={title}
      label={`${regionLabel} 아파트 가격지수 흐름`}
      meta={latest ? `${ymDot(latest.ym)} 기준 · 월간` : undefined}
      tip={
        <>
          <p>
            한국부동산원이 표본 아파트 시세를 매달 조사해 만든 매매·전세가격지수입니다. 기준 시점을 100으로 둔
            상대값이므로 지역끼리 지수 크기가 아니라 변동률을 비교해 주세요.
          </p>
          <p className="mt-1.5">출처: 한국부동산원 전국주택가격동향조사 (월간 아파트 매매·전세가격지수)</p>
        </>
      }
    >
      {error ? (
        <SectionError onRetry={onRetry} />
      ) : (
        <>
          <div>
            <p className="detail-label">매매가격지수 변동률</p>
            <LabStatTiles
              className="mt-2"
              columns={4}
              layout="inline"
              loading={loading}
              items={tiles.map((t) => ({
                key: t.key,
                label: t.label,
                value: t.key === "peak" && t.pct != null && Number(t.pct.toFixed(1)) === 0 ? "최고점" : signedPct(t.pct),
                tone: toneOf(t.pct),
                srValue: srTone(t.pct),
              }))}
            />
            {!loading && latest && peak ? (
              <p className="detail-meta mt-2 tabular-nums">
                전고점 {ymDot(peak.ym)} · 현재 {ymDot(latest.ym)} · 같은 달 기준 비교
              </p>
            ) : null}
          </div>

          <div className={LAB_SUBSECTION_RULE}>
            <LabSubsectionHeader title="매매·전세가격지수 추이" meta="지수" />
            <div className="mt-3">
              {loading ? (
                <ChartLoading label="지수 불러오는 중" />
              ) : rows.length < 2 ? (
                <p className="lab-state">표시할 지수가 없습니다.</p>
              ) : (
                <>
                  <div className={CHART_BOX}>
                    <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart data={rows} margin={{ top: 8, right: 4, bottom: 0, left: -12 }}>
                        <XAxis
                          dataKey="ym"
                          ticks={xTicks}
                          tickFormatter={(v: string) => v.slice(0, 4)}
                          tick={CHART_TICK}
                          tickLine={false}
                          axisLine={CHART_AXIS_LINE}
                          interval={0}
                        />
                        <YAxis
                          domain={[ticks[0] ?? "auto", ticks.at(-1) ?? "auto"]}
                          ticks={ticks}
                          tick={CHART_TICK}
                          tickLine={false}
                          axisLine={false}
                          width={44}
                        />
                        <Tooltip
                          cursor={{ stroke: "#cbd5e1", strokeDasharray: "3 3" }}
                          content={({ active, label }) => {
                            const row = active ? rows.find((r) => r.ym === label) : null;
                            if (!row) return null;
                            return (
                              <ChartTooltipBox
                                title={ymDot(row.ym)}
                                rows={[
                                  row.trade != null
                                    ? { key: "t", name: "매매지수", color: CHART_TRADE, value: row.trade.toFixed(1) }
                                    : null,
                                  row.jeonse != null
                                    ? { key: "j", name: "전세지수", color: CHART_JEONSE, value: row.jeonse.toFixed(1) }
                                    : null,
                                ].filter((r) => r != null)}
                              />
                            );
                          }}
                        />
                        <Line
                          dataKey="trade"
                          type="monotone"
                          stroke={CHART_TRADE}
                          strokeWidth={2}
                          dot={false}
                          activeDot={{ r: 4, fill: CHART_TRADE, stroke: "#fff", strokeWidth: 2 }}
                          isAnimationActive={false}
                          connectNulls
                          name="매매지수"
                        />
                        <Line
                          dataKey="jeonse"
                          type="monotone"
                          stroke={CHART_JEONSE}
                          strokeWidth={2}
                          strokeDasharray="5 3"
                          dot={false}
                          activeDot={{ r: 4, fill: CHART_JEONSE, stroke: "#fff", strokeWidth: 2 }}
                          isAnimationActive={false}
                          connectNulls
                          name="전세지수"
                        />
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="mt-1">
                    <ChartLegend
                      items={[
                        { key: "t", label: "매매가격지수", color: CHART_TRADE, shape: "line" },
                        { key: "j", label: "전세가격지수", color: CHART_JEONSE, shape: "dash" },
                      ]}
                    />
                  </div>
                </>
              )}
            </div>
          </div>

          <div className={LAB_SUBSECTION_RULE}>
            <LabSubsectionHeader
              title="연도별 매매가격 변동률"
              meta="전년 12월 대비"
              tip={<p>해마다 12월 매매가격지수를 전년 12월과 비교했습니다. 올해는 최신 달까지의 변동률입니다.</p>}
            />
            <div className="mt-3">
              {loading ? (
                <ChartLoading label="변동률 불러오는 중" />
              ) : years.length === 0 ? (
                <p className="lab-state">표시할 연도가 없습니다.</p>
              ) : (
                <>
                  <div className="h-[200px] w-full lg:h-[240px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={years} margin={{ top: 8, right: 4, bottom: 0, left: -12 }}>
                        <XAxis
                          dataKey="year"
                          tick={CHART_TICK}
                          tickLine={false}
                          axisLine={CHART_AXIS_LINE}
                          interval="preserveStartEnd"
                          minTickGap={16}
                        />
                        <YAxis
                          tick={CHART_TICK}
                          tickLine={false}
                          axisLine={false}
                          width={44}
                          tickFormatter={(v: number) => `${v}%`}
                        />
                        <ReferenceLine y={0} stroke="#cbd5e1" />
                        <Tooltip
                          cursor={{ fill: "rgba(148,163,184,0.12)" }}
                          content={({ active, label }) => {
                            const y = active ? years.find((r) => r.year === label) : null;
                            if (!y) return null;
                            return (
                              <ChartTooltipBox
                                title={y.label}
                                rows={[
                                  {
                                    key: "p",
                                    name: "매매지수",
                                    color: y.pct >= 0 ? CHART_UP : CHART_DOWN,
                                    value: signedPct(y.pct),
                                  },
                                ]}
                              />
                            );
                          }}
                        />
                        <Bar dataKey="pct" isAnimationActive={false} radius={[2, 2, 0, 0]} maxBarSize={28}>
                          {years.map((y) => (
                            <Cell
                              key={y.year}
                              fill={y.pct >= 0 ? CHART_UP : CHART_DOWN}
                              fillOpacity={y.partial ? 0.45 : 0.85}
                            />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <p className="detail-meta mt-1 tabular-nums">
                    {best && best.pct > 0 ? (
                      <>
                        가장 많이 오른 해 {best.label}{" "}
                        <span className="font-semibold detail-change-up">{signedPct(best.pct)}</span>
                      </>
                    ) : null}
                    {best && best.pct > 0 && worst && worst.pct < 0 ? " · " : null}
                    {worst && worst.pct < 0 ? (
                      <>
                        가장 많이 내린 해 {worst.label}{" "}
                        <span className="font-semibold detail-change-down">{signedPct(worst.pct)}</span>
                      </>
                    ) : null}
                    {years.at(-1)?.partial ? " · 옅은 막대는 올해 진행 중" : null}
                  </p>
                </>
              )}
            </div>
          </div>

        </>
      )}
      {footer ? <div className={LAB_SUBSECTION_RULE}>{footer}</div> : null}
    </LabSection>
  );
}

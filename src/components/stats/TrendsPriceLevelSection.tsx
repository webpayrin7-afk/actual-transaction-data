"use client";

import { useMemo, useState } from "react";
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { LabSection } from "@/components/ui/LabSection";
import { LabStatTiles } from "@/components/ui/LabStatTiles";
import { LabTabs } from "@/components/ui/LabTabs";
import type { TrendPoint } from "@/lib/market/trends";
import type { TrendPeriod } from "@/lib/market/trends-regions";
import {
  CHART_AXIS_LINE,
  CHART_BOX,
  CHART_JEONSE,
  CHART_TICK,
  CHART_TRADE,
  ChartSkeleton,
  ChartTooltipBox,
  SectionError,
  formatManwonShort,
  niceTicks,
  sliceByPeriod,
  yearTicks,
  ymDot,
  ymShift,
} from "@/components/stats/trends-chart-kit";

const MODES = [
  { id: "median", label: "중위 매매가격" },
  { id: "ratio", label: "전세가율" },
] as const;
type Mode = (typeof MODES)[number]["id"];

const BACK = [
  { key: "now", label: "현재", months: 0 },
  { key: "1y", label: "1년 전", months: 12 },
  { key: "5y", label: "5년 전", months: 60 },
  { key: "10y", label: "10년 전", months: 120 },
] as const;

export function TrendsPriceLevelSection({
  regionLabel,
  medianTradePrice,
  jeonseRatio,
  period,
  loading,
  error,
  onRetry,
}: {
  regionLabel: string;
  medianTradePrice: TrendPoint[] | null;
  jeonseRatio: TrendPoint[] | null;
  period: TrendPeriod;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
}) {
  const [mode, setMode] = useState<Mode>("median");
  const series = useMemo(
    () => (mode === "median" ? medianTradePrice : jeonseRatio) ?? [],
    [mode, medianTradePrice, jeonseRatio],
  );
  const rows = useMemo(() => sliceByPeriod(series, period), [series, period]);
  const format = (v: number) => (mode === "median" ? formatManwonShort(v) : `${v.toFixed(1)}%`);
  const color = mode === "median" ? CHART_TRADE : CHART_JEONSE;
  const latest = series.at(-1) ?? null;
  const byYm = new Map(series.map((p) => [p.ym, p.value]));

  const values = rows.map((r) => r.value);
  const ticks = values.length ? niceTicks(Math.min(...values), Math.max(...values)) : [];
  const xTicks = yearTicks(rows);

  return (
    <LabSection
      id="price-level"
      title="가격 수준"
      label={`${regionLabel} 아파트 중위 매매가격과 전세가율`}
      meta={latest ? `${ymDot(latest.ym)} 기준 · 월간` : undefined}
      tip={
        <>
          <p>중위 매매가격: 한국부동산원 조사 표본 아파트 가격을 줄 세웠을 때 가운데 값입니다. 실거래가의 중위값과는 다릅니다.</p>
          <p className="mt-1.5">전세가율: 평균 매매가격 대비 평균 전세가격 비율입니다.</p>
        </>
      }
    >
      {error ? (
        <SectionError onRetry={onRetry} />
      ) : (
        <>
          <LabTabs
            variant="secondary"
            items={MODES}
            value={mode}
            onChange={setMode}
            ariaLabel="가격 수준 지표"
          />
          <LabStatTiles
            columns={4}
            loading={loading}
            items={BACK.map((b) => {
              const ym = latest ? ymShift(latest.ym, -b.months) : null;
              const v = ym ? byYm.get(ym) : undefined;
              return {
                key: b.key,
                label: b.label,
                value: v != null ? format(v) : "—",
                sub: ym ? ymDot(ym) : undefined,
              };
            })}
          />
          {loading ? (
            <ChartSkeleton />
          ) : rows.length < 2 ? (
            <p className="lab-state">표시할 자료가 없습니다.</p>
          ) : (
            <div className={CHART_BOX}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={rows} margin={{ top: 8, right: 4, bottom: 0, left: -8 }}>
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
                    width={48}
                    tickFormatter={(v: number) => (mode === "median" ? formatManwonShort(v) : `${v}%`)}
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
                            {
                              key: "v",
                              name: mode === "median" ? "중위 매매가격" : "전세가율",
                              color,
                              value: format(row.value),
                            },
                          ]}
                        />
                      );
                    }}
                  />
                  <Line
                    dataKey="value"
                    type="monotone"
                    stroke={color}
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4, fill: color, stroke: "#fff", strokeWidth: 2 }}
                    isAnimationActive={false}
                    name={mode === "median" ? "중위 매매가격" : "전세가율"}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
          {rows.length && rows[0]!.ym < "202107" && rows.at(-1)!.ym >= "202107" ? (
            <p className="detail-meta">
              2021년 7월 한국부동산원 조사 표본이 확대돼 그 전후 값은 바로 이어 비교하기 어렵습니다.
            </p>
          ) : null}
          <p className="detail-meta">
            출처: 한국부동산원 전국주택가격동향조사 ({mode === "median" ? "월간 아파트 중위매매가격" : "월간 아파트 평균 매매가격 대비 전세가격"})
            {series[0] ? ` · ${ymDot(series[0].ym)}부터` : ""}
          </p>
        </>
      )}
    </LabSection>
  );
}

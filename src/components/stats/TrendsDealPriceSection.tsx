"use client";

import { useMemo, useState } from "react";
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { LabSection } from "@/components/ui/LabSection";
import { LabStatTiles } from "@/components/ui/LabStatTiles";
import { LabTabs } from "@/components/ui/LabTabs";
import {
  AREA_BANDS,
  AREA_BAND_LABELS,
  type AreaBand,
  type DealKind,
  type DealStatsPayload,
} from "@/lib/market/deal-stats";
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

const KINDS = [
  { id: "trade", label: "매매" },
  { id: "jeonse", label: "전세" },
] as const;
const METRICS = [
  { id: "median", label: "중위가" },
  { id: "ppp", label: "평당가" },
] as const;
const AREAS = AREA_BANDS.map((id) => ({ id, label: AREA_BAND_LABELS[id] }));

const BACK = [
  { key: "now", label: "현재", months: 0 },
  { key: "1y", label: "1년 전", months: 12 },
  { key: "5y", label: "5년 전", months: 60 },
  { key: "10y", label: "10년 전", months: 120 },
] as const;

type Metric = (typeof METRICS)[number]["id"];

export function TrendsDealPriceSection({
  regionLabel,
  data,
  period,
  loading,
  error,
  onRetry,
}: {
  regionLabel: string;
  data: DealStatsPayload | null;
  period: TrendPeriod;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
}) {
  const [kind, setKind] = useState<DealKind>("trade");
  const [metric, setMetric] = useState<Metric>("median");
  const [area, setArea] = useState<AreaBand>("all");

  const series = useMemo(() => {
    const points = (data?.points ?? []).filter((p) => p.kind === kind && p.area === area && p.count > 0);
    return points
      .map((p) => ({ ym: p.ym, value: metric === "median" ? p.median : p.ppp }))
      .filter((p): p is { ym: string; value: number } => p.value != null && p.value > 0);
  }, [data, kind, area, metric]);

  const rows = useMemo(() => sliceByPeriod(series, period), [series, period]);
  const latest = series.at(-1) ?? null;
  const byYm = new Map(series.map((p) => [p.ym, p.value]));
  const values = rows.map((r) => r.value);
  const ticks = values.length ? niceTicks(Math.min(...values), Math.max(...values)) : [];
  const color = kind === "trade" ? CHART_TRADE : CHART_JEONSE;
  const metricLabel = metric === "median" ? "중위가" : "평당가";
  const kindLabel = kind === "trade" ? "매매" : "전세";
  const format = (v: number) => formatManwonShort(v);

  const method =
    data?.medianMethod === "pooled"
      ? "여러 시군구를 합친 지역은 소속 실거래를 한곳에 모아 줄 세운 중위값입니다. 구별 중위가의 건수 가중 평균이 아닙니다."
      : "이 시군구 실거래를 줄 세운 가운데 값입니다.";

  return (
    <LabSection
      id="deal-price"
      title="실거래 가격"
      label={`${regionLabel} 아파트 실거래 중위가와 평당가`}
      meta={latest ? `${ymDot(latest.ym)} 기준 · 월간` : undefined}
      tip={
        <>
          <p>
            국토교통부 아파트 실거래입니다. 중위가는 그달 거래금액을 줄 세운 가운데 값이고, 평당가는 전용면적 1평(3.3058㎡)당
            가격의 가운데 값입니다. 월세가 있는 임대는 빼며, 전세는 보증금만 있는 계약입니다.
          </p>
          <p className="mt-1.5">{method}</p>
          <p className="mt-1.5">계약 후 30일 신고 기한이 지나지 않은 달은 빼 두었습니다.</p>
          <p className="mt-1.5">
            출처: 국토교통부 실거래가 ({kindLabel} · {AREA_BAND_LABELS[area]} · {metricLabel})
            {data?.medianMethod === "pooled" ? " · 소속 실거래를 모아 계산" : ""}
            {series[0] ? ` · ${ymDot(series[0].ym)}부터` : ""}
          </p>
        </>
      }
    >
      {error ? (
        <SectionError onRetry={onRetry} />
      ) : data?.note && !data.points.length ? (
        <p className="lab-state">{data.note}</p>
      ) : (
        <>
          <div className="flex flex-col gap-2">
            <LabTabs variant="secondary" items={KINDS} value={kind} onChange={setKind} ariaLabel="거래 종류" />
            <LabTabs variant="compact" items={METRICS} value={metric} onChange={setMetric} ariaLabel="가격 지표" />
            <LabTabs
              variant="compact"
              equalWidth={false}
              items={AREAS}
              value={area}
              onChange={setArea}
              ariaLabel="전용면적"
            />
          </div>
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
            <p className="lab-state">표시할 실거래가 없습니다.</p>
          ) : (
            <div className={CHART_BOX}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={rows} margin={{ top: 8, right: 4, bottom: 0, left: -8 }}>
                  <XAxis
                    dataKey="ym"
                    ticks={yearTicks(rows)}
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
                    tickFormatter={(v: number) => formatManwonShort(v)}
                  />
                  <Tooltip
                    cursor={{ stroke: "#cbd5e1", strokeDasharray: "3 3" }}
                    content={({ active, label }) => {
                      const row = active ? rows.find((r) => r.ym === label) : null;
                      if (!row) return null;
                      return (
                        <ChartTooltipBox
                          title={ymDot(row.ym)}
                          rows={[{ key: "v", name: `${kindLabel} ${metricLabel}`, color, value: format(row.value) }]}
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
                    name={`${kindLabel} ${metricLabel}`}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </>
      )}
    </LabSection>
  );
}

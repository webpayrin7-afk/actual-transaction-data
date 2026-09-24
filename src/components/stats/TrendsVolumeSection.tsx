"use client";

import { useMemo, useState } from "react";
import {
  Bar,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { LabSection, LabSubsectionHeader, LAB_SUBSECTION_RULE } from "@/components/ui/LabSection";
import { LabStatTiles } from "@/components/ui/LabStatTiles";
import { LAB_LIST, LabListRow } from "@/components/ui/LabListRow";
import { LAB_LIST_PREVIEW, LabMoreButton } from "@/components/ui/LabMoreButton";
import type { TrendSeries } from "@/lib/market/trends";
import type { TrendPeriod } from "@/lib/market/trends-regions";
import {
  CHART_AXIS_LINE,
  CHART_BOX,
  CHART_TICK,
  CHART_TRADE,
  CHART_VOLUME,
  ChartLegend,
  ChartSkeleton,
  ChartTooltipBox,
  SectionError,
  niceTicks,
  signedPct,
  sliceByPeriod,
  toneOf,
  yearTicks,
  ymDot,
  ymKorean,
  ymShift,
} from "@/components/stats/trends-chart-kit";

type Row = { ym: string; count: number; avg12: number | null };

type YearRow = {
  year: string;
  label: string;
  count: number;
  prev: number | null;
  pct: number | null;
  partial: boolean;
};

function withMovingAverage(points: Array<{ ym: string; count: number }>): Row[] {
  let sum = 0;
  return points.map((p, i) => {
    sum += p.count;
    if (i >= 12) sum -= points[i - 12]!.count;
    return { ...p, avg12: i >= 11 ? Math.round(sum / 12) : null };
  });
}

/** 연도별 합계. 올해(미완료)는 같은 달까지의 전년 합계와 비교한다. */
function yearlyTotals(points: Array<{ ym: string; count: number }>): YearRow[] {
  if (!points.length) return [];
  const first = points[0]!.ym;
  const last = points.at(-1)!.ym;
  const lastMonth = Number(last.slice(4, 6));
  const byYear = new Map<string, Array<{ ym: string; count: number }>>();
  for (const p of points) {
    const y = p.ym.slice(0, 4);
    const list = byYear.get(y) ?? [];
    list.push(p);
    byYear.set(y, list);
  }
  const out: YearRow[] = [];
  for (const [year, list] of byYear) {
    // 수집 시작 연도가 1월부터가 아니면 연간 합계가 아니므로 제외.
    if (year === first.slice(0, 4) && !first.endsWith("01")) continue;
    const partial = year === last.slice(0, 4) && lastMonth !== 12;
    const count = list.reduce((s, p) => s + p.count, 0);
    const prevList = byYear.get(String(Number(year) - 1));
    const prevYearComplete =
      prevList && !(String(Number(year) - 1) === first.slice(0, 4) && !first.endsWith("01"));
    const prev = prevYearComplete
      ? prevList!
          .filter((p) => !partial || Number(p.ym.slice(4, 6)) <= lastMonth)
          .reduce((s, p) => s + p.count, 0)
      : null;
    out.push({
      year,
      label: partial ? `${year}년 1~${lastMonth}월` : `${year}년`,
      count,
      prev,
      pct: prev && prev > 0 ? Math.round((count / prev - 1) * 1000) / 10 : null,
      partial,
    });
  }
  return out.sort((a, b) => (a.year < b.year ? 1 : -1));
}

function sumRange(points: Array<{ ym: string; count: number }>, from: string, to: string): number | null {
  const sel = points.filter((p) => p.ym >= from && p.ym <= to);
  return sel.length === 12 ? sel.reduce((s, p) => s + p.count, 0) : null;
}

export function TrendsVolumeSection({
  regionLabel,
  volume,
  period,
  loading,
  error,
  onRetry,
}: {
  regionLabel: string;
  volume: TrendSeries["volume"] | undefined;
  period: TrendPeriod;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const points = useMemo(() => volume?.points ?? [], [volume]);
  const allRows = useMemo(() => withMovingAverage(points), [points]);
  const rows = useMemo(() => sliceByPeriod(allRows, period), [allRows, period]);
  const years = useMemo(() => yearlyTotals(points), [points]);
  const visibleYears = expanded ? years : years.slice(0, LAB_LIST_PREVIEW);

  const to = volume?.to ?? null;
  const recent12 = to ? sumRange(points, ymShift(to, -11), to) : null;
  const prev12 = to ? sumRange(points, ymShift(to, -23), ymShift(to, -12)) : null;
  const change12 = recent12 != null && prev12 ? (recent12 / prev12 - 1) * 100 : null;
  const monthlyAvg = rows.length ? Math.round(rows.reduce((s, r) => s + r.count, 0) / rows.length) : null;
  const maxRow = rows.reduce<Row | null>((b, r) => (!b || r.count > b.count ? r : b), null);

  const ticks = rows.length ? niceTicks(0, Math.max(...rows.map((r) => r.count))) : [];
  const xTicks = yearTicks(rows);
  const shortPeriod =
    rows.length > 0 && period !== "all" && rows[0]!.ym === points[0]?.ym && points.length > 0;

  return (
    <LabSection
      id="volume"
      title="거래량 흐름"
      label={`${regionLabel} 아파트 매매 거래량 흐름`}
      meta="계약월 기준"
      tip={
        <>
          <p>
            국토교통부 아파트 매매 실거래 신고 건수를 계약한 달 기준으로 센 값입니다. 신고 기한(계약 후 30일)이
            지나지 않은 최근 달은 아직 덜 집계돼 제외했습니다.
          </p>
          <p className="mt-1.5">
            출처: 국토교통부 아파트 매매 실거래가 · 계약월 기준
            {volume?.from ? ` · ${ymDot(volume.from)}부터 수집` : ""}
            {volume?.to ? ` · ${ymDot(volume.to)}까지 (신고 기한이 지난 달)` : ""}
          </p>
        </>
      }
    >
      {error ? (
        <SectionError onRetry={onRetry} />
      ) : volume?.note ? (
        <p className="lab-state">{volume.note}</p>
      ) : !loading && (!volume || points.length === 0) ? (
        <p className="lab-state">이 지역은 아직 거래량 자료가 없습니다.</p>
      ) : (
        <>
          <LabStatTiles
            columns={3}
            loading={loading}
            items={[
              {
                key: "recent",
                label: "최근 12개월",
                value: recent12 != null ? `${recent12.toLocaleString("ko-KR")}건` : "—",
                sub:
                  change12 != null ? (
                    <span className={toneOf(change12) === "up" ? "detail-change-up" : toneOf(change12) === "down" ? "detail-change-down" : ""}>
                      직전 대비 {signedPct(change12)}
                    </span>
                  ) : (
                    "직전 12개월 자료 없음"
                  ),
              },
              {
                key: "avg",
                label: "월평균",
                value: monthlyAvg != null ? `${monthlyAvg.toLocaleString("ko-KR")}건` : "—",
                sub: rows.length ? `그래프 ${rows.length}개월` : undefined,
              },
              {
                key: "max",
                label: "최다 월",
                value: maxRow ? `${maxRow.count.toLocaleString("ko-KR")}건` : "—",
                sub: maxRow ? ymDot(maxRow.ym) : undefined,
              },
            ]}
          />

          <div className={LAB_SUBSECTION_RULE}>
            <LabSubsectionHeader title="월별 매매 거래량" meta="건" />
            <div className="mt-3">
              {loading ? (
                <ChartSkeleton />
              ) : (
                <>
                  <div className={CHART_BOX}>
                    <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart data={rows} margin={{ top: 8, right: 4, bottom: 0, left: -8 }} barCategoryGap={1}>
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
                          domain={[0, ticks.at(-1) ?? "auto"]}
                          ticks={ticks}
                          tick={CHART_TICK}
                          tickLine={false}
                          axisLine={false}
                          width={48}
                          tickFormatter={(v: number) => (v >= 10000 ? `${v / 10000}만` : v.toLocaleString("ko-KR"))}
                        />
                        <Tooltip
                          cursor={{ fill: "rgba(148,163,184,0.12)" }}
                          content={({ active, label }) => {
                            const row = active ? rows.find((r) => r.ym === label) : null;
                            if (!row) return null;
                            return (
                              <ChartTooltipBox
                                title={ymDot(row.ym)}
                                rows={[
                                  { key: "c", name: "거래량", color: CHART_VOLUME, value: `${row.count.toLocaleString("ko-KR")}건` },
                                  ...(row.avg12 != null
                                    ? [{ key: "a", name: "12개월 평균", color: CHART_TRADE, value: `${row.avg12.toLocaleString("ko-KR")}건` }]
                                    : []),
                                ]}
                              />
                            );
                          }}
                        />
                        <Bar dataKey="count" fill={CHART_VOLUME} fillOpacity={0.35} isAnimationActive={false} name="거래량" />
                        <Line
                          dataKey="avg12"
                          type="monotone"
                          stroke={CHART_TRADE}
                          strokeWidth={2}
                          dot={false}
                          activeDot={{ r: 4, fill: CHART_TRADE, stroke: "#fff", strokeWidth: 2 }}
                          isAnimationActive={false}
                          name="12개월 평균"
                        />
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="mt-1">
                    <ChartLegend
                      items={[
                        { key: "c", label: "월 거래량", color: CHART_VOLUME, shape: "bar" },
                        { key: "a", label: "12개월 평균", color: CHART_TRADE, shape: "line" },
                      ]}
                    />
                  </div>
                  {shortPeriod ? (
                    <p className="detail-meta mt-1">
                      이 지역 거래량은 {ymKorean(points[0]!.ym)}부터 수집돼 선택한 기간보다 짧습니다.
                    </p>
                  ) : null}
                </>
              )}
            </div>
          </div>

          {years.length > 0 ? (
            <div className={LAB_SUBSECTION_RULE}>
              <LabSubsectionHeader
                title="연도별 거래량"
                meta="전년 대비"
                tip={<p>올해는 최신 집계 달까지 합계를 전년 같은 기간과 비교합니다.</p>}
              />
              <ul className={`${LAB_LIST} mt-1`}>
                {visibleYears.map((y) => (
                  <LabListRow
                    key={y.year}
                    title={y.label}
                    meta={y.prev != null ? `전년 ${y.partial ? "같은 기간 " : ""}${y.prev.toLocaleString("ko-KR")}건` : "전년 자료 없음"}
                    value={`${y.count.toLocaleString("ko-KR")}건`}
                    sub={
                      y.pct != null ? (
                        <span className={toneOf(y.pct) === "up" ? "detail-change-up" : toneOf(y.pct) === "down" ? "detail-change-down" : ""}>
                          {signedPct(y.pct)}
                        </span>
                      ) : undefined
                    }
                  />
                ))}
              </ul>
              {years.length > LAB_LIST_PREVIEW ? (
                <LabMoreButton
                  expanded={expanded}
                  onToggle={() => setExpanded((v) => !v)}
                  label={`${years.length - LAB_LIST_PREVIEW}개 연도 더보기`}
                />
              ) : null}
            </div>
          ) : null}

        </>
      )}
    </LabSection>
  );
}

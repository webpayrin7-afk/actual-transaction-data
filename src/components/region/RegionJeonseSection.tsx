"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { Area, ComposedChart, ResponsiveContainer, XAxis, YAxis } from "recharts";
import { LabTabs } from "@/components/ui/LabTabs";
import {
  LIST_PREVIEW,
  ListMoreButton,
  MARKET_SECTION_SURFACE,
  MarketSectionHeader,
} from "@/components/region/RegionMarketSections";
import { rankingComplexHref } from "@/lib/region-ranking/public";
import type { RegionJeonse } from "@/lib/region/region-jeonse";
import { formatEok } from "@/lib/utils/format";

const LINE = "#087F83";
const RECENT_MONTHS = 60;

const PERIODS = [
  { id: "5y", label: "최근 5년" },
  { id: "all", label: "전체 기간" },
] as const;
type PeriodId = (typeof PERIODS)[number]["id"];

const TABS = [
  { id: "gap", label: "갭 작은 순" },
  { id: "ratio", label: "전세가율 순" },
  { id: "drop", label: "전세 하락 순" },
] as const;
type TabId = (typeof TABS)[number]["id"];

type Row = {
  key: string;
  complexId: string;
  name: string;
  meta: string;
  value: string;
  sub: string;
  tone?: "down";
};

function monthLabel(ym: string): string {
  return `${ym.slice(0, 4)}.${ym.slice(4, 6)}`;
}

function pct(ratio: number): string {
  return `${Math.round(ratio * 1000) / 10}%`;
}

function areaLabel(area: number): string {
  return `전용 ${Math.round(area)}㎡`;
}

function useRegionJeonse(lawdCd: string) {
  return useQuery({
    queryKey: ["region-jeonse", lawdCd],
    queryFn: async () => {
      const res = await fetch(`/api/region-jeonse?lawd_cd=${lawdCd}`);
      if (!res.ok) throw new Error("jeonse");
      return (await res.json()) as RegionJeonse;
    },
    staleTime: 30 * 60_000,
    retry: 1,
  });
}

export function RegionJeonseSection({
  lawdCd,
  regionSlug,
  regionName,
}: {
  lawdCd: string;
  regionSlug: string;
  regionName: string;
}) {
  const query = useRegionJeonse(lawdCd);
  const [tab, setTab] = useState<TabId>("gap");
  const [expanded, setExpanded] = useState(false);
  const data = query.data?.status === "ok" ? query.data : null;

  const [period, setPeriod] = useState<PeriodId>("5y");
  const allPoints = useMemo(() => {
    const series = data?.series ?? [];
    const first = series.findIndex((p) => p.jeonseRatio != null);
    return (first < 0 ? [] : series.slice(first)).map((p) => ({
      label: monthLabel(p.yearMonth),
      ratio: p.jeonseRatio == null ? null : Math.round(p.jeonseRatio * 1000) / 10,
    }));
  }, [data]);
  const hasLongHistory = allPoints.length > RECENT_MONTHS;
  const points =
    hasLongHistory && period === "5y" ? allPoints.slice(-RECENT_MONTHS) : allPoints;

  const rows = useMemo<Row[]>(() => {
    if (!data) return [];
    if (tab === "drop") {
      return data.jeonseBelow2yAgo.items.map((d) => ({
        key: `${d.complexId}|${d.exclusiveArea}`,
        complexId: d.complexId,
        name: d.aptName,
        meta: [d.dong, areaLabel(d.exclusiveArea)].filter(Boolean).join(" · "),
        value: `${formatEok(Math.abs(d.change))} 하락`,
        sub: `전세 ${formatEok(d.jeonseNow)} · 2년 전 ${formatEok(d.jeonse2yAgo)}`,
        tone: "down",
      }));
    }
    const source = tab === "gap" ? data.lowGap : data.highRatio;
    return source.map((p) => ({
      key: `${p.complexId}|${p.exclusiveArea}`,
      complexId: p.complexId,
      name: p.aptName,
      meta: [p.dong, areaLabel(p.exclusiveArea)].filter(Boolean).join(" · "),
      value: tab === "gap" ? `갭 ${formatEok(p.gap)}` : `전세가율 ${pct(p.jeonseRatio)}`,
      sub: `매매 ${formatEok(p.tradeMedian)} · 전세 ${formatEok(p.jeonseMedian)}`,
    }));
  }, [data, tab]);

  if (query.isError || (query.isSuccess && !data)) return null;

  const latest = data?.latest ?? null;
  const change = latest?.change1yPp ?? null;
  const drop = data?.jeonseBelow2yAgo ?? null;
  const januaries = points.filter((p) => p.label.endsWith(".01")).map((p) => p.label);
  const tickEvery = januaries.length > 12 ? 3 : januaries.length > 7 ? 2 : 1;
  const yearTicks = januaries.filter((_, i) => (januaries.length - 1 - i) % tickEvery === 0);
  const ratios = points.flatMap((p) => (p.ratio == null ? [] : [p.ratio]));
  const yMin = ratios.length ? Math.floor(Math.min(...ratios) / 10) * 10 : 0;
  const yMax = ratios.length ? Math.max(Math.ceil(Math.max(...ratios) / 10) * 10, yMin + 10) : 100;
  const yTicks = Array.from({ length: (yMax - yMin) / 10 + 1 }, (_, i) => yMin + i * 10);

  return (
    <section
      aria-label={`${regionName} 전세가율과 갭`}
      className={`${MARKET_SECTION_SURFACE} flex flex-col gap-3`}
    >
      <MarketSectionHeader
        title="전세가율 · 갭"
        meta={data ? `${monthLabel(data.asOfMonth)} 기준 · 최근 3개월 실거래` : undefined}
        tip={
          <p>
            같은 단지·면적에서 최근 매매 가격 대비 전세 가격 수준입니다. 갭은 매매가와
            전세가의 차이이며, 전세 하락은 2년 전 계약 때보다 전세 가격이 낮아진 단지를
            보여줍니다. 월세 낀 계약은 제외합니다.
          </p>
        }
      />

      {query.isLoading || !data ? (
        <div className="space-y-2">
          <div className="h-10 w-40 animate-pulse rounded-lg bg-slate-100" />
          <div className="h-[120px] animate-pulse rounded-lg bg-slate-100" />
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
            <div>
              <p className="detail-label">{regionName} 전세가율</p>
              <p className="detail-kpi-value tabular-nums">
                {latest?.jeonseRatio != null ? pct(latest.jeonseRatio) : "—"}
              </p>
            </div>
            {change != null ? (
              <p className="detail-meta tabular-nums">
                1년 전보다{" "}
                <span
                  className="font-semibold"
                  style={{
                    color:
                      change > 0
                        ? "var(--lab-change-up)"
                        : change < 0
                          ? "var(--lab-change-down)"
                          : undefined,
                  }}
                >
                  {change > 0 ? "+" : ""}
                  {change.toFixed(1)}%p
                </span>
              </p>
            ) : null}
          </div>

          {hasLongHistory ? (
            <div className="flex justify-end">
              <LabTabs
                variant="compact"
                ariaLabel="전세가율 그래프 기간"
                equalWidth={false}
                items={PERIODS}
                value={period}
                onChange={setPeriod}
              />
            </div>
          ) : null}
          {points.length > 1 ? (
            <div className="h-[120px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={points} margin={{ top: 6, right: 4, bottom: 0, left: -18 }}>
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
                    domain={[yMin, yMax]}
                    ticks={yTicks}
                    tickFormatter={(v: number) => `${v}%`}
                    tick={{ fontSize: 12, fill: "#64748b" }}
                    tickLine={false}
                    axisLine={false}
                    width={44}
                  />
                  <Area
                    dataKey="ratio"
                    type="monotone"
                    stroke={LINE}
                    strokeWidth={2}
                    fill={LINE}
                    fillOpacity={0.08}
                    connectNulls
                    isAnimationActive={false}
                    dot={false}
                    activeDot={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          ) : null}

          {drop && drop.eligible > 0 ? (
            <p className="detail-body tabular-nums">
              2년 전보다 전세가 낮아진 단지{" "}
              <span className="font-semibold" style={{ color: "var(--lab-change-down)" }}>
                {drop.count.toLocaleString("ko-KR")}곳
              </span>{" "}
              <span className="detail-meta">
                (비교 가능 {drop.eligible.toLocaleString("ko-KR")}곳 중)
              </span>
            </p>
          ) : null}

          <div className="border-t border-[color:var(--lab-border)] pt-3">
            <LabTabs
              variant="secondary"
              ariaLabel="전세 목록 기준"
              items={TABS}
              value={tab}
              onChange={(next) => {
                setTab(next);
                setExpanded(false);
              }}
            />
          </div>

          {rows.length === 0 ? (
            <p className="detail-body">
              {tab === "drop"
                ? "2년 전보다 전세가 낮아진 단지가 없습니다."
                : "비교할 만큼 거래된 단지가 아직 없습니다."}
            </p>
          ) : (
            <ul className="divide-y divide-[color:var(--lab-border)]">
              {(expanded ? rows : rows.slice(0, LIST_PREVIEW)).map((row) => {
                const href = rankingComplexHref({
                  aptName: row.name,
                  regionSlug,
                  gu: regionName,
                  complexId: row.complexId,
                });
                const body = (
                  <>
                    <div className="min-w-0 flex-1">
                      <p className="detail-data-value-emphasis truncate">{row.name || "—"}</p>
                      <p className="detail-meta truncate">{row.meta}</p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p
                        className="detail-data-value-emphasis whitespace-nowrap tabular-nums"
                        style={row.tone === "down" ? { color: "var(--lab-change-down)" } : undefined}
                      >
                        {row.value}
                      </p>
                      <p className="detail-meta whitespace-nowrap tabular-nums">{row.sub}</p>
                    </div>
                    <ChevronRight className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
                  </>
                );
                const cls = "flex min-h-11 items-center gap-3 py-2.5";
                return (
                  <li key={row.key}>
                    {href ? (
                      <Link href={href} className={`${cls} hover:bg-slate-50`}>
                        {body}
                      </Link>
                    ) : (
                      <div className={cls}>{body}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {rows.length > LIST_PREVIEW ? (
            <ListMoreButton
              expanded={expanded}
              onToggle={() => setExpanded((v) => !v)}
              label={`${rows.length - LIST_PREVIEW}곳 더보기`}
            />
          ) : null}
        </>
      )}
    </section>
  );
}

"use client";

import { LAB_SECTION_SURFACE, LabSectionHeader } from "@/components/ui/LabSection";
import { LAB_LIST_PREVIEW, LabMoreButton } from "@/components/ui/LabMoreButton";
import { useMemo, useState } from "react";
import { Area, ComposedChart, ResponsiveContainer, XAxis, YAxis } from "recharts";
import { LabTabs } from "@/components/ui/LabTabs";
import { LAB_LIST, LabListRow } from "@/components/ui/LabListRow";
import { rankingComplexHref } from "@/lib/region-ranking/public";
import { useRegionJeonse } from "@/components/region/useRegionScopeQueries";
import type { RegionScope } from "@/lib/region/region-scope";
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

export function RegionJeonseSection({
  scope,
  regionSlug,
  regionName,
  label,
}: {
  scope: RegionScope;
  regionSlug: string;
  /** 구 이름 — 단지 상세 링크의 gu 파라미터. */
  regionName: string;
  /** 화면 표기 지역명 (기본 regionName, 동 페이지는 동 이름). */
  label?: string;
}) {
  const place = label ?? regionName;
  const query = useRegionJeonse(scope);
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
        meta: [scope.dong ? null : d.dong, areaLabel(d.exclusiveArea)].filter(Boolean).join(" · "),
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
      meta: [scope.dong ? null : p.dong, areaLabel(p.exclusiveArea)].filter(Boolean).join(" · "),
      value: tab === "gap" ? `갭 ${formatEok(p.gap)}` : `전세가율 ${pct(p.jeonseRatio)}`,
      sub: `매매 ${formatEok(p.tradeMedian)} · 전세 ${formatEok(p.jeonseMedian)}`,
    }));
  }, [data, tab, scope.dong]);

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
      id="market-jeonse"
      aria-label={`${place} 전세가율과 갭`}
      className={`${LAB_SECTION_SURFACE} flex flex-col gap-3`}
    >
      <LabSectionHeader
        title="전세가율 · 갭"
        meta={data ? `${monthLabel(data.asOfMonth)} 기준 · 최근 3개월 실거래` : undefined}
        tip={
          <p>
            같은 단지·면적에서 최근 매매 가격 대비 전세 가격 수준입니다. 갭은 매매가와
            전세가의 차이이며, 전세 하락은 2년 전 계약 때보다 전세 가격이 낮아진 단지를
            보여줍니다(2년 전과 비교할 수 있는 단지 중 하락한 곳 수). 월세 낀 계약은
            제외합니다.
          </p>
        }
      />

      {query.isLoading || !data ? (
        <div className="space-y-2">
          <div className="h-10 w-40 animate-pulse rounded-lg bg-slate-100" />
          <div className="h-[120px] animate-pulse rounded-lg bg-slate-100" />
        </div>
      ) : (latest?.pairCount ?? 0) === 0 ? (
        <p className="detail-body">
          최근 3개월에 매매와 전세가 함께 거래된 단지가 없어 전세가율을 계산하지 않았어요.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
            <div>
              <p className="detail-label">{place} 전세가율</p>
              <p className="detail-kpi-value tabular-nums">
                {latest?.jeonseRatio != null ? pct(latest.jeonseRatio) : "—"}
              </p>
              {scope.dong && latest ? (
                <p className="detail-meta tabular-nums">
                  단지·면적 {latest.pairCount.toLocaleString("ko-KR")}곳 기준
                </p>
              ) : null}
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
            <div className="flex items-baseline justify-between gap-3">
              <p className="detail-label whitespace-nowrap">2년 전 대비 전세 하락</p>
              <p className="whitespace-nowrap tabular-nums">
                <span
                  className="detail-data-value-emphasis"
                  style={{ color: "var(--lab-change-down)" }}
                >
                  {drop.count.toLocaleString("ko-KR")}곳
                </span>
                <span className="detail-meta ml-1">
                  / {drop.eligible.toLocaleString("ko-KR")}곳
                </span>
              </p>
            </div>
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
            <ul className={LAB_LIST}>
              {(expanded ? rows : rows.slice(0, LAB_LIST_PREVIEW)).map((row) => (
                <LabListRow
                  key={row.key}
                  href={rankingComplexHref({
                    aptName: row.name,
                    regionSlug,
                    gu: regionName,
                    complexId: row.complexId,
                  })}
                  title={row.name || "—"}
                  meta={row.meta}
                  value={row.value}
                  sub={row.sub}
                  valueTone={row.tone}
                />
              ))}
            </ul>
          )}
          {rows.length > LAB_LIST_PREVIEW ? (
            <LabMoreButton
              expanded={expanded}
              onToggle={() => setExpanded((v) => !v)}
              label={`${rows.length - LAB_LIST_PREVIEW}곳 더보기`}
            />
          ) : null}
        </>
      )}
    </section>
  );
}

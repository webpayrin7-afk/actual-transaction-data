"use client";

import { useMemo, useState } from "react";
import { RankCircle } from "@/components/ui/RankCircle";
import { useQuery } from "@tanstack/react-query";
import { LabSection } from "@/components/ui/LabSection";
import { LabTabs } from "@/components/ui/LabTabs";
import { LAB_LIST, LabListRow } from "@/components/ui/LabListRow";
import { LAB_LIST_PREVIEW, LabMoreButton } from "@/components/ui/LabMoreButton";
import type { TrendRankRow, TrendRanking } from "@/lib/market/trends";
import type { TrendRegionGroup } from "@/lib/market/trends-regions";
import { SectionError, signedPct, toneOf, ymDot } from "@/components/stats/trends-chart-kit";

const GROUPS = [
  { id: "sido", label: "시도" },
  { id: "seoul", label: "서울 구" },
] as const;
type Group = (typeof GROUPS)[number]["id"];

const METRICS = [
  { id: "1y", label: "1년" },
  { id: "3y", label: "3년" },
  { id: "5y", label: "5년" },
  { id: "10y", label: "10년" },
  { id: "peak", label: "고점 대비" },
] as const;
type Metric = (typeof METRICS)[number]["id"];

async function fetchRanking(group: TrendRegionGroup): Promise<TrendRanking> {
  const res = await fetch(`/api/market-trends/regions?group=${group}`);
  if (!res.ok) throw new Error("ranking");
  return res.json();
}

function metricValue(row: TrendRankRow, metric: Metric): number | null {
  return metric === "peak" ? row.fromPeak : row.change[metric];
}

/** 순위 목록 공통 표시 */
function RankBadge({ rank }: { rank: number }) {
  return (
    <span className="mr-2 inline-flex align-[-6px]">
      <RankCircle rank={rank} />
    </span>
  );
}

export function TrendsRegionCompareSection({
  selectedRegionId,
  initialGroup,
  onSelect,
}: {
  selectedRegionId: string;
  initialGroup: Group;
  onSelect: (regionId: string) => void;
}) {
  const [group, setGroup] = useState<Group>(initialGroup);
  const [metric, setMetric] = useState<Metric>("1y");
  const [expanded, setExpanded] = useState(false);

  const query = useQuery({
    queryKey: ["market-trends-regions", group],
    queryFn: () => fetchRanking(group),
    staleTime: 30 * 60_000,
    retry: 1,
  });

  const sorted = useMemo(() => {
    const rows = query.data?.rows ?? [];
    return rows
      .map((r) => ({ row: r, v: metricValue(r, metric) }))
      .filter((x): x is { row: TrendRankRow; v: number } => x.v != null)
      .sort((a, b) => b.v - a.v);
  }, [query.data, metric]);
  const visible = expanded ? sorted : sorted.slice(0, LAB_LIST_PREVIEW);
  const upCount = sorted.filter((x) => toneOf(x.v) === "up").length;
  const downCount = sorted.filter((x) => toneOf(x.v) === "down").length;
  const metricLabel = METRICS.find((m) => m.id === metric)!.label;

  return (
    <LabSection
      id="region-compare"
      title="지역별 장기 변동"
      meta={query.data?.latestYm ? `${ymDot(query.data.latestYm)} 기준 · 매매가격지수` : "매매가격지수"}
      tip={
        <>
          <p>한국부동산원 월간 아파트 매매가격지수로 기간별 변동률을 비교합니다. 같은 달끼리 비교합니다.</p>
          <p className="mt-1.5">고점 대비: 2003년 11월 이후 가장 높았던 달의 지수와 비교한 현재 수준입니다.</p>
          <p className="mt-1.5">
            지역을 누르면 위 그래프가 그 지역으로 바뀝니다.
            {query.data && query.data.missing > 0 ? ` 원천 응답이 없는 ${query.data.missing}곳은 빠졌습니다.` : ""}
          </p>
          <p className="mt-1.5">출처: 한국부동산원 전국주택가격동향조사 (월간 아파트 매매가격지수)</p>
        </>
      }
    >
      <LabTabs
        variant="secondary"
        items={GROUPS}
        value={group}
        onChange={(g) => {
          setGroup(g);
          setExpanded(false);
        }}
        ariaLabel="비교 지역 묶음"
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="detail-meta tabular-nums">
          {query.data && sorted.length
            ? metric === "peak"
              ? `${sorted.length}곳 중 고점 대비 10% 이상 낮은 곳 ${sorted.filter((x) => x.v <= -10).length}곳`
              : `${metricLabel} 동안 ${sorted.length}곳 중 오른 곳 ${upCount} · 내린 곳 ${downCount}`
            : " "}
        </p>
        <LabTabs
          variant="compact"
          items={METRICS}
          value={metric}
          onChange={(m) => {
            setMetric(m);
            setExpanded(false);
          }}
          ariaLabel="비교 기간"
        />
      </div>

      {query.isError ? (
        <SectionError onRetry={() => query.refetch()} />
      ) : query.isLoading ? (
        <div className="h-[280px] animate-pulse rounded-lg bg-slate-100" aria-hidden />
      ) : sorted.length === 0 ? (
        <p className="lab-state">비교할 지역이 없습니다.</p>
      ) : (
        <>
          <ul className={LAB_LIST}>
            {visible.map(({ row, v }, i) => (
              <LabListRow
                key={row.regionId}
                onClick={() => onSelect(row.regionId)}
                selected={row.regionId === selectedRegionId}
                title={
                  <>
                    <RankBadge rank={i + 1} />
                    {row.label}
                  </>
                }
                meta={
                  Number(row.fromPeak.toFixed(1)) === 0
                    ? `현재가 최고점 (${ymDot(row.peakYm)})`
                    : `전고점 ${ymDot(row.peakYm)}${metric === "peak" ? "" : ` · 고점 대비 ${signedPct(row.fromPeak)}`}`
                }
                value={metric === "peak" && Number(v.toFixed(1)) === 0 ? "최고점" : signedPct(v)}
                valueTone={toneOf(v) === "neutral" ? undefined : (toneOf(v) as "up" | "down")}
              />
            ))}
          </ul>
          {sorted.length > LAB_LIST_PREVIEW ? (
            <LabMoreButton
              expanded={expanded}
              onToggle={() => setExpanded((x) => !x)}
              label={`${sorted.length - LAB_LIST_PREVIEW}곳 더보기`}
            />
          ) : null}
        </>
      )}
    </LabSection>
  );
}

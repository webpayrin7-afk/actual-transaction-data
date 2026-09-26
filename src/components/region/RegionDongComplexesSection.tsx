"use client";

import { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { LabDataLoading } from "@/components/ui/LabLoading";
import { LabSection } from "@/components/ui/LabSection";
import { LabTabs } from "@/components/ui/LabTabs";
import { LAB_LIST, LabListRow } from "@/components/ui/LabListRow";
import { LAB_LIST_PREVIEW, LabMoreButton } from "@/components/ui/LabMoreButton";
import { rankingComplexHref } from "@/lib/region-ranking/public";
import { formatEok } from "@/lib/utils/format";
import type {
  RegionDongComplex,
  RegionDongOverview,
} from "@/lib/region/region-dong-overview";

/** 지도는 "지도" 보기를 고를 때만 SDK와 함께 불러온다 — 메인 지도와 같은 가격 마커. */
const DongComplexMap = dynamic(() => import("@/components/region/DongComplexMap").then((m) => m.DongComplexMap), {
  ssr: false,
  loading: () => <LabDataLoading label="지도 불러오는 중" className="h-full w-full" />,
});

const VIEWS = [
  { id: "list", label: "목록" },
  { id: "map", label: "지도" },
] as const;
type ViewId = (typeof VIEWS)[number]["id"];

const SORTS = [
  { id: "households", label: "세대 많은 순" },
  { id: "trades", label: "거래 많은 순" },
  { id: "newest", label: "새 아파트 순" },
] as const;
type SortId = (typeof SORTS)[number]["id"];

function sortComplexes(list: RegionDongComplex[], sort: SortId): RegionDongComplex[] {
  const byName = (a: RegionDongComplex, b: RegionDongComplex) => a.aptName.localeCompare(b.aptName, "ko");
  return [...list].sort((a, b) => {
    if (sort === "trades") return b.trades12m - a.trades12m || byName(a, b);
    if (sort === "newest") return (b.buildYear ?? 0) - (a.buildYear ?? 0) || byName(a, b);
    return (b.householdCount ?? 0) - (a.householdCount ?? 0) || byName(a, b);
  });
}

function ComplexRow({
  complex,
  regionSlug,
  guName,
  selected,
}: {
  complex: RegionDongComplex;
  regionSlug: string;
  guName: string;
  selected?: boolean;
}) {
  const meta = [
    complex.buildYear ? `${complex.buildYear}년` : null,
    complex.householdCount ? `${complex.householdCount.toLocaleString("ko-KR")}세대` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const latest = complex.latestTrade;
  return (
    <LabListRow
      href={rankingComplexHref({
        aptName: complex.aptName,
        regionSlug,
        gu: guName,
        complexId: complex.complexId,
      })}
      selected={selected}
      title={complex.aptName || "—"}
      meta={meta || undefined}
      value={latest ? formatEok(latest.dealAmount) : "—"}
      sub={
        complex.trades12m > 0
          ? `1년 매매 ${complex.trades12m.toLocaleString("ko-KR")}건`
          : "최근 1년 매매 없음"
      }
    />
  );
}

/** 동 상세 — 단지 목록(정렬 3종) · 지도 보기. 목록 5개 + 더보기. */
export function RegionDongComplexesSection({
  dong,
  data,
  loading,
  failed,
  regionSlug,
  guName,
}: {
  dong: string;
  data: RegionDongOverview | null;
  loading: boolean;
  failed: boolean;
  regionSlug: string;
  /** 단지 상세 링크의 gu 파라미터. */
  guName: string;
}) {
  const [view, setView] = useState<ViewId>("list");
  const [sort, setSort] = useState<SortId>("households");
  const [expanded, setExpanded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const complexes = useMemo(() => data?.complexes ?? [], [data]);
  const sorted = useMemo(() => sortComplexes(complexes, sort), [complexes, sort]);
  const mapped = useMemo(
    () => complexes.filter((c) => c.lat != null && c.lng != null),
    [complexes],
  );
  const selected = selectedId ? complexes.find((c) => c.complexId === selectedId) ?? null : null;
  const households = complexes.reduce((s, c) => s + (c.householdCount ?? 0), 0);
  const visible = expanded ? sorted : sorted.slice(0, LAB_LIST_PREVIEW);

  return (
    <LabSection
      id="dong-complexes"
      label={`${dong} 단지 목록`}
      title="단지 목록"
      meta={
        complexes.length
          ? `${complexes.length.toLocaleString("ko-KR")}개 단지${households > 0 ? ` · ${households.toLocaleString("ko-KR")}세대` : ""}`
          : undefined
      }
      tip={
        <p>
          {dong}에 있는 아파트 단지입니다. 가격은 최근 매매 실거래가이고, 거래 수는 최근
          1년 계약 기준입니다. 단지를 누르면 상세로 이동합니다.
        </p>
      }
    >
      {failed ? (
        <p className="detail-body">단지 목록을 불러오지 못했습니다.</p>
      ) : loading ? (
        <LabDataLoading label="단지 불러오는 중" minHeight={272} />
      ) : complexes.length === 0 ? (
        <p className="detail-body">이 동에서 찾은 아파트 단지가 없습니다.</p>
      ) : (
        <>
          {mapped.length > 0 ? (
            <LabTabs
              variant="secondary"
              ariaLabel="단지 보기 방식"
              items={VIEWS}
              value={view}
              onChange={setView}
            />
          ) : null}
          {view === "map" && mapped.length ? (
            <>
              <div className="relative h-[320px] w-full overflow-hidden rounded-xl border border-[color:var(--lab-border)] lg:h-[420px]">
                <DongComplexMap
                  complexes={mapped}
                  selectedId={selectedId}
                  onSelect={(id) => setSelectedId((prev) => (prev === id ? null : id))}
                  ariaLabel={`${dong} 아파트 단지 지도`}
                  lawdCd={data?.lawdCd ?? null}
                  dong={dong}
                />
              </div>
              {selected ? (
                <ul className={LAB_LIST}>
                  <ComplexRow complex={selected} regionSlug={regionSlug} guName={guName} selected />
                </ul>
              ) : (
                <p className="detail-meta">
                  단지 표시를 누르면 아래에 단지 정보가 나와요.
                  {mapped.length < complexes.length
                    ? ` 위치를 찾지 못한 ${complexes.length - mapped.length}곳은 목록에서 볼 수 있어요.`
                    : ""}
                </p>
              )}
            </>
          ) : (
            <>
              <LabTabs
                variant="secondary"
                ariaLabel="단지 목록 정렬"
                items={SORTS}
                value={sort}
                onChange={(next) => {
                  setSort(next);
                  setExpanded(false);
                }}
              />
              <ul className={LAB_LIST}>
                {visible.map((c) => (
                  <ComplexRow key={c.complexId} complex={c} regionSlug={regionSlug} guName={guName} />
                ))}
              </ul>
              {sorted.length > LAB_LIST_PREVIEW ? (
                <LabMoreButton
                  expanded={expanded}
                  onToggle={() => setExpanded((v) => !v)}
                  label={`${sorted.length - LAB_LIST_PREVIEW}곳 더보기`}
                />
              ) : null}
            </>
          )}
        </>
      )}
    </LabSection>
  );
}

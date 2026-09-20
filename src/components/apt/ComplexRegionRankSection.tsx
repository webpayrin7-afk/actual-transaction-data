"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ComplexRegionPriceCompare } from "@/components/apt/ComplexRegionPriceCompare";
import { areaSelectorPyeongLabel } from "@/lib/apt/area-selector-label";
import type { AptAreaOption } from "@/lib/molit/apt-client";
import {
  dongSmallCohortHelper,
  fetchComplexRegionRank,
  formatRankingAsOf,
  placeHeadline,
  rankingBandForArea,
  rankingSelectedHeading,
  regionOverviewCtaLabel,
  regionRankingHref,
  type AreaRankingBand,
  type ComplexRankPlace,
} from "@/lib/region-ranking/public";

function RankCell({
  line,
  empty,
}: {
  line: { title: string; meta: string | null } | null;
  empty: string;
}) {
  if (!line) {
    return (
      <p className="min-w-0 truncate text-[13px] leading-5 text-slate-500">
        {empty}
      </p>
    );
  }
  return (
    <p className="min-w-0 truncate text-[15px] font-semibold leading-5 tabular-nums text-slate-900">
      {line.title}
    </p>
  );
}

function RankPair({
  guName,
  dongName,
  gu,
  dong,
  emptyGu,
  emptyDong,
}: {
  guName: string;
  dongName: string;
  gu: ComplexRankPlace | null | undefined;
  dong: ComplexRankPlace | null | undefined;
  emptyGu: string;
  emptyDong: string;
}) {
  const guLine = placeHeadline({ regionName: guName, place: gu });
  const dongLine = placeHeadline({ regionName: dongName, place: dong });
  const sameEmpty = !guLine && !dongLine && emptyGu === emptyDong;

  if (sameEmpty) {
    return (
      <p className="text-[13px] leading-5 text-slate-500">{emptyGu}</p>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
      <RankCell line={guLine} empty={emptyGu} />
      <RankCell line={dongLine} empty={emptyDong} />
      {guLine?.meta ? (
        <p className="min-w-0 truncate text-[12px] leading-4 text-slate-500">
          {guLine.meta}
        </p>
      ) : null}
    </div>
  );
}

export function ComplexRegionRankSection({
  complexId,
  regionSlug,
  regionName,
  dongName,
  selectedArea,
}: {
  complexId?: string | null;
  regionSlug: string;
  regionName: string;
  dongName?: string | null;
  selectedArea: AptAreaOption | null;
}) {
  const areaBand: AreaRankingBand | null = rankingBandForArea(selectedArea);
  const selectedPyeongLabel = selectedArea
    ? areaSelectorPyeongLabel(selectedArea)
    : null;
  const selectedRankHeading = rankingSelectedHeading({
    pyeongLabel: selectedPyeongLabel,
    rankingBand: areaBand,
  });
  const exclusiveArea = selectedArea?.exclusiveArea ?? null;
  const id = complexId?.trim() || "";
  const enabled = /^cx_[0-9a-f]{16}$/.test(id);

  const query = useQuery({
    queryKey: ["complex-region-rank", id, areaBand ?? "ALL"],
    queryFn: () =>
      fetchComplexRegionRank({
        complexId: id,
        areaBand,
      }),
    enabled,
    staleTime: 5 * 60_000,
    retry: 1,
  });

  if (!enabled) return null;

  const data = query.data;
  const asOf = formatRankingAsOf(
    data?.transactionAsOf ??
      data?.all?.gu.transactionAsOf ??
      data?.area?.gu.transactionAsOf ??
      null,
  );
  const dongLabel = data?.dong?.trim() || dongName?.trim() || "이 동";
  const cohortHelper = dongSmallCohortHelper({
    dongName: dongLabel,
    places: [data?.all?.dong, data?.area?.dong],
  });

  return (
    <section
      id="section-region-rank"
      className="lab-card scroll-mt-28 p-3.5 sm:p-4"
    >
      <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-1">
        <h2 className="text-xl font-semibold leading-none tracking-tight text-slate-900">
          지역 내 비교
        </h2>
        {asOf ? (
          <p className="text-[12px] leading-4 text-slate-500">{asOf}</p>
        ) : null}
      </div>

      {query.isLoading ? (
        <div className="mt-3 space-y-2" aria-label="순위 불러오는 중">
          <div className="h-10 animate-pulse rounded-lg bg-slate-100" />
          <div className="h-10 animate-pulse rounded-lg bg-slate-100" />
        </div>
      ) : query.isError ? (
        <div className="mt-3 rounded-xl bg-slate-50 px-3 py-3 text-center">
          <p className="text-sm font-medium text-slate-700">
            순위를 불러오지 못했습니다.
          </p>
          <button
            type="button"
            onClick={() => void query.refetch()}
            className="lab-button lab-button-secondary mt-2 !min-h-9 px-4 text-[13px]"
          >
            다시 시도
          </button>
        </div>
      ) : (
        <div className="mt-3 space-y-2.5">
          <div>
            <p className="text-[13px] font-medium leading-5 text-slate-600">종합</p>
            <div className="mt-1">
              <RankPair
                guName={regionName}
                dongName={dongLabel}
                gu={data?.all?.gu}
                dong={data?.all?.dong}
                emptyGu="종합 순위를 준비 중이에요"
                emptyDong="이 동 종합 순위를 준비 중이에요"
              />
            </div>
          </div>

          {areaBand ? (
            <div className="border-t border-slate-100 pt-2">
              <p className="text-[13px] font-medium leading-5 text-slate-600">
                {selectedRankHeading}
              </p>
              <div className="mt-1">
                {data?.area ? (
                  <RankPair
                    guName={regionName}
                    dongName={dongLabel}
                    gu={data.area.gu}
                    dong={data.area.dong}
                    emptyGu="이 면적대는 아직 순위를 제공하지 않아요"
                    emptyDong="이 면적대는 아직 순위를 제공하지 않아요"
                  />
                ) : (
                  <p className="text-[13px] leading-5 text-slate-500">
                    이 면적대는 아직 순위를 제공하지 않아요
                  </p>
                )}
              </div>
            </div>
          ) : null}

          {cohortHelper ? (
            <p className="text-[12px] leading-4 text-slate-500">{cohortHelper}</p>
          ) : null}
        </div>
      )}

      <ComplexRegionPriceCompare
        complexId={id}
        exclusiveArea={exclusiveArea}
        selectedPyeongLabel={selectedPyeongLabel}
      />

      <Link
        href={regionRankingHref(regionSlug)}
        data-event="complex_region_rank_cta"
        className="lab-button lab-button-secondary mt-3 flex w-full !min-h-9 items-center justify-center text-[13px]"
      >
        {regionOverviewCtaLabel(regionName)}
      </Link>
    </section>
  );
}

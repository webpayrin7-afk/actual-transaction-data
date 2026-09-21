"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ComplexRegionPriceCompare } from "@/components/apt/ComplexRegionPriceCompare";
import { areaSelectorPyeongLabel } from "@/lib/apt/area-selector-label";
import type { AptAreaOption } from "@/lib/molit/apt-client";
import {
  DECADE_RANK_UNAVAILABLE_COPY,
  fetchComplexRegionRank,
  formatRankingAsOf,
  placeRankDisplay,
  rankingSelectedHeading,
  regionOverviewCtaLabel,
  regionRankingHref,
  selectedMarketPyeongInteger,
  type ComplexRankPlace,
} from "@/lib/region-ranking/public";

function RankCell({
  line,
  empty,
}: {
  line: { region: string; rank: number } | null;
  empty: string;
}) {
  if (!line) {
    return (
      <div className="min-w-0">
        <p className="truncate text-[13px] leading-5 text-slate-500">{empty}</p>
      </div>
    );
  }
  return (
    <div className="min-w-0">
      <p className="truncate text-[11px] leading-4 text-slate-500">{line.region}</p>
      <p className="truncate text-[17px] font-semibold leading-5 tabular-nums text-slate-900">
        {line.rank}위
      </p>
    </div>
  );
}

function RankPair({
  guName,
  dongName,
  gu,
  dong,
  empty,
}: {
  guName: string;
  dongName: string;
  gu: ComplexRankPlace | null | undefined;
  dong: ComplexRankPlace | null | undefined;
  empty: string;
}) {
  const guLine = placeRankDisplay({ regionName: guName, place: gu });
  const dongLine = placeRankDisplay({ regionName: dongName, place: dong });

  if (!guLine && !dongLine) {
    return <p className="text-[13px] leading-5 text-slate-500">{empty}</p>;
  }

  return (
    <div className="grid grid-cols-2 gap-x-3">
      <RankCell line={guLine} empty={empty} />
      <RankCell line={dongLine} empty={empty} />
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
  const selectedPyeongLabel = selectedArea
    ? areaSelectorPyeongLabel(selectedArea)
    : null;
  const exclusiveArea = selectedArea?.exclusiveArea ?? null;
  const marketPyeongLabel = selectedMarketPyeongInteger({
    marketLabel: selectedArea?.marketLabel,
    selectedPyeongLabel,
  });
  const id = complexId?.trim() || "";
  const enabled = /^cx_[0-9a-f]{16}$/.test(id);

  const query = useQuery({
    queryKey: ["complex-region-rank-v3", id, marketPyeongLabel ?? "ALL"],
    queryFn: () =>
      fetchComplexRegionRank({
        complexId: id,
        marketPyeongLabel,
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
  const selectedFromApi =
    data?.selectedMarketPyeongLabel != null && data.selectedMarketPyeongLabel > 0
      ? `${Math.round(data.selectedMarketPyeongLabel)}평`
      : null;
  const selectedLabel =
    marketPyeongLabel != null ? `${marketPyeongLabel}평` : selectedFromApi;
  const decadeFromApi = data?.regionPyeongDecade ?? data?.area?.regionPyeongDecade ?? null;
  const selectedRankHeading = rankingSelectedHeading({
    pyeongLabel: selectedLabel,
    rankingCohortLabel: decadeFromApi,
  });
  const showSelected = marketPyeongLabel != null || selectedFromApi != null;

  return (
    <section
      id="section-region-rank"
      className="lab-card scroll-mt-28 p-3 sm:p-3.5"
    >
      <div className="flex flex-nowrap items-center justify-between gap-2">
        <h2 className="min-w-0 truncate text-xl font-semibold leading-none tracking-tight text-slate-900">
          지역 내 비교
        </h2>
        {asOf ? (
          <p className="shrink-0 text-[11px] leading-4 text-slate-500">
            {asOf}
          </p>
        ) : null}
      </div>

      {query.isLoading ? (
        <div className="mt-2 space-y-2" aria-label="순위 불러오는 중">
          <div className="h-8 animate-pulse rounded-lg bg-slate-100" />
          <div className="h-8 animate-pulse rounded-lg bg-slate-100" />
        </div>
      ) : query.isError ? (
        <div className="mt-2 rounded-xl bg-slate-50 px-3 py-3 text-center">
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
        <div className="mt-2 space-y-2">
          <div>
            <p className="text-[13px] font-semibold leading-5 text-slate-700">
              종합 순위
            </p>
            <div className="mt-0.5">
              <RankPair
                guName={regionName}
                dongName={dongLabel}
                gu={data?.all?.gu}
                dong={data?.all?.dong}
                empty="종합 순위를 준비 중이에요"
              />
            </div>
          </div>

          {showSelected ? (
            <div className="border-t border-slate-100 pt-2">
              {selectedRankHeading ? (
                <p className="text-[13px] font-medium leading-5 text-slate-600">
                  {selectedRankHeading}
                </p>
              ) : null}
              <div className={selectedRankHeading ? "mt-0.5" : undefined}>
                <RankPair
                  guName={regionName}
                  dongName={dongLabel}
                  gu={data?.area?.gu}
                  dong={data?.area?.dong}
                  empty={DECADE_RANK_UNAVAILABLE_COPY}
                />
              </div>
            </div>
          ) : null}
        </div>
      )}

      <ComplexRegionPriceCompare
        complexId={id}
        exclusiveArea={exclusiveArea}
        marketPyeongLabel={marketPyeongLabel}
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

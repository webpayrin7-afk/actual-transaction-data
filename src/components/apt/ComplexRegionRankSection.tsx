"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ComplexRegionPriceCompare } from "@/components/apt/ComplexRegionPriceCompare";
import { InfoTip } from "@/components/ui/InfoTip";
import { areaSelectorPyeongLabel } from "@/lib/apt/area-selector-label";
import type { AptAreaOption } from "@/lib/molit/apt-client";
import {
  DECADE_RANK_UNAVAILABLE_COPY,
  ZIPLAB_RANK_TIP,
  ZIPLAB_RANK_TIP_TITLE,
  ZIPLAB_RANK_TITLE,
  fetchComplexRegionRank,
  formatRankingAsOf,
  placeRankDisplay,
  rankingDecadeRowLabel,
  regionOverviewCtaLabel,
  regionRankingHref,
  selectedMarketPyeongInteger,
  type ComplexRankPlace,
} from "@/lib/region-ranking/public";

const RANK_GRID = "grid grid-cols-[4.25rem_minmax(0,1fr)_minmax(0,1fr)] items-center gap-x-2";

function RankValue({
  place,
  regionName,
  empty,
}: {
  place: ComplexRankPlace | null | undefined;
  regionName: string;
  empty: string;
}) {
  const line = placeRankDisplay({ regionName, place });
  if (!line) {
    return (
      <p className="truncate text-[13px] leading-5 text-slate-500">{empty}</p>
    );
  }
  return (
    <p className="truncate text-[17px] font-semibold leading-5 tabular-nums text-slate-900">
      {line.rank}위
    </p>
  );
}

function RankRow({
  label,
  guName,
  dongName,
  gu,
  dong,
  empty,
}: {
  label: string;
  guName: string;
  dongName: string;
  gu: ComplexRankPlace | null | undefined;
  dong: ComplexRankPlace | null | undefined;
  empty: string;
}) {
  return (
    <div className={RANK_GRID}>
      <p className="truncate text-[15px] leading-5 text-slate-600">{label}</p>
      <RankValue place={gu} regionName={guName} empty={empty} />
      <RankValue place={dong} regionName={dongName} empty={empty} />
    </div>
  );
}

export function ComplexRegionRankSection({
  complexId,
  aptName,
  regionSlug,
  regionName,
  dongName,
  selectedArea,
}: {
  complexId?: string | null;
  aptName?: string | null;
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
  const decadeLabel = rankingDecadeRowLabel(
    data?.regionPyeongDecade ?? data?.area?.regionPyeongDecade ?? null,
  );
  const showDecade = decadeLabel != null;

  return (
    <section
      id="section-region-rank"
      className="lab-card scroll-mt-28 px-3 pt-4 pb-3 sm:px-3.5 sm:pt-5 sm:pb-3.5"
    >
      <h2 className="min-w-0 truncate text-xl font-semibold leading-none tracking-tight text-slate-900">
        지역 내 비교
      </h2>

      <div className="mt-3">
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5">
          <div className="flex min-w-0 items-center">
            <h3 className="text-sm font-semibold leading-5 text-slate-900">
              {ZIPLAB_RANK_TITLE}
            </h3>
            <InfoTip aria-label="집랩 순위 안내">
              <p className="font-medium text-slate-800">{ZIPLAB_RANK_TIP_TITLE}</p>
              {ZIPLAB_RANK_TIP.split("\n\n").map((paragraph) => (
                <p key={paragraph} className="mt-1.5 first:mt-1">
                  {paragraph}
                </p>
              ))}
            </InfoTip>
          </div>
          {asOf ? (
            <p className="shrink-0 text-right text-[11px] leading-4 text-slate-500">
              {asOf}
            </p>
          ) : null}
        </div>

        {query.isLoading ? (
          <div className="mt-2 space-y-2" aria-label="순위 불러오는 중">
            <div className="h-7 animate-pulse rounded-lg bg-slate-100" />
            <div className="h-7 animate-pulse rounded-lg bg-slate-100" />
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
          <div className="mt-2">
            <div className={RANK_GRID}>
              <span />
              <p className="truncate text-[13px] leading-5 text-slate-500">
                {regionName}
              </p>
              <p className="truncate text-[13px] leading-5 text-slate-500">
                {dongLabel}
              </p>
            </div>
            <div className="mt-1.5 space-y-4">
              <RankRow
                label="종합"
                guName={regionName}
                dongName={dongLabel}
                gu={data?.all?.gu}
                dong={data?.all?.dong}
                empty="—"
              />
              {showDecade ? (
                <RankRow
                  label={decadeLabel}
                  guName={regionName}
                  dongName={dongLabel}
                  gu={data?.area?.gu}
                  dong={data?.area?.dong}
                  empty={DECADE_RANK_UNAVAILABLE_COPY}
                />
              ) : null}
            </div>
          </div>
        )}
      </div>

      <ComplexRegionPriceCompare
        complexId={id}
        aptName={aptName}
        exclusiveArea={exclusiveArea}
        marketPyeongLabel={marketPyeongLabel}
      />

      <Link
        href={regionRankingHref(regionSlug)}
        data-event="complex_region_rank_cta"
        className="lab-button lab-button-primary mt-4 w-full min-h-10 text-sm"
      >
        {regionOverviewCtaLabel(regionName)}
        <span aria-hidden className="ml-1">
          →
        </span>
      </Link>
    </section>
  );
}

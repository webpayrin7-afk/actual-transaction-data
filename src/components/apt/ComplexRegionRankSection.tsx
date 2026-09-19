"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  fetchComplexRegionRank,
  formatRankingAsOf,
  placeHeadline,
  rankingBandForArea,
  regionRankingHref,
  type AreaRankingBand,
  type ComplexRankPlace,
} from "@/lib/region-ranking/public";

function PlaceBlock({
  regionName,
  place,
  empty,
}: {
  regionName: string;
  place: ComplexRankPlace | null | undefined;
  empty: string;
}) {
  const line = placeHeadline({ regionName, place });
  return (
    <div className="min-w-0">
      {line ? (
        <>
          <p className="text-[17px] font-semibold leading-6 tabular-nums text-slate-900">
            {line.title}
          </p>
          {line.meta ? (
            <p className="mt-0.5 text-[12px] leading-4 text-slate-500">{line.meta}</p>
          ) : null}
        </>
      ) : (
        <p className="text-[13px] leading-5 text-slate-500">{empty}</p>
      )}
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
  selectedArea: {
    exclusiveArea: number;
    exclusiveAreaMin?: number | null;
    exclusiveAreaMax?: number | null;
  } | null;
}) {
  const areaBand: AreaRankingBand | null = rankingBandForArea(selectedArea);
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
  const bandLabel = areaBand ? `${areaBand}㎡` : null;

  return (
    <section
      id="section-region-rank"
      className="lab-card scroll-mt-28 p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-1">
        <h2 className="text-xl font-semibold leading-none tracking-tight text-slate-900">
          지역 내 순위
        </h2>
        {asOf ? (
          <p className="text-[12px] leading-4 text-slate-500">{asOf}</p>
        ) : null}
      </div>

      {query.isLoading ? (
        <div className="mt-4 space-y-2" aria-label="순위 불러오는 중">
          <div className="h-16 animate-pulse rounded-xl bg-slate-100" />
          <div className="h-16 animate-pulse rounded-xl bg-slate-100" />
        </div>
      ) : query.isError ? (
        <div className="mt-4 rounded-xl bg-slate-50 px-3 py-4 text-center">
          <p className="text-sm font-medium text-slate-700">
            순위를 불러오지 못했습니다.
          </p>
          <button
            type="button"
            onClick={() => void query.refetch()}
            className="lab-button lab-button-secondary mt-3 min-h-10 px-4 text-sm"
          >
            다시 시도
          </button>
        </div>
      ) : (
        <div className="mt-4 space-y-4">
          <div>
            <p className="text-[13px] font-medium text-slate-600">종합</p>
            <div className="mt-1.5 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <PlaceBlock
                regionName={regionName}
                place={data?.all?.gu}
                empty="종합 순위를 준비 중이에요"
              />
              <PlaceBlock
                regionName={dongLabel}
                place={data?.all?.dong}
                empty="이 동 종합 순위를 준비 중이에요"
              />
            </div>
          </div>

          {areaBand ? (
            <div className="border-t border-slate-100 pt-3">
              <p className="text-[13px] font-medium text-slate-600">{bandLabel}</p>
              {data?.area ? (
                <div className="mt-1.5 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <PlaceBlock
                    regionName={regionName}
                    place={data.area.gu}
                    empty="이 면적대는 아직 순위를 제공하지 않아요"
                  />
                  <PlaceBlock
                    regionName={dongLabel}
                    place={data.area.dong}
                    empty="이 면적대는 아직 순위를 제공하지 않아요"
                  />
                </div>
              ) : (
                <p className="mt-1.5 text-[13px] leading-5 text-slate-500">
                  이 면적대는 아직 순위를 제공하지 않아요
                </p>
              )}
            </div>
          ) : null}

          <Link
            href={regionRankingHref(regionSlug)}
            data-event="complex_region_rank_cta"
            className="lab-button lab-button-secondary flex w-full min-h-10 items-center justify-center text-sm"
          >
            {regionName} 아파트 순위 보기
          </Link>
        </div>
      )}
    </section>
  );
}

"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ComplexRegionPriceCompare } from "@/components/apt/ComplexRegionPriceCompare";
import { LAB_SUBSECTION_RULE, LabSection, LabSubsectionHeader } from "@/components/ui/LabSection";
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
  rankingDongRegionCode,
  regionOverviewCtaLabel,
  regionRankingHref,
  selectedMarketPyeongInteger,
  type ComplexRankPlace,
} from "@/lib/region-ranking/public";

const RANK_GRID = "grid grid-cols-[5.5rem_minmax(0,1fr)_minmax(0,1fr)] items-center gap-x-2";

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
      <p className="detail-meta truncate">{empty}</p>
    );
  }
  return (
    <p className="detail-compact-value">
      <span>{line.rank}</span>
      <span className="detail-micro ml-0.5 font-medium">위</span>
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
      <p className="detail-label truncate">{label}</p>
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
  lawdCd,
  bjdongCd,
  selectedArea,
}: {
  complexId?: string | null;
  aptName?: string | null;
  regionSlug: string;
  regionName: string;
  dongName?: string | null;
  lawdCd?: string | null;
  bjdongCd?: string | null;
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
  const dongCode = rankingDongRegionCode(lawdCd, bjdongCd);
  const regionHref = regionRankingHref(regionSlug, {
    dong: dongName,
    regionCode: dongCode,
    fromComplexId: enabled ? id : null,
    section: "ranking",
  });

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
    <LabSection id="section-region-rank" title="지역 내 비교">
      <div>
        <LabSubsectionHeader
          title={ZIPLAB_RANK_TITLE}
          meta={asOf || undefined}
          tip={
            <>
              <p className="font-medium text-slate-800">{ZIPLAB_RANK_TIP_TITLE}</p>
              {ZIPLAB_RANK_TIP.split("\n\n").map((paragraph) => (
                <p key={paragraph} className="mt-1.5 first:mt-1">
                  {paragraph}
                </p>
              ))}
            </>
          }
        />

        {query.isLoading ? (
          <div className="mt-2 space-y-2" aria-label="순위 불러오는 중">
            <div className="h-7 animate-pulse rounded-lg bg-slate-100" />
            <div className="h-7 animate-pulse rounded-lg bg-slate-100" />
          </div>
        ) : query.isError ? (
          <div className="mt-2 rounded-xl bg-slate-50 px-3 py-3 text-center">
            <p className="detail-body font-medium text-[color:var(--lab-navy-950)]">
              순위를 불러오지 못했습니다.
            </p>
            <button
              type="button"
              onClick={() => void query.refetch()}
              className="lab-button lab-button-secondary mt-2 px-4"
            >
              다시 시도
            </button>
          </div>
        ) : (
          <div className="mt-2">
            <div className={RANK_GRID}>
              <span />
              <p className="detail-meta truncate">
                {regionName}
              </p>
              <p className="detail-meta truncate">
                {dongLabel}
              </p>
            </div>
            <div className="detail-after-title detail-rows">
              <RankRow
                label="종합 순위"
                guName={regionName}
                dongName={dongLabel}
                gu={data?.all?.gu}
                dong={data?.all?.dong}
                empty="—"
              />
              {showDecade ? (
                <RankRow
                  label={`${decadeLabel} 순위`}
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

      <div className={`mt-3 ${LAB_SUBSECTION_RULE}`}>
        <Link
          href={regionHref}
          data-event="complex_region_rank_cta"
          className="lab-button lab-button-primary w-full"
        >
          {regionOverviewCtaLabel(regionName)}
          <span aria-hidden className="ml-1">
            →
          </span>
        </Link>
      </div>
    </LabSection>
  );
}

"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { InfoTip } from "@/components/ui/InfoTip";
import {
  fetchRegionRankingBoard,
  formatReferenceMonthCompact,
  rankingComplexHref,
  regionRankingCode,
} from "@/lib/region-ranking/public";
import type { RegionAptSummary } from "@/lib/region/region-summary";
import { RegionPriceTrendChart } from "@/components/region/RegionPriceTrendChart";

export const MARKET_SECTION_SURFACE = "lab-card detail-card";

export function MarketSectionHeader({
  title,
  meta,
  tip,
}: {
  title: string;
  meta?: ReactNode;
  tip?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
      <div className="flex min-w-0 items-center">
        <h2 className="detail-section-title">
          {title}
        </h2>
        {tip ? <InfoTip aria-label={`${title} 안내`}>{tip}</InfoTip> : null}
      </div>
      {meta ? (
        <p className="detail-meta tabular-nums">{meta}</p>
      ) : null}
    </div>
  );
}




export function RegionPriceSection({
  lawdCodes,
  regionName,
}: {
  lawdCodes: string[];
  regionName: string;
}) {
  const lawdCd = regionRankingCode(lawdCodes);
  if (!lawdCd) return null;

  return (
    <section
      aria-label="지역 시세 평당가"
      className={`${MARKET_SECTION_SURFACE} flex flex-col gap-3`}
    >
      <MarketSectionHeader
        title="지역 시세 평당가"
        meta="공급면적 기준"
        tip={
          <p>
            {regionName} 아파트 단지들의 실거래를 바탕으로 집랩이 산출한 지역 시세
            평당가입니다. 공급면적(평형) 기준입니다.
          </p>
        }
      />

      <RegionPriceTrendChart lawdCd={lawdCd} regionName={regionName} />
    </section>
  );
}

function RankCircle({ rank }: { rank: number }) {
  const tone =
    rank === 1
      ? "bg-amber-400 text-white"
      : rank === 2
        ? "bg-slate-400 text-white"
        : rank === 3
          ? "bg-orange-400 text-white"
          : "bg-slate-100 text-slate-600";
  return (
    <span
      className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold tabular-nums ${tone}`}
    >
      {rank}
    </span>
  );
}


const STRENGTH_LABELS = {
  price: "가격",
  liquidity: "거래",
  size: "규모",
  turnover: "회전율",
} as const;

function strengthText(
  p: { price: number; liquidity: number; size: number; turnover: number } | null | undefined,
): string | null {
  if (!p) return null;
  const top = (Object.keys(STRENGTH_LABELS) as Array<keyof typeof STRENGTH_LABELS>)
    .map((k) => ({ k, share: Math.max(1, Math.round((1 - p[k]) * 100)) }))
    .sort((a, b) => a.share - b.share)
    .slice(0, 2);
  return top.map((t) => `${STRENGTH_LABELS[t.k]} 상위 ${t.share}%`).join(" · ");
}

const RANK_PREVIEW = 5;
const RANK_FULL = 20;

export function RegionRankingTable({
  regionSlug,
  regionName,
  lawdCodes,
}: {
  regionSlug: string;
  regionName: string;
  lawdCodes: string[];
}) {
  const regionCode = regionRankingCode(lawdCodes);
  const [expanded, setExpanded] = useState(false);
  const query = useQuery({
    queryKey: ["region-ranking-v3", regionCode, "COMPOSITE", RANK_FULL],
    queryFn: () =>
      fetchRegionRankingBoard({
        regionCode: regionCode!,
        rankingType: "COMPOSITE",
        limit: RANK_FULL,
      }),
    enabled: !!regionCode,
    staleTime: 10 * 60_000,
    retry: 1,
  });
  if (!regionCode) return null;
  const board = query.data;
  const rows = board?.status === "ok" ? board.rows : [];
  const visible = expanded ? rows : rows.slice(0, RANK_PREVIEW);

  return (
    <section
      id="region-ranking"
      aria-label="지역 아파트 랭킹"
      className={`${MARKET_SECTION_SURFACE} flex scroll-mt-28 flex-col gap-3`}
    >
      <MarketSectionHeader
        title="지역 아파트 랭킹"
        meta={formatReferenceMonthCompact(board?.transactionAsOf ?? null)}
        tip={
          <p>
            최근 1년 실거래를 바탕으로 가격 수준, 거래 활발도, 단지 규모 등을
            종합해 매긴 집랩 순위입니다. 거래가 충분한 단지만 포함합니다.
          </p>
        }
      />
      {query.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: RANK_PREVIEW }).map((_, i) => (
            <div key={i} className="h-9 animate-pulse rounded-md bg-slate-100" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <p className="detail-body">순위 정보를 준비 중입니다.</p>
      ) : (
        <>
          <div role="table" aria-label={`${regionName} 아파트 랭킹`}>
            <div
              role="row"
              className="detail-meta grid grid-cols-[2.5rem_minmax(0,1fr)_4.5rem_1rem] items-center gap-x-2 rounded-lg bg-[color:var(--lab-surface-subtle,#F1F5F9)] px-2 py-1.5"
            >
              <span role="columnheader">순위</span>
              <span role="columnheader">단지명</span>
              <span role="columnheader" className="text-center">
                지역
              </span>
              <span aria-hidden />
            </div>
            <ul className="divide-y divide-[color:var(--lab-border)]">
              {visible.map((row) => {
                const href = rankingComplexHref({
                  aptName: row.apt_name,
                  regionSlug,
                  gu: regionName,
                  complexId: row.complex_id,
                });
                const body = (
                  <>
                    <span className="flex justify-center">
                      <RankCircle rank={row.rank} />
                    </span>
                    <span className="min-w-0">
                      <span className="detail-data-value-emphasis block truncate">
                        {row.apt_name ?? "—"}
                      </span>
                      {strengthText(row.percentiles) ? (
                        <span className="detail-meta block truncate">
                          {strengthText(row.percentiles)}
                        </span>
                      ) : null}
                    </span>
                    <span className="detail-meta truncate text-center">
                      {row.dong ?? "—"}
                    </span>
                    <ChevronRight
                      className="h-4 w-4 text-slate-400"
                      aria-hidden
                    />
                  </>
                );
                const cls =
                  "grid min-h-11 grid-cols-[2.5rem_minmax(0,1fr)_4.5rem_1rem] items-center gap-x-2 px-2 py-2.5";
                return (
                  <li key={row.complex_id} role="row">
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
          </div>
          {rows.length > RANK_PREVIEW ? (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              className="lab-button lab-button-secondary w-full"
            >
              {expanded ? "접기" : "전체 순위 보기"}
              <ChevronRight
                className={`h-4 w-4 transition ${expanded ? "-rotate-90" : ""}`}
                aria-hidden
              />
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}

export function RegionAptSummarySection({
  lawdCodes,
  regionName,
}: {
  lawdCodes: string[];
  regionName: string;
}) {
  const lawdCd = regionRankingCode(lawdCodes);
  const query = useQuery({
    queryKey: ["region-summary", lawdCd],
    queryFn: async () => {
      const res = await fetch(`/api/region-summary?lawd_cd=${lawdCd}`);
      if (!res.ok) throw new Error("summary");
      return (await res.json()) as RegionAptSummary;
    },
    enabled: !!lawdCd,
    staleTime: 60 * 60_000,
    retry: 1,
  });
  if (!lawdCd) return null;
  const data = query.data?.status === "ok" ? query.data : null;
  if (query.isError) return null;

  const items: Array<{ label: string; value: ReactNode; note?: string }> = [
    {
      label: "아파트 단지 수",
      value: data ? `${data.complexCount.toLocaleString("ko-KR")}개` : "—",
    },
    {
      label: "총 세대수",
      value:
        data?.householdTotal != null
          ? `${data.householdTotal.toLocaleString("ko-KR")}세대`
          : "—",
      note:
        data && data.householdComplexCount < data.complexCount
          ? `세대수 확인 ${data.householdComplexCount.toLocaleString("ko-KR")}개 단지 기준`
          : undefined,
    },
    {
      label: "평균 연차",
      value:
        data?.averageAgeYears != null ? `${data.averageAgeYears}년차` : "—",
      note: "준공 연도 기준",
    },
    {
      label: "대표 평형",
      value: data?.representativeDecade
        ? `${data.representativeDecade.label} (${data.representativeDecade.sharePct}%)`
        : "—",
      note: data?.representativeDecade ? "세대수 비중 기준" : undefined,
    },
  ];

  return (
    <section
      aria-label={`${regionName} 아파트 요약`}
      className={`${MARKET_SECTION_SURFACE} flex flex-col gap-3`}
    >
      <MarketSectionHeader
        title={`${regionName} 아파트 요약`}
        meta={data ? formatReferenceMonthCompact(data.asOfMonth) : null}
      />
      <div className="grid grid-cols-2 gap-2">
        {items.map((item) => (
          <div
            key={item.label}
            className="min-w-0 rounded-xl border border-[color:var(--lab-border)] px-3 py-3"
          >
            <p className="detail-label">{item.label}</p>
            {query.isLoading ? (
              <div className="mt-2 h-6 w-20 animate-pulse rounded bg-slate-100" />
            ) : (
              <p className="detail-compact-value mt-1 truncate">
                {item.value}
              </p>
            )}
            {item.note ? (
              <p className="detail-meta mt-0.5 truncate">
                {item.note}
              </p>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

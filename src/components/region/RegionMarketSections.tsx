"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { InfoTip } from "@/components/ui/InfoTip";
import { labSecondaryTabClass, labSegmentedClass } from "@/components/ui/lab";
import {
  TREND_PERIOD_TABS,
  fetchRegionRankingBoard,
  formatReferenceMonthCompact,
  formatWonPerPyeong,
  rankingComplexHref,
  regionRankingCode,
} from "@/lib/region-ranking/public";
import type { RegionAptSummary } from "@/lib/region/region-summary";

export const MARKET_SECTION_SURFACE = "lab-card px-3.5 py-4 sm:px-5 sm:py-5";

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
        <h2 className="text-[17px] font-semibold tracking-tight text-slate-900 sm:text-lg">
          {title}
        </h2>
        {tip ? <InfoTip aria-label={`${title} 안내`}>{tip}</InfoTip> : null}
      </div>
      {meta ? (
        <p className="text-[12px] leading-4 tabular-nums text-slate-500">{meta}</p>
      ) : null}
    </div>
  );
}

export function changeArrowText(pct: number | null | undefined): string {
  if (pct == null || !Number.isFinite(pct)) return "—";
  const abs = Math.abs(pct).toFixed(2);
  if (pct > 0) return `▲ ${abs}%`;
  if (pct < 0) return `▼ ${abs}%`;
  return `${abs}%`;
}

export function changeToneClass(pct: number | null | undefined): string {
  if (pct == null || !Number.isFinite(pct) || pct === 0) return "text-slate-500";
  return pct > 0 ? "text-rose-600" : "text-blue-600";
}

function changeSrText(pct: number | null | undefined): string {
  if (pct == null || !Number.isFinite(pct) || pct === 0) return "";
  return pct > 0 ? " 상승" : " 하락";
}

const PRICE_BANDS = [
  { id: "20", label: "20평대" },
  { id: "30", label: "30평대" },
  { id: "40", label: "40평대" },
  { id: "50", label: "50평대" },
] as const;
type PriceBand = (typeof PRICE_BANDS)[number]["id"];

type RegionPriceResponse =
  | { status: "unavailable"; reason?: string }
  | {
      status: "ok";
      supplyPyeongCohort: string | null;
      price: { meanPricePerSupplyPyeong: number | null; status: string };
      trends: Array<{
        period: "6M" | "1Y" | "2Y" | "5Y";
        changePercent: number | null;
        status: string;
      }>;
    };

async function fetchRegionPrice(
  regionCode: string,
  band: string,
): Promise<RegionPriceResponse> {
  const qs = new URLSearchParams({ region_code: regionCode, area_band: band });
  const res = await fetch(`/api/region-price-position?${qs.toString()}`);
  if (!res.ok) return { status: "unavailable", reason: "http" };
  return (await res.json()) as RegionPriceResponse;
}

export function RegionRepPriceSection({
  lawdCodes,
  regionName,
  monthTradeCount,
}: {
  lawdCodes: string[];
  regionName: string;
  monthTradeCount: number | null;
}) {
  const regionCode = regionRankingCode(lawdCodes);
  const [band, setBand] = useState<PriceBand>("30");
  const query = useQuery({
    queryKey: ["region-price-position", regionCode, band],
    queryFn: () => fetchRegionPrice(regionCode!, band),
    enabled: !!regionCode,
    staleTime: 10 * 60_000,
    retry: 1,
  });
  if (!regionCode) return null;
  const data = query.data?.status === "ok" ? query.data : null;
  const priceText = formatWonPerPyeong(data?.price.meanPricePerSupplyPyeong);
  const bandLabel = PRICE_BANDS.find((b) => b.id === band)?.label ?? "";

  return (
    <section
      aria-label="지역 대표 평당가"
      className={`${MARKET_SECTION_SURFACE} flex flex-col gap-3`}
    >
      <MarketSectionHeader
        title="지역 대표 평당가"
        meta={`최근 실거래 기준 · ${bandLabel}`}
        tip={
          <p>
            같은 지역·평형대 단지들의 최근 실거래를 바탕으로 계산한 대표
            평당가입니다.
          </p>
        }
      />
      <div
        className={`${labSegmentedClass()} grid w-full grid-cols-4`}
        role="tablist"
        aria-label="평형대"
      >
        {PRICE_BANDS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={band === item.id}
            onClick={() => setBand(item.id)}
            className={labSecondaryTabClass(
              band === item.id,
              "min-h-9 px-1 text-[13px]",
            )}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="min-w-0 rounded-lg bg-teal-50/70 px-3 py-3">
          <p className="text-[12px] leading-4 text-slate-600">
            {regionName} 대표 평당가
          </p>
          {query.isLoading ? (
            <div className="mt-2 h-7 w-28 animate-pulse rounded bg-teal-100/70" />
          ) : (
            <p className="mt-1.5 whitespace-nowrap text-[19px] font-bold leading-none tabular-nums text-teal-800 sm:text-2xl">
              {priceText ?? "—"}
            </p>
          )}
        </div>
        <div className="min-w-0 rounded-lg border border-slate-200 px-3 py-3">
          <p className="text-[12px] leading-4 text-slate-600">
            {regionName} 거래량
          </p>
          <p className="mt-1.5 whitespace-nowrap leading-none">
            <span className="text-[19px] font-bold tabular-nums text-slate-900 sm:text-2xl">
              {monthTradeCount != null
                ? `${monthTradeCount.toLocaleString("ko-KR")}건`
                : "—"}
            </span>
            <span className="ml-1 text-[12px] text-slate-500">(이번 달)</span>
          </p>
        </div>
      </div>

      {!query.isLoading && !priceText ? (
        <p className="text-sm text-slate-500">
          {bandLabel} 대표 평당가를 계산할 거래가 부족합니다.
        </p>
      ) : (
        <div className="grid grid-cols-4 gap-1.5 sm:gap-2">
          {TREND_PERIOD_TABS.map((tab) => {
            const hit = data?.trends.find((t) => t.period === tab.id);
            const pct = hit?.status === "ok" ? hit.changePercent : null;
            return (
              <div
                key={tab.id}
                className="min-w-0 rounded-lg border border-slate-200 px-2 py-2.5 sm:px-3"
              >
                <p className="text-[11px] leading-4 text-slate-500">
                  {tab.label}
                </p>
                <p
                  className={`mt-1 whitespace-nowrap text-[13px] font-semibold tabular-nums sm:text-[15px] ${changeToneClass(pct)}`}
                >
                  {query.isLoading ? "…" : changeArrowText(pct)}
                  <span className="sr-only">{changeSrText(pct)}</span>
                </p>
              </div>
            );
          })}
        </div>
      )}
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
      aria-label="이 지역 아파트 랭킹"
      className={`${MARKET_SECTION_SURFACE} flex scroll-mt-28 flex-col gap-3`}
    >
      <MarketSectionHeader
        title="이 지역 아파트 랭킹"
        meta={formatReferenceMonthCompact(board?.transactionAsOf ?? null)}
        tip={
          <p>
            최근 12개월 실거래의 가격 수준과 거래 활발도를 함께 반영한 집랩
            종합 순위입니다.
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
        <p className="text-sm text-slate-500">순위 정보를 준비 중입니다.</p>
      ) : (
        <>
          <div role="table" aria-label={`${regionName} 아파트 랭킹`}>
            <div
              role="row"
              className="grid grid-cols-[2.5rem_minmax(0,1fr)_4.5rem_1rem] items-center gap-x-2 rounded-md bg-slate-50 px-2 py-1.5 text-[11px] font-medium text-slate-500"
            >
              <span role="columnheader">순위</span>
              <span role="columnheader">단지명</span>
              <span role="columnheader" className="text-center">
                지역
              </span>
              <span aria-hidden />
            </div>
            <ul className="divide-y divide-slate-100">
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
                    <span className="truncate text-[14px] font-semibold text-slate-900">
                      {row.apt_name ?? "—"}
                    </span>
                    <span className="truncate text-center text-[12px] text-slate-500">
                      {row.dong ?? "—"}
                    </span>
                    <ChevronRight
                      className="h-4 w-4 text-slate-400"
                      aria-hidden
                    />
                  </>
                );
                const cls =
                  "grid min-h-11 grid-cols-[2.5rem_minmax(0,1fr)_4.5rem_1rem] items-center gap-x-2 px-2 py-1.5";
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
              className="inline-flex min-h-10 w-full items-center justify-center gap-1 rounded-lg bg-teal-50 text-[14px] font-medium text-teal-800 hover:bg-teal-100/70"
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
      label: "평균",
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
            className="min-w-0 rounded-lg border border-slate-200 px-3 py-3"
          >
            <p className="text-[12px] leading-4 text-slate-500">{item.label}</p>
            {query.isLoading ? (
              <div className="mt-2 h-6 w-20 animate-pulse rounded bg-slate-100" />
            ) : (
              <p className="mt-1 truncate text-[17px] font-bold tabular-nums text-slate-900 sm:text-lg">
                {item.value}
              </p>
            )}
            {item.note ? (
              <p className="mt-0.5 truncate text-[11px] text-slate-400">
                {item.note}
              </p>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { InfoTip } from "@/components/ui/InfoTip";
import { LabTabs } from "@/components/ui/LabTabs";
import {
  fetchRegionRankingBoard,
  formatReferenceMonthCompact,
  rankingComplexHref,
  regionRankingCode,
} from "@/lib/region-ranking/public";
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

export const LIST_PREVIEW = 5;

export function ListMoreButton({
  expanded,
  onToggle,
  label = "더보기",
}: {
  expanded: boolean;
  onToggle: () => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      className="lab-button lab-button-secondary w-full"
    >
      {expanded ? "접기" : label}
      <ChevronRight
        className={`h-4 w-4 transition ${expanded ? "-rotate-90" : "rotate-90"}`}
        aria-hidden
      />
    </button>
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

function strengthTags(
  p: { price: number; liquidity: number; size: number; turnover: number } | null | undefined,
): string[] {
  if (!p) return [];
  return (Object.keys(STRENGTH_LABELS) as Array<keyof typeof STRENGTH_LABELS>)
    .map((k) => ({ k, share: Math.max(1, Math.round((1 - p[k]) * 100)) }))
    .sort((a, b) => a.share - b.share)
    .slice(0, 2)
    .map((t) => `${STRENGTH_LABELS[t.k]} 상위 ${t.share}%`);
}

const RANK_PREVIEW = LIST_PREVIEW;
const RANK_FULL = 20;

const RANK_TABS = [
  { id: "COMPOSITE", label: "종합" },
  { id: "TRADES_12M", label: "거래량" },
  { id: "PRICE_12M", label: "평당가" },
] as const;
type RankTabId = (typeof RANK_TABS)[number]["id"];

const RANK_TIPS: Record<RankTabId, string> = {
  COMPOSITE:
    "최근 1년 실거래를 바탕으로 가격 수준, 거래 활발도, 단지 규모 등을 종합해 매긴 집랩 순위입니다. 거래가 충분한 단지만 포함합니다.",
  TRADES_12M:
    "최근 1년 동안 매매 실거래가 많았던 단지 순서입니다. 거래가 충분한 단지만 포함합니다.",
  PRICE_12M:
    "최근 1년 매매 실거래의 평당가(공급면적 기준)가 높은 단지 순서입니다. 거래가 충분한 단지만 포함합니다.",
};

function numberOf(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

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
  const [tab, setTab] = useState<RankTabId>("COMPOSITE");
  const metricTab = tab !== "COMPOSITE";
  const query = useQuery({
    queryKey: ["region-ranking-v4", regionCode, tab, RANK_FULL],
    queryFn: () =>
      fetchRegionRankingBoard({
        regionCode: regionCode!,
        rankingType: tab,
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
  const gridCols = metricTab
    ? "grid-cols-[2.5rem_minmax(0,1fr)_5rem_1rem]"
    : "grid-cols-[2.5rem_minmax(0,1fr)_1rem]";

  return (
    <section
      id="region-ranking"
      aria-label="지역 아파트 랭킹"
      className={`${MARKET_SECTION_SURFACE} flex scroll-mt-28 flex-col gap-3`}
    >
      <MarketSectionHeader
        title="지역 아파트 랭킹"
        meta={formatReferenceMonthCompact(board?.transactionAsOf ?? null)}
        tip={<p>{RANK_TIPS[tab]}</p>}
      />
      <LabTabs
        variant="secondary"
        ariaLabel="지역 아파트 랭킹 기준"
        items={RANK_TABS}
        value={tab}
        onChange={(next) => {
          setTab(next);
          setExpanded(false);
        }}
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
              className={`detail-meta grid ${gridCols} items-center gap-x-2 rounded-lg bg-[color:var(--lab-surface-subtle,#F1F5F9)] px-2 py-1.5`}
            >
              <span role="columnheader">순위</span>
              <span role="columnheader">단지명</span>
              {metricTab ? (
                <span role="columnheader" className="text-right">
                  {tab === "TRADES_12M" ? "1년 거래" : "만원/평"}
                </span>
              ) : null}
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
                      {metricTab ? (
                        <>
                          <span className="detail-data-value-emphasis block truncate">
                            {row.apt_name ?? "—"}
                          </span>
                          {row.dong ? (
                            <span className="detail-meta block truncate">{row.dong}</span>
                          ) : null}
                        </>
                      ) : (
                        <>
                          <span className="flex min-w-0 items-baseline gap-1.5">
                            <span className="detail-data-value-emphasis min-w-0 truncate">
                              {row.apt_name ?? "—"}
                            </span>
                            {row.dong ? (
                              <span className="detail-meta shrink-0 whitespace-nowrap">
                                {row.dong}
                              </span>
                            ) : null}
                          </span>
                          {strengthTags(row.percentiles).length ? (
                            <span className="mt-1 flex flex-wrap gap-1">
                              {strengthTags(row.percentiles).map((tag) => (
                                <span
                                  key={tag}
                                  className="whitespace-nowrap rounded border border-[color:var(--lab-border)] px-1.5 text-[12px] font-medium leading-5 text-[color:var(--lab-body)] tabular-nums"
                                >
                                  {tag}
                                </span>
                              ))}
                            </span>
                          ) : null}
                        </>
                      )}
                    </span>
                    {metricTab ? (
                      <span className="detail-data-value-emphasis whitespace-nowrap text-right tabular-nums">
                        {tab === "TRADES_12M"
                          ? `${(numberOf(row.public_metrics?.trade_count) ?? 0).toLocaleString("ko-KR")}건`
                          : numberOf(row.public_metrics?.median_price_per_sqm) != null
                            ? Math.round(numberOf(row.public_metrics?.median_price_per_sqm)!).toLocaleString("ko-KR")
                            : "—"}
                      </span>
                    ) : null}
                    <ChevronRight
                      className="h-4 w-4 text-slate-400"
                      aria-hidden
                    />
                  </>
                );
                const cls = `grid min-h-11 ${gridCols} items-center gap-x-2 px-2 py-2.5`;
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
            <ListMoreButton
              expanded={expanded}
              onToggle={() => setExpanded((v) => !v)}
              label={`${rows.length - RANK_PREVIEW}곳 더보기`}
            />
          ) : null}
        </>
      )}
    </section>
  );
}

"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { LabTabs } from "@/components/ui/LabTabs";
import { LAB_LIST_PREVIEW, LabMoreButton } from "@/components/ui/LabMoreButton";
import { LAB_SECTION_SURFACE, LabSectionHeader } from "@/components/ui/LabSection";
import { LabTag } from "@/components/ui/LabTag";
import {
  fetchRegionRankingBoard,
  formatReferenceMonthCompact,
  rankingComplexHref,
} from "@/lib/region-ranking/public";
import { RegionPriceTrendChart } from "@/components/region/RegionPriceTrendChart";
import type { RegionScope } from "@/lib/region/region-scope";

/** 시세 평당가 섹션. `scope.dong`이 있으면 그 법정동 시세(제목 "동 시세 평당가"). */
export function RegionPriceSection({
  scope,
  regionName,
}: {
  scope: RegionScope;
  /** 화면 표기 지역명 (구 이름, 동 페이지는 동 이름). */
  regionName: string;
}) {
  const title = scope.dong ? "동 시세 평당가" : "지역 시세 평당가";
  return (
    <section
      id="market-price"
      aria-label={title}
      className={`${LAB_SECTION_SURFACE} flex flex-col gap-3`}
    >
      <LabSectionHeader
        title={title}
        meta="공급면적 기준"
        tip={
          <p>
            {regionName} 아파트 단지들의 실거래를 바탕으로 집랩이 산출한 {scope.dong ? "동" : "지역"} 시세
            평당가입니다. 공급면적(평형) 기준입니다.
          </p>
        }
      />

      <RegionPriceTrendChart scope={scope} regionName={regionName} />
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

const RANK_PREVIEW = LAB_LIST_PREVIEW;
const RANK_FULL = 10; // 랭킹 공통: 최대 10개, 처음 5개 + 더보기

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
  regionCode,
  title = "지역 아파트 랭킹",
  label,
  emptyText = "순위 정보를 준비 중입니다.",
}: {
  regionSlug: string;
  /** 구 이름 — 단지 상세 링크의 gu 파라미터. */
  regionName: string;
  /** 5자리 구 코드 또는 10자리 법정동 코드. */
  regionCode: string | null;
  title?: string;
  /** 접근성 이름에 쓰는 지역 표기 (기본 regionName). */
  label?: string;
  /** 순위 행이 없을 때 문구. */
  emptyText?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState<RankTabId>("COMPOSITE");
  const metricTab = tab !== "COMPOSITE";
  // 동 순위(10자리 코드)는 모든 단지가 같은 동이라 동 이름을 붙이지 않는다.
  const showDong = regionCode?.length !== 10;
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
    ? "grid-cols-[2.5rem_minmax(0,1fr)_auto_1rem]"
    : "grid-cols-[2.5rem_minmax(0,1fr)_1rem]";

  return (
    <section
      id="region-ranking"
      aria-label={title}
      className={`${LAB_SECTION_SURFACE} flex scroll-mt-28 flex-col gap-3`}
    >
      <LabSectionHeader
        title={title}
        meta={formatReferenceMonthCompact(board?.transactionAsOf ?? null)}
        tip={<p>{RANK_TIPS[tab]}</p>}
      />
      <LabTabs
        variant="secondary"
        ariaLabel={`${title} 기준`}
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
        <p className="detail-body">{emptyText}</p>
      ) : (
        <>
          {/* 머리글 줄 없음 — 값 옆에 단위를 직접 붙인다. */}
          <div aria-label={`${label ?? regionName} 아파트 랭킹`}>
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
                          {showDong && row.dong ? (
                            <span className="detail-meta block truncate">{row.dong}</span>
                          ) : null}
                        </>
                      ) : (
                        <>
                          <span className="flex min-w-0 items-baseline gap-1.5">
                            <span className="detail-data-value-emphasis min-w-0 truncate">
                              {row.apt_name ?? "—"}
                            </span>
                            {showDong && row.dong ? (
                              <span className="detail-meta shrink-0 whitespace-nowrap">
                                {row.dong}
                              </span>
                            ) : null}
                          </span>
                          {strengthTags(row.percentiles).length ? (
                            <span className="mt-1 flex flex-wrap gap-1">
                              {strengthTags(row.percentiles).map((tag) => (
                                <LabTag key={tag}>{tag}</LabTag>
                              ))}
                            </span>
                          ) : null}
                        </>
                      )}
                    </span>
                    {metricTab ? (
                      <span className="whitespace-nowrap text-right tabular-nums">
                        {tab === "TRADES_12M" ? (
                          <span className="detail-data-value-emphasis">
                            {(numberOf(row.public_metrics?.trade_count) ?? 0).toLocaleString("ko-KR")}건
                          </span>
                        ) : numberOf(row.public_metrics?.median_price_per_sqm) != null ? (
                          <>
                            <span className="detail-data-value-emphasis">
                              {Math.round(numberOf(row.public_metrics?.median_price_per_sqm)!).toLocaleString("ko-KR")}
                            </span>
                            <span className="detail-meta ml-0.5">만원/평</span>
                          </>
                        ) : (
                          <span className="detail-meta">—</span>
                        )}
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
                  <li key={row.complex_id}>
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
            <LabMoreButton
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

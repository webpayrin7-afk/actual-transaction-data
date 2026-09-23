"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { InfoTip } from "@/components/ui/InfoTip";
import {
  MARKET_SECTION_SURFACE,
  MarketSectionHeader,
} from "@/components/region/RegionMarketSections";
import { aptDetailHref } from "@/lib/molit/apt-client";
import { seoulToday } from "@/lib/market/time";
import type {
  RegionHighlightDeal,
  RegionMarketDetail,
} from "@/lib/region/region-market-detail";
import type { NearbySalesResult } from "@/lib/complex-detail/applyhome-nearby-sales";
import { formatEok, formatSqmApproxPyeong } from "@/lib/utils/format";

export function useRegionMarketDetail(lawdCd: string | null) {
  return useQuery({
    queryKey: ["region-market-detail", lawdCd],
    queryFn: async () => {
      const res = await fetch(`/api/region-market-detail?lawd_cd=${lawdCd}`);
      if (!res.ok) throw new Error("detail");
      return (await res.json()) as RegionMarketDetail;
    },
    enabled: !!lawdCd,
    staleTime: 30 * 60_000,
    retry: 1,
  });
}

function shortDate(day: string): string {
  return `${day.slice(2, 4)}.${day.slice(5, 7)}.${day.slice(8, 10)}`;
}

function signedEok(n: number): string {
  return `${n > 0 ? "+" : "−"}${formatEok(Math.abs(n))}`;
}

function HighlightRow({
  deal,
  regionSlug,
  guName,
  value,
  valueClass,
  caption,
}: {
  deal: RegionHighlightDeal;
  regionSlug: string;
  guName: string;
  value: string;
  valueClass: string;
  caption: string;
}) {
  const meta = [
    deal.dong,
    formatSqmApproxPyeong(deal.exclusiveArea),
    deal.floor != null ? `${deal.floor}층` : null,
    shortDate(deal.dealDate),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <li>
      <Link
        href={aptDetailHref(deal.aptName, regionSlug, guName)}
        className="flex min-h-[64px] items-center justify-between gap-3 py-3"
      >
        <div className="min-w-0 flex-1">
          <p className="detail-list-title truncate">{deal.aptName}</p>
          <p className="detail-meta truncate">{meta}</p>
        </div>
        <div className="shrink-0 text-right">
          <p className={`detail-data-value-emphasis whitespace-nowrap ${valueClass}`}>{value}</p>
          <p className="detail-meta whitespace-nowrap">{caption}</p>
        </div>
        <ChevronRight className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
      </Link>
    </li>
  );
}

export function RegionTradeHighlightsSection({
  lawdCd,
  regionSlug,
  regionName,
}: {
  lawdCd: string;
  regionSlug: string;
  regionName: string;
}) {
  const query = useRegionMarketDetail(lawdCd);
  if (query.isError) return null;
  const h = query.data?.highlights;
  const rows = h
    ? [
        h.topAmount && {
          key: "top",
          deal: h.topAmount,
          value: formatEok(h.topAmount.dealAmount),
          valueClass: "",
          caption: "가장 큰 금액으로 거래",
        },
        h.biggestRise && {
          key: "rise",
          deal: h.biggestRise,
          value: signedEok(h.biggestRise.diff ?? 0),
          valueClass: "detail-change-up",
          caption: "가장 큰 폭으로 상승",
        },
        h.biggestDrop && {
          key: "drop",
          deal: h.biggestDrop,
          value: signedEok(h.biggestDrop.diff ?? 0),
          valueClass: "detail-change-down",
          caption: "가장 큰 폭으로 하락",
        },
      ].filter((r): r is NonNullable<typeof r> => Boolean(r))
    : [];

  return (
    <section
      aria-label={`${regionName} 거래 동향`}
      className={`${MARKET_SECTION_SURFACE} flex flex-col gap-3`}
    >
      <MarketSectionHeader
        title="거래 동향"
        meta="계약일 기준"
        tip={
          <p>
            실거래는 계약 후 30일 안에 신고되므로 최근 한 달 거래는 아직 모두
            집계되지 않았을 수 있습니다.
          </p>
        }
      />
      <RegionTradeSignals lawdCd={lawdCd} />
      <div className="detail-subsection-rule flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="flex min-w-0 items-center">
          <h3 className="detail-subsection-title">주목할 거래</h3>
          <InfoTip aria-label="주목할 거래 안내">
            <p>
              최근 30일 동안 계약된 매매 실거래 중 거래금액이 가장 큰 거래와, 같은
              단지·면적의 직전 거래 대비 가장 크게 오르거나 내린 거래입니다.
            </p>
          </InfoTip>
        </div>
        <p className="detail-meta">최근 1개월</p>
      </div>
      {query.isLoading ? (
        <div className="h-40 animate-pulse rounded-lg bg-slate-100" />
      ) : rows.length === 0 ? (
        <p className="detail-body">최근 1개월 매매 거래가 없습니다.</p>
      ) : (
        <ul className="divide-y divide-[color:var(--lab-border)]">
          {rows.map((r) => (
            <HighlightRow
              key={r.key}
              deal={r.deal}
              regionSlug={regionSlug}
              guName={regionName}
              value={r.value}
              valueClass={r.valueClass}
              caption={r.caption}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function RegionTradeSignals({ lawdCd }: { lawdCd: string }) {
  const query = useRegionMarketDetail(lawdCd);
  if (query.isError) return null;
  const a = query.data?.analysis;
  const tiles = [
    { key: "high", label: "신고가", value: a?.recordHighCount, cls: "detail-change-up" },
    { key: "peak", label: "최고가 대비 10%↓", value: a?.belowPeakCount, cls: "detail-change-down" },
    { key: "down", label: "직전보다 내림", value: a?.downCount, cls: "detail-change-down" },
  ];
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="flex min-w-0 items-center">
          <h3 className="detail-subsection-title">최근 3개월 거래 신호</h3>
          <InfoTip aria-label="최근 3개월 거래 신호 안내">
            <p>같은 단지·면적의 이전 거래와 비교합니다.</p>
            <p className="mt-1.5">신고가: 종전 최고가를 넘은 거래</p>
            <p>최고가 대비 10%↓: 종전 최고가보다 10% 이상 낮은 거래</p>
            <p>직전보다 내림: 바로 전 거래보다 낮은 거래</p>
          </InfoTip>
        </div>
        {a ? (
          <p className="detail-meta tabular-nums">
            매매 {a.tradeCount.toLocaleString("ko-KR")}건 중
          </p>
        ) : null}
      </div>
      <dl className="mt-2 divide-y divide-[color:var(--lab-border)]">
        {tiles.map((t) => {
          const share =
            a && a.tradeCount > 0 && t.value != null
              ? Math.round((t.value / a.tradeCount) * 100)
              : null;
          return (
            <div key={t.key} className="flex items-baseline justify-between gap-3 py-2.5">
              <dt className="detail-label">{t.label}</dt>
              <dd>
                {query.isLoading ? (
                  <span className="inline-block h-5 w-14 animate-pulse rounded bg-slate-100 align-middle" />
                ) : (
                  <span className={`detail-data-value-emphasis ${t.cls}`}>
                    {t.value != null ? `${t.value.toLocaleString("ko-KR")}건` : "—"}
                    {share != null ? (
                      <span className="detail-meta ml-1.5">{share}%</span>
                    ) : null}
                  </span>
                )}
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

const SUPPLY_HORIZON_YEARS = 6;

export function RegionSupplyTimelineSection({ regionName }: { regionName: string }) {
  const query = useQuery({
    queryKey: ["region-nearby-sales", regionName],
    queryFn: async () => {
      const res = await fetch(
        `/api/complex-nearby-sales?sigungu=${encodeURIComponent(regionName)}`,
      );
      if (!res.ok) throw new Error("supply");
      return (await res.json()) as NearbySalesResult;
    },
    staleTime: 60 * 60_000,
    retry: 1,
  });
  const currentYm = seoulToday().slice(0, 7).replace("-", "");
  const lastYear = Number(currentYm.slice(0, 4)) + SUPPLY_HORIZON_YEARS - 1;
  const items = (query.data?.items ?? [])
    .filter(
      (it) =>
        it.moveInYm &&
        it.moveInYm >= currentYm &&
        Number(it.moveInYm.slice(0, 4)) <= lastYear,
    )
    .sort((a, b) => (a.moveInYm ?? "").localeCompare(b.moveInYm ?? ""));
  const groups = [...new Set(items.map((it) => it.moveInYm!.slice(0, 4)))].map((year) => ({
    year,
    list: items.filter((it) => it.moveInYm!.startsWith(year)),
  }));
  const aptUnits = items
    .filter((it) => it.housingCategory === "apartment")
    .reduce((s, it) => s + (it.supplyCount ?? 0), 0);
  const officetelUnits = items
    .filter((it) => it.housingCategory === "officetel")
    .reduce((s, it) => s + (it.supplyCount ?? 0), 0);
  const failed = query.isError || query.data?.status === "ERROR";
  const summary = [
    aptUnits > 0 ? `아파트 ${aptUnits.toLocaleString("ko-KR")}세대` : null,
    officetelUnits > 0 ? `오피스텔 ${officetelUnits.toLocaleString("ko-KR")}실` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <section
      aria-label={`${regionName} 입주 예정`}
      className={`${MARKET_SECTION_SURFACE} flex flex-col gap-3`}
    >
      <MarketSectionHeader
        title="입주 예정"
        meta={`${regionName} 기준`}
        tip={<p>같은 시·군·구의 청약·입주 예정 공급 정보를 보여드려요.</p>}
      />
      {query.isLoading ? (
        <div className="h-32 animate-pulse rounded-lg bg-slate-100" />
      ) : failed ? (
        <p className="detail-body">주변 공급 정보를 불러오지 못했습니다.</p>
      ) : items.length === 0 ? (
        <p className="detail-body">
          앞으로 {SUPPLY_HORIZON_YEARS}년 안에 입주 예정으로 확인된 공급이 없습니다.
        </p>
      ) : (
        <>
          <dl className="divide-y divide-[color:var(--lab-border)]">
            <div className="flex items-baseline justify-between gap-3 py-2.5">
              <dt className="detail-label">앞으로 {SUPPLY_HORIZON_YEARS}년</dt>
              <dd className="detail-data-value-emphasis text-right">
                {items.length.toLocaleString("ko-KR")}곳
                {summary ? <span className="detail-meta ml-1.5">{summary}</span> : null}
              </dd>
            </div>
          </dl>
          <div className="flex flex-col gap-4">
            {groups.map((g) => (
              <div key={g.year} className="flex flex-col gap-2">
                <p className="detail-label text-[color:var(--lab-body)]">{g.year}년 입주</p>
                <ul className="flex flex-col gap-2">
                  {g.list.map((it) => {
                    const body = (
                      <>
                        <div className="min-w-0 flex-1">
                          <p className="detail-list-title break-keep">{it.houseName}</p>
                          <p className="detail-meta">
                            {[
                              it.housingCategory === "officetel" ? "오피스텔" : "아파트",
                              it.supplyCountLabel,
                              it.statusLabel,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </p>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="detail-data-value whitespace-nowrap">{it.moveInLabel}</p>
                          {it.pblancUrl ? (
                            <p className="detail-meta inline-flex items-center gap-0.5 text-[color:var(--lab-brand-primary)]">
                              공고 보기
                              <ChevronRight className="h-3.5 w-3.5" aria-hidden />
                            </p>
                          ) : null}
                        </div>
                      </>
                    );
                    const cls =
                      "flex items-start justify-between gap-3 rounded-xl border border-[color:var(--lab-border)] px-4 py-3";
                    return (
                      <li key={it.id}>
                        {it.pblancUrl ? (
                          <a
                            href={it.pblancUrl}
                            target="_blank"
                            rel="noreferrer"
                            className={`${cls} transition hover:border-[color:var(--lab-brand-primary)]`}
                          >
                            {body}
                          </a>
                        ) : (
                          <div className={cls}>{body}</div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
          {query.data?.attribution ? (
            <p className="detail-source">{query.data.attribution}</p>
          ) : null}
        </>
      )}
    </section>
  );
}

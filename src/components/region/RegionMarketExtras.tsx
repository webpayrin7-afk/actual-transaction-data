"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
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
      aria-label={`${regionName} 주목할 거래`}
      className={`${MARKET_SECTION_SURFACE} flex flex-col gap-2`}
    >
      <MarketSectionHeader
        title="주목할 거래"
        meta="계약일 기준 · 최근 1개월"
        tip={
          <p>
            최근 30일 동안 계약된 매매 실거래 중 거래금액이 가장 큰 거래와, 같은
            단지·면적의 직전 거래 대비 가장 크게 오르거나 내린 거래입니다.
          </p>
        }
      />
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

export function RegionAnalysisSection({
  lawdCd,
  regionName,
}: {
  lawdCd: string;
  regionName: string;
}) {
  const query = useRegionMarketDetail(lawdCd);
  if (query.isError) return null;
  const a = query.data?.analysis;
  const tiles = [
    { key: "high", label: "신고가", value: a?.recordHighCount, cls: "detail-change-up" },
    { key: "peak", label: "최고가 대비 10%↓", value: a?.belowPeakCount, cls: "detail-change-down" },
    { key: "down", label: "직전 대비 하락", value: a?.downCount, cls: "detail-change-down" },
  ];
  return (
    <section
      aria-label={`${regionName} 지역 분석`}
      className={`${MARKET_SECTION_SURFACE} flex flex-col gap-3`}
    >
      <MarketSectionHeader
        title="지역 분석"
        meta="계약일 기준 · 최근 3개월"
        tip={
          <>
            <p>같은 단지·동·전용면적 거래를 기준으로 셉니다.</p>
            <p className="mt-1.5">신고가: 종전 최고가를 넘은 거래</p>
            <p>최고가 대비 10%↓: 종전 최고가보다 10% 이상 낮은 거래</p>
            <p>직전 대비 하락: 바로 전 거래보다 낮은 거래</p>
          </>
        }
      />
      <div className="grid grid-cols-3 gap-2">
        {tiles.map((t) => (
          <div
            key={t.key}
            className="min-w-0 rounded-xl border border-[color:var(--lab-border)] px-2 py-3 text-center"
          >
            <p className="detail-label whitespace-nowrap">{t.label}</p>
            {query.isLoading ? (
              <div className="mx-auto mt-1.5 h-6 w-12 animate-pulse rounded bg-slate-100" />
            ) : (
              <p className={`detail-compact-value mt-1 ${t.cls}`}>
                {t.value != null ? `${t.value.toLocaleString("ko-KR")}건` : "—"}
              </p>
            )}
          </div>
        ))}
      </div>
      {a ? (
        <p className="detail-meta">
          최근 3개월 매매 {a.tradeCount.toLocaleString("ko-KR")}건 중
        </p>
      ) : null}
    </section>
  );
}

const SUPPLY_YEARS = 3;

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
  const currentYear = Number(currentYm.slice(0, 4));
  const items = (query.data?.items ?? [])
    .filter((it) => it.moveInYm && it.moveInYm >= currentYm)
    .sort((a, b) => (a.moveInYm ?? "").localeCompare(b.moveInYm ?? ""));
  const lastYear = Math.max(
    currentYear + SUPPLY_YEARS - 1,
    ...items.map((it) => Number(it.moveInYm!.slice(0, 4))),
  );
  const years = Array.from(
    { length: Math.min(6, lastYear - currentYear + 1) },
    (_, i) => currentYear + i,
  );
  const byYear = years.map((year) => {
    const list = items.filter((it) => Number(it.moveInYm!.slice(0, 4)) === year);
    return {
      year,
      units: list.reduce((s, it) => s + (it.supplyCount ?? 0), 0),
      count: list.length,
    };
  });
  const maxUnits = Math.max(1, ...byYear.map((y) => y.units));
  const failed = query.isError || query.data?.status === "ERROR";

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
        <div className="h-40 animate-pulse rounded-lg bg-slate-100" />
      ) : failed ? (
        <p className="detail-body">주변 공급 정보를 불러오지 못했습니다.</p>
      ) : (
        <>
          <div
            className="grid items-end gap-2"
            style={{ gridTemplateColumns: `repeat(${byYear.length}, minmax(0, 1fr))` }}
          >
            {byYear.map((y) => (
              <div key={y.year} className="flex min-w-0 flex-col items-center gap-1">
                <p className="detail-data-value-emphasis whitespace-nowrap">
                  {y.units.toLocaleString("ko-KR")}
                </p>
                <div className="flex h-24 w-full max-w-[3.5rem] items-end">
                  <div
                    className="w-full rounded-t-md"
                    style={{
                      height: `${y.units > 0 ? Math.max(6, (y.units / maxUnits) * 100) : 2}%`,
                      background: y.units > 0 ? "#0F766E" : "#E2E8F0",
                    }}
                    aria-hidden
                  />
                </div>
                <p className="detail-meta whitespace-nowrap">{y.year}년</p>
                <p className="detail-meta whitespace-nowrap">{y.count}곳</p>
              </div>
            ))}
          </div>
          <p className="detail-meta">세대·실 수 합계 (아파트 세대, 오피스텔 실)</p>
          {items.length === 0 ? (
            <p className="detail-body">
              현재 {regionName}에 확인된 입주 예정 주택이 없습니다.
            </p>
          ) : (
            <ul className="divide-y divide-[color:var(--lab-border)] border-t border-[color:var(--lab-border)]">
              {items.map((it) => (
                <li key={it.id} className="flex items-start justify-between gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="detail-list-title break-keep">{it.houseName}</p>
                    <p className="detail-meta">
                      {[
                        it.housingCategory === "officetel" ? "오피스텔" : "아파트",
                        it.statusLabel,
                        it.supplyCountLabel,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  </div>
                  <p className="detail-data-value shrink-0 whitespace-nowrap">
                    {it.moveInLabel} 입주
                  </p>
                </li>
              ))}
            </ul>
          )}
          {query.data?.attribution ? (
            <p className="detail-source">{query.data.attribution}</p>
          ) : null}
        </>
      )}
    </section>
  );
}

"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { InfoTip } from "@/components/ui/InfoTip";
import { SaleRow } from "@/components/apt/ComplexNearbySalesSection";
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

type HighlightTone = "top" | "rise" | "drop";

const HIGHLIGHT_TONE: Record<HighlightTone, { chip: string; value: string }> = {
  top: {
    chip: "bg-[color:var(--lab-brand-subtle)] text-[color:var(--lab-brand-primary)]",
    value: "",
  },
  rise: { chip: "bg-red-50 text-[color:var(--lab-change-up)]", value: "detail-change-up" },
  drop: { chip: "bg-blue-50 text-[color:var(--lab-change-down)]", value: "detail-change-down" },
};

function HighlightRow({
  deal,
  regionSlug,
  guName,
  tone,
  reason,
  value,
  sub,
}: {
  deal: RegionHighlightDeal;
  regionSlug: string;
  guName: string;
  tone: HighlightTone;
  reason: string;
  value: string;
  sub: string | null;
}) {
  const meta = [
    deal.dong,
    formatSqmApproxPyeong(deal.exclusiveArea),
    deal.floor != null ? `${deal.floor}층` : null,
    shortDate(deal.dealDate),
  ]
    .filter(Boolean)
    .join(" · ");
  const t = HIGHLIGHT_TONE[tone];
  return (
    <li>
      <Link
        href={aptDetailHref(deal.aptName, regionSlug, guName)}
        className="flex min-h-[64px] items-center gap-3 py-3"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <span
                className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-[12px] font-semibold leading-4 ${t.chip}`}
              >
                {reason}
              </span>
            </div>
            <p className="shrink-0 whitespace-nowrap">
              <span className={`detail-list-title ${t.value}`}>{value}</span>
              {sub ? <span className="detail-meta ml-1 tabular-nums">({sub})</span> : null}
            </p>
          </div>
          <p className="detail-list-title mt-1 break-keep">{deal.aptName}</p>
          <p className="detail-meta break-keep">{meta}</p>
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
          tone: "top" as const,
          deal: h.topAmount,
          reason: "가장 큰 금액",
          value: formatEok(h.topAmount.dealAmount),
          sub: null,
        },
        h.biggestRise && {
          key: "rise",
          tone: "rise" as const,
          deal: h.biggestRise,
          reason: "가장 큰 폭 상승",
          value: signedEok(h.biggestRise.diff ?? 0),
          sub: formatEok(h.biggestRise.dealAmount),
        },
        h.biggestDrop && {
          key: "drop",
          tone: "drop" as const,
          deal: h.biggestDrop,
          reason: "가장 큰 폭 하락",
          value: signedEok(h.biggestDrop.diff ?? 0),
          sub: formatEok(h.biggestDrop.dealAmount),
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
              tone={r.tone}
              reason={r.reason}
              value={r.value}
              sub={r.sub}
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
  const totalUnits = aptUnits + officetelUnits;
  const failed = query.isError || query.data?.status === "ERROR";
  const fmt = (n: number) => n.toLocaleString("ko-KR");
  const breakdown = [
    officetelUnits > 0 ? `오피스텔 ${fmt(officetelUnits)}세대` : null,
    aptUnits > 0 ? `아파트 ${fmt(aptUnits)}세대` : null,
  ]
    .filter(Boolean)
    .join(", ");
  const summary =
    totalUnits > 0 ? `총 ${fmt(totalUnits)}세대${breakdown ? ` (${breakdown})` : ""}` : null;

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
          <div className="rounded-xl bg-[color:var(--lab-brand-subtle)] px-4 py-3">
            <p className="detail-label">앞으로 {SUPPLY_HORIZON_YEARS}년 동안 입주 예정</p>
            <p className="detail-summary-value detail-kpi-brand mt-1">
              {items.length.toLocaleString("ko-KR")}곳
            </p>
            {summary ? <p className="detail-meta mt-0.5">{summary}</p> : null}
          </div>
          <div className="flex flex-col">
            {groups.map((g) => {
              const units = g.list.reduce((sum, it) => sum + (it.supplyCount ?? 0), 0);
              return (
                <div key={g.year} className="mt-4 border-t border-[color:var(--lab-border)] pt-4 first:mt-0 first:border-t-0 first:pt-0">
                  <div className="flex items-baseline justify-between gap-2">
                    <h3 className="detail-subsection-title">{g.year}년</h3>
                    <p className="detail-meta tabular-nums">
                      {g.list.length.toLocaleString("ko-KR")}곳
                      {units > 0 ? ` · ${units.toLocaleString("ko-KR")}세대` : ""}
                    </p>
                  </div>
                  <ul className="mt-2 overflow-hidden rounded-lg border border-[color:var(--lab-border)] divide-y divide-slate-100">
                    {g.list.map((it) => (
                      <SaleRow key={it.id} item={it} />
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}

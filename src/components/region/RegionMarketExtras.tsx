"use client";

import {
  LAB_SECTION_SURFACE,
  LAB_SUBSECTION_RULE,
  LabSectionHeader,
  LabSubsectionHeader,
} from "@/components/ui/LabSection";
import { LAB_LIST_PREVIEW, LabMoreButton } from "@/components/ui/LabMoreButton";
import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { SaleRow } from "@/components/apt/ComplexNearbySalesSection";
import { RegionMarketTemperature } from "@/components/region/RegionMarketTemperature";
import { useRegionMarketDetail } from "@/components/region/useRegionScopeQueries";
import type { RegionScope } from "@/lib/region/region-scope";

export { useRegionMarketDetail };
import { aptDetailHref } from "@/lib/molit/apt-client";
import { seoulToday } from "@/lib/market/time";
import type { RegionHighlightDeal } from "@/lib/region/region-market-detail";
import type { NearbySalesResult } from "@/lib/complex-detail/applyhome-nearby-sales";
import { formatEok, formatSqmApproxPyeong } from "@/lib/utils/format";


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
  hideDong,
}: {
  deal: RegionHighlightDeal;
  regionSlug: string;
  guName: string;
  tone: HighlightTone;
  reason: string;
  value: string;
  sub: string | null;
  /** 동 페이지: 모든 거래가 같은 동이라 동 이름을 뺀다. */
  hideDong?: boolean;
}) {
  const meta = [
    hideDong ? null : deal.dong,
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
            <div className="flex min-w-0 items-center gap-1.5">
              <span
                className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-[12px] font-semibold leading-4 ${t.chip}`}
              >
                {reason}
              </span>
              {sub ? <span className={`text-[13px] font-bold tabular-nums ${t.value}`}>{sub}</span> : null}
            </div>
            {/* 오른쪽은 모든 행이 거래금액 — 세로로 줄이 맞게 */}
            <p className="shrink-0 whitespace-nowrap">
              <span className="detail-list-title tabular-nums text-[color:var(--lab-navy-950)]">{value}</span>
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
  scope,
  regionSlug,
  regionName,
  label,
}: {
  scope: RegionScope;
  regionSlug: string;
  /** 구 이름 — 단지 상세 링크의 gu 파라미터. */
  regionName: string;
  /** 섹션 접근성 이름에 쓰는 지역 표기 (기본 regionName, 동 페이지는 동 이름). */
  label?: string;
}) {
  const query = useRegionMarketDetail(scope);
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
          value: formatEok(h.biggestRise.dealAmount),
          sub: signedEok(h.biggestRise.diff ?? 0),
        },
        h.biggestDrop && {
          key: "drop",
          tone: "drop" as const,
          deal: h.biggestDrop,
          reason: "가장 큰 폭 하락",
          value: formatEok(h.biggestDrop.dealAmount),
          sub: signedEok(h.biggestDrop.diff ?? 0),
        },
      ].filter((r): r is NonNullable<typeof r> => Boolean(r))
    : [];

  return (
    <section
      id="market-trends"
      aria-label={`${label ?? regionName} 거래 동향`}
      className={`${LAB_SECTION_SURFACE} flex flex-col gap-3`}
    >
      <LabSectionHeader
        title="거래 동향"
        meta="계약일 기준"
        tip={
          <p>
            실거래는 계약 후 30일 안에 신고되므로 최근 한 달 거래는 아직 모두
            집계되지 않았을 수 있습니다.
          </p>
        }
      />
      <RegionMarketTemperature scope={scope} />
      <div className={`mt-1 ${LAB_SUBSECTION_RULE}`}>
        <LabSubsectionHeader
          title="주목할 거래"
          meta="최근 1개월"
          tip={
            <p>
              최근 30일 동안 계약된 매매 실거래 중 거래금액이 가장 큰 거래와, 같은
              단지·면적의 직전 거래 대비 가장 크게 오르거나 내린 거래입니다.
            </p>
          }
        />
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
              hideDong={Boolean(scope.dong)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

const SUPPLY_HORIZON_YEARS = 6;

export function RegionSupplyTimelineSection({ regionName }: { regionName: string }) {
  const [expanded, setExpanded] = useState(false);
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
  const visibleIds = new Set(
    (expanded ? items : items.slice(0, LAB_LIST_PREVIEW)).map((it) => it.id),
  );
  const groups = [...new Set(items.map((it) => it.moveInYm!.slice(0, 4)))]
    .map((year) => {
      const list = items.filter((it) => it.moveInYm!.startsWith(year));
      return { year, list, visible: list.filter((it) => visibleIds.has(it.id)) };
    })
    .filter((g) => g.visible.length > 0);
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
      id="market-supply"
      aria-label={`${regionName} 입주 예정`}
      className={`${LAB_SECTION_SURFACE} flex flex-col gap-3`}
    >
      <LabSectionHeader
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
          <div>
            <p className="detail-label">앞으로 {SUPPLY_HORIZON_YEARS}년 동안 입주 예정</p>
            <p className="detail-summary-value mt-0.5">
              {items.length.toLocaleString("ko-KR")}곳
              {summary ? (
                <span className="detail-meta ml-2 align-baseline font-normal">{summary}</span>
              ) : null}
            </p>
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
                    {g.visible.map((it) => (
                      <SaleRow key={it.id} item={it} />
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
          {items.length > LAB_LIST_PREVIEW ? (
            <LabMoreButton
              expanded={expanded}
              onToggle={() => setExpanded((v) => !v)}
              label={`${items.length - LAB_LIST_PREVIEW}곳 더보기`}
            />
          ) : null}
        </>
      )}
    </section>
  );
}

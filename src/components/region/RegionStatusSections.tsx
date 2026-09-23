"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { InfoTip } from "@/components/ui/InfoTip";
import { LabTabs } from "@/components/ui/LabTabs";
import {
  DECADE_COHORTS_V3,
  type DecadeKeyV3,
} from "@/lib/region-ranking/ranking-v3";
import {
  TREND_PERIOD_TABS,
  formatSignedPct,
  formatWonPerPyeong,
} from "@/lib/region-ranking/public";
import { aptDetailHref } from "@/lib/molit/apt-client";
import type { RegionDailyDeal } from "@/lib/molit/service";
import {
  formatDealDate,
  formatEok,
  formatSqmApproxPyeong,
} from "@/lib/utils/format";
import type { NearbySalesResult } from "@/lib/complex-detail/applyhome-nearby-sales";

export const REGION_REP_PRICE_TITLE = "지역 대표 평당가";
export const REGION_REP_PRICE_TIP =
  "같은 지역·평형대 단지들의 최근 실거래를 바탕으로 계산한 대표 평당가입니다.";
export const REGION_REP_PRICE_BASIS = "최근 실거래 기준";
export const REGION_PRICE_TREND_TITLE = "가격 흐름";
export const REGION_RECENT_TX_TITLE = "최근 실거래";
export const REGION_ANALYSIS_TITLE = "지역 분석";
export const REGION_SUPPLY_TITLE = "입주·공급";
export const REGION_SUPPLY_SCOPE_TIP =
  "같은 시·군·구의 청약·입주 예정 공급 정보를 보여드려요.";
export const REGION_SUPPLY_ERROR = "주변 공급 정보를 불러오지 못했습니다.";
export const REGION_PRICE_UNAVAILABLE = "대표 평당가 정보를 준비 중입니다.";

const PRICE_COHORT_TABS = DECADE_COHORTS_V3.map((cohort) => ({
  id: cohort.key as DecadeKeyV3,
  label: cohort.label === "100평+" ? "100평대+" : cohort.label,
}));

export type RegionPricePositionResponse =
  | { status: "unavailable"; reason?: string }
  | {
      status: "ok";
      version: string;
      regionCode: string;
      scope: "GU" | "DONG";
      areaBand: string;
      supplyPyeongCohort: string | null;
      hostComplexId: string;
      price: {
        scope: "GU" | "DONG" | "SEOUL";
        label: string;
        meanPricePerSupplyPyeong: number | null;
        status: string;
      };
      comparisons?: Array<{
        scope: "GU" | "DONG" | "SEOUL";
        label: string;
        meanPricePerSupplyPyeong: number | null;
        status: string;
      }>;
      trends: Array<{
        period: "6M" | "1Y" | "2Y" | "5Y";
        scope: "GU" | "DONG";
        changePercent: number | null;
        status: string;
      }>;
      transactionAsOf: string | null;
      referenceMonth: null;
      asOfMonth: string | null;
    };

export async function fetchRegionPricePosition(params: {
  regionCode: string;
  areaBand: string;
  fromComplexId?: string | null;
}): Promise<RegionPricePositionResponse> {
  const qs = new URLSearchParams({
    region_code: params.regionCode,
    area_band: params.areaBand,
  });
  if (params.fromComplexId?.trim()) {
    qs.set("from_complex_id", params.fromComplexId.trim());
  }
  const res = await fetch(`/api/region-price-position?${qs.toString()}`);
  if (!res.ok) return { status: "unavailable", reason: "http" };
  return (await res.json()) as RegionPricePositionResponse;
}

export function RegionStatusHero({
  title,
  parentLabel,
  onParentClick,
}: {
  title: string;
  /** e.g. "서울 · 송파구" or "서울" */
  parentLabel: string;
  onParentClick?: (() => void) | null;
}) {
  return (
    <header className="flex flex-col gap-1.5">
      <h1 className="text-[1.75rem] font-semibold leading-tight tracking-tight text-[color:var(--lab-navy-950)] sm:text-[2rem]">
        {title}
      </h1>
      {onParentClick ? (
        <button
          type="button"
          onClick={onParentClick}
          className="inline-flex max-w-full items-center gap-0.5 self-start text-[13px] leading-5 text-slate-500 hover:text-slate-800"
          aria-label={`${parentLabel}로 이동`}
        >
          <span className="truncate">{parentLabel}</span>
          <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-70" aria-hidden />
        </button>
      ) : (
        <p className="text-[13px] leading-5 text-slate-500">{parentLabel}</p>
      )}
    </header>
  );
}

export function RegionPriceCohortSelector({
  value,
  onChange,
}: {
  value: DecadeKeyV3;
  onChange: (next: DecadeKeyV3) => void;
}) {
  return (
    <LabTabs
      items={PRICE_COHORT_TABS}
      value={value}
      onChange={onChange}
      ariaLabel="평형대"
      variant="compact"
      equalWidth={false}
      className="!max-w-full !justify-start overflow-x-auto"
    />
  );
}

export function RegionMarketSummary({
  regionCode,
  decade,
  onDecadeChange,
  guName,
}: {
  regionCode: string | null;
  decade: DecadeKeyV3;
  onDecadeChange: (next: DecadeKeyV3) => void;
  guName: string;
}) {
  const query = useQuery({
    queryKey: ["region-price-position", regionCode, decade],
    queryFn: () =>
      fetchRegionPricePosition({
        regionCode: regionCode!,
        areaBand: decade,
      }),
    enabled: !!regionCode && /^\d+$/.test(decade),
    staleTime: 5 * 60_000,
    retry: 1,
  });

  const data = query.data?.status === "ok" ? query.data : null;
  const priceText =
    data?.price.meanPricePerSupplyPyeong != null
      ? formatWonPerPyeong(data.price.meanPricePerSupplyPyeong)
      : null;
  const cohortLabel =
    data?.supplyPyeongCohort ||
    DECADE_COHORTS_V3.find((c) => c.key === decade)?.label ||
    null;

  const comparisons = (data?.comparisons ?? [])
    .filter((c) => c.status === "ok" && c.meanPricePerSupplyPyeong != null)
    .map((c) => ({
      label:
        c.scope === "SEOUL"
          ? "서울"
          : c.scope === "GU"
            ? c.label || guName
            : c.label,
      text: formatWonPerPyeong(c.meanPricePerSupplyPyeong),
    }))
    .filter((c) => c.text);

  return (
    <section aria-label="지역 대표 평당가" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center">
          <h2 className="text-[15px] font-semibold leading-none tracking-tight text-slate-800">
            {REGION_REP_PRICE_TITLE}
          </h2>
          <InfoTip aria-label="지역 대표 평당가 안내">
            <p>{REGION_REP_PRICE_TIP}</p>
          </InfoTip>
        </div>
        <RegionPriceCohortSelector value={decade} onChange={onDecadeChange} />
      </div>

      {query.isLoading ? (
        <div className="h-14 animate-pulse rounded-lg bg-slate-100" />
      ) : query.isError || !priceText ? (
        <p className="text-sm text-slate-600">{REGION_PRICE_UNAVAILABLE}</p>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-[2rem] font-semibold tabular-nums leading-none tracking-tight text-slate-900 sm:text-[2.25rem]">
            {priceText}
          </p>
          <p className="text-[12px] leading-4 text-slate-500">
            {[cohortLabel, REGION_REP_PRICE_BASIS].filter(Boolean).join(" · ")}
          </p>
          {comparisons.length > 0 ? (
            <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[13px] tabular-nums text-slate-600">
              {comparisons.map((c) => (
                <span key={c.label}>
                  <span className="text-slate-500">{c.label}</span>{" "}
                  <span className="font-medium text-slate-800">{c.text}</span>
                </span>
              ))}
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}

export function RegionPriceTrendSection({
  regionCode,
  decade,
}: {
  regionCode: string | null;
  decade: string;
}) {
  const query = useQuery({
    queryKey: ["region-price-position", regionCode, decade],
    queryFn: () =>
      fetchRegionPricePosition({
        regionCode: regionCode!,
        areaBand: decade,
      }),
    enabled: !!regionCode && /^\d+$/.test(decade),
    staleTime: 5 * 60_000,
    retry: 1,
  });
  const data = query.data?.status === "ok" ? query.data : null;
  const rows = TREND_PERIOD_TABS.map((tab) => {
    const hit = data?.trends.find((t) => t.period === tab.id);
    return {
      id: tab.id,
      label: tab.label,
      value:
        hit?.status === "ok" && hit.changePercent != null
          ? formatSignedPct(hit.changePercent)
          : null,
      raw: hit?.changePercent ?? null,
    };
  });
  const hasAny = rows.some((r) => r.value);

  if (!regionCode) return null;
  if (query.isLoading) {
    return (
      <section aria-label={REGION_PRICE_TREND_TITLE} className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold leading-none tracking-tight text-slate-900">
          {REGION_PRICE_TREND_TITLE}
        </h2>
        <div className="h-20 animate-pulse rounded-lg bg-slate-100" />
      </section>
    );
  }
  if (!hasAny) return null;

  return (
    <section
      aria-label={REGION_PRICE_TREND_TITLE}
      className="flex flex-col gap-3 border-t border-slate-100 pt-8"
    >
      <h2 className="text-xl font-semibold leading-none tracking-tight text-slate-900">
        {REGION_PRICE_TREND_TITLE}
      </h2>
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        {rows.map((row) => (
          <div key={row.id} className="min-w-0">
            <p className="text-[12px] text-slate-500">{row.label}</p>
            <p
              className={`mt-1 text-[1.125rem] font-semibold tabular-nums leading-none ${
                row.raw == null
                  ? "text-slate-400"
                  : row.raw > 0
                    ? "text-[color:var(--lab-change-up)]"
                    : row.raw < 0
                      ? "text-[color:var(--lab-change-down)]"
                      : "text-slate-900"
              }`}
            >
              {row.value ?? "—"}
              <span className="sr-only">
                {row.raw == null
                  ? ""
                  : row.raw > 0
                    ? " 상승"
                    : row.raw < 0
                      ? " 하락"
                      : " 보합"}
              </span>
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

export function RegionRecentTransactions({
  deals,
  regionSlug,
  guName,
  volumeCount,
  volumeNote,
  loading,
  error,
}: {
  deals: RegionDailyDeal[];
  regionSlug: string;
  guName: string;
  volumeCount?: number | null;
  volumeNote?: string | null;
  loading?: boolean;
  error?: boolean;
}) {
  const visible = deals.slice(0, 12);
  return (
    <section
      id="region-recent-transactions"
      aria-label={REGION_RECENT_TX_TITLE}
      className="flex flex-col gap-3 scroll-mt-28 border-t border-slate-100 pt-8"
    >
      <div className="flex flex-wrap items-end justify-between gap-2">
        <h2 className="text-xl font-semibold leading-none tracking-tight text-slate-900">
          {REGION_RECENT_TX_TITLE}
        </h2>
        {volumeCount != null ? (
          <p className="text-[12px] leading-4 text-slate-500">
            이번 달 {volumeCount.toLocaleString("ko-KR")}건
            {volumeNote ? ` · ${volumeNote}` : null}
          </p>
        ) : null}
      </div>
      {error ? (
        <p className="text-sm text-slate-600">최근 실거래를 불러오지 못했습니다.</p>
      ) : loading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-12 animate-pulse rounded-lg bg-slate-100" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <p className="text-sm text-slate-600">표시할 최근 실거래가 없습니다.</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {visible.map((deal) => {
            const href = aptDetailHref(deal.aptName, regionSlug, deal.gu || guName);
            return (
              <li key={deal.id}>
                <Link
                  href={href}
                  className="flex items-center justify-between gap-3 py-2.5 min-h-11"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[15px] font-semibold text-slate-900">
                      {deal.aptName}
                    </p>
                    <p className="mt-0.5 truncate text-[12px] text-slate-500">
                      {formatDealDate(deal.dealDate)} ·{" "}
                      {formatSqmApproxPyeong(deal.exclusiveArea)} · {deal.floor}층
                    </p>
                  </div>
                  <p className="shrink-0 text-[15px] font-semibold tabular-nums text-slate-900">
                    {formatEok(deal.dealAmount)}
                  </p>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function RegionAnalysisSection({
  volumePct,
  yearAgoPct,
  singogaCount,
  singogaPct,
  comparePartial,
}: {
  volumePct: number | null;
  yearAgoPct: number | null;
  singogaCount: number | null;
  singogaPct: number | null;
  comparePartial: boolean;
}) {
  const items: Array<{ label: string; value: string; hint?: string }> = [];
  if (volumePct != null) {
    items.push({
      label: "거래량 전월 대비",
      value: formatSignedPct(volumePct) ?? "—",
      hint: comparePartial ? "오늘까지" : undefined,
    });
  }
  if (yearAgoPct != null) {
    items.push({
      label: "거래량 전년 동월",
      value: formatSignedPct(yearAgoPct) ?? "—",
    });
  }
  if (singogaCount != null) {
    items.push({
      label: "신고가",
      value: `${singogaCount.toLocaleString("ko-KR")}건`,
      hint:
        singogaPct != null
          ? `${Math.round(singogaPct).toLocaleString("ko-KR")}%`
          : undefined,
    });
  }
  if (items.length === 0) return null;

  return (
    <section
      aria-label={REGION_ANALYSIS_TITLE}
      className="flex flex-col gap-3 border-t border-slate-100 pt-8"
    >
      <h2 className="text-xl font-semibold leading-none tracking-tight text-slate-900">
        {REGION_ANALYSIS_TITLE}
      </h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {items.slice(0, 3).map((item) => (
          <div key={item.label} className="min-w-0">
            <p className="text-[12px] text-slate-500">{item.label}</p>
            <p className="mt-1 text-[1.125rem] font-semibold tabular-nums text-slate-900">
              {item.value}
            </p>
            {item.hint ? (
              <p className="mt-0.5 text-[12px] text-slate-500">{item.hint}</p>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

export function RegionSupplySection({ sigungu }: { sigungu: string }) {
  const query = useQuery({
    queryKey: ["region-nearby-sales", sigungu],
    queryFn: async () => {
      const res = await fetch(
        `/api/complex-nearby-sales?sigungu=${encodeURIComponent(sigungu)}`,
      );
      if (!res.ok) throw new Error("supply");
      return (await res.json()) as NearbySalesResult;
    },
    enabled: !!sigungu.trim(),
    staleTime: 10 * 60_000,
    retry: 1,
  });

  const data = query.data;
  const items = (data?.items ?? []).slice(0, 8);

  return (
    <section
      id="region-supply"
      aria-label={REGION_SUPPLY_TITLE}
      className="flex flex-col gap-3 scroll-mt-28 border-t border-slate-100 pt-8"
    >
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="flex min-w-0 items-center">
          <h2 className="text-xl font-semibold leading-none tracking-tight text-slate-900">
            {REGION_SUPPLY_TITLE}
          </h2>
          <InfoTip aria-label="입주·공급 안내">
            <p>{REGION_SUPPLY_SCOPE_TIP}</p>
          </InfoTip>
        </div>
        <p className="text-[12px] text-slate-500">{sigungu} 기준</p>
      </div>
      {query.isLoading ? (
        <div className="h-24 animate-pulse rounded-lg bg-slate-100" />
      ) : query.isError || data?.status === "ERROR" ? (
        <p className="text-sm text-slate-600">{REGION_SUPPLY_ERROR}</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-slate-600">
          {data?.reason?.trim() ||
            `현재 ${sigungu}에 확인된 청약·입주예정 주택이 없습니다.`}
        </p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {items.map((item) => (
            <li key={item.id} className="py-2.5">
              <p className="truncate text-[15px] font-semibold text-slate-900">
                {item.houseName}
              </p>
              <p className="mt-0.5 truncate text-[12px] text-slate-500">
                {[item.statusLabel, item.moveInLabel ? `${item.moveInLabel} 입주예정` : null]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </li>
          ))}
        </ul>
      )}
      {data?.attribution ? (
        <p className="text-[11px] text-slate-400">{data.attribution}</p>
      ) : null}
    </section>
  );
}

/** Flatten history sections into recent contract-date deals, optional dong filter. */
export function collectRecentContractDeals(params: {
  sections: Array<{ deals: RegionDailyDeal[] }>;
  dongName?: string | null;
  limit?: number;
}): RegionDailyDeal[] {
  const dong = params.dongName?.replace(/\s+/g, "") ?? null;
  const all = params.sections.flatMap((s) => s.deals);
  const filtered = dong
    ? all.filter((d) => d.dong.replace(/\s+/g, "") === dong)
    : all;
  const sorted = [...filtered].sort((a, b) => {
    const byDate = b.dealDate.localeCompare(a.dealDate);
    if (byDate !== 0) return byDate;
    return a.id.localeCompare(b.id);
  });
  return sorted.slice(0, params.limit ?? 20);
}

export function useRegionScopeControls() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const setParams = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams.toString());
    next.set("tab", "stats");
    for (const [key, value] of Object.entries(patch)) {
      if (value == null || value === "") next.delete(key);
      else next.set(key, value);
    }
    const hash = next.get("section") === "ranking" ? "#region-ranking" : "";
    router.replace(`${pathname}?${next.toString()}${hash}`, { scroll: false });
  };

  return { searchParams, setParams };
}

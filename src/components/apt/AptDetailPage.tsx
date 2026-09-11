"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  CalendarDays,
  Flame,
  LoaderCircle,
} from "lucide-react";
import { BackLink } from "@/components/layout/BackLink";
import { LabKpiCard } from "@/components/lab/LabKpiCard";
import type { AptDetailResponse, AptHistoryItem } from "@/lib/molit/apt";
import {
  AptPriceChart,
  PeriodRangeSlider,
} from "@/components/apt/AptPriceChart";
import { AptAreaSelector } from "@/components/apt/AptAreaSelector";
import {
  formatComplexLocationLabel,
  recordRecentComplex,
} from "@/lib/complexes/recent-views";
import {
  isValidAreaKey,
  normalizeAreaKey,
  resolveDefaultAreaKey,
} from "@/lib/apt/default-area";
import {
  PAGE_HEADER_WITH_BACK,
  PAGE_SHELL,
  PageHeader,
} from "@/components/layout/PageHeader";
import { useLoadProgress } from "@/components/layout/LoadProgress";
import {
  formatArea,
  formatDealDate,
  formatEok,
  formatExclusiveArea,
  formatPyeong,
  formatRentAmount,
} from "@/lib/utils/format";

const QUICK_MONTHS = 36;
const FULL_MONTHS = 120;
const RECENT_YEARS = 3;

/**
 * Compact 2-line trade row.
 * Line 1: date (left) · price (right, never truncated)
 * Line 2: 전용 ㎡ (평) · 층 · 신규/갱신 등 거래구분
 */
function TradeHistoryRow({ tx }: { tx: AptHistoryItem }) {
  const dateFull = formatDealDate(tx.dealDate);
  const dateShort =
    dateFull.length >= 10 ? dateFull.slice(5) : dateFull;
  const priceLabel =
    tx.dealType === "trade"
      ? `매매 ${formatEok(tx.dealAmount)}`
      : formatRentAmount(tx.dealAmount, tx.monthlyRent);
  const dealingLabel = tx.dealingGbn || "중개거래";

  return (
    <li className="px-3.5 py-2.5 sm:px-4 sm:py-3">
      <div className="flex items-baseline justify-between gap-3">
        <time
          dateTime={tx.dealDate}
          title={dateFull}
          aria-label={dateFull}
          className="shrink-0 text-sm font-medium tabular-nums text-slate-900"
        >
          <span className="sm:hidden">{dateShort}</span>
          <span className="hidden sm:inline">{dateFull}</span>
        </time>
        <div className="flex shrink-0 items-center justify-end gap-1.5 sm:gap-2">
          {tx.isSingoga ? (
            <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-rose-500 px-1.5 py-0.5 text-[10px] font-semibold text-white sm:gap-1 sm:px-2 sm:text-[11px]">
              <Flame className="h-3 w-3" aria-hidden />
              신고가
            </span>
          ) : null}
          <p
            className={`whitespace-nowrap text-sm font-semibold tabular-nums sm:text-base ${
              tx.dealType === "trade" ? "text-teal-800" : "text-orange-700"
            }`}
          >
            {priceLabel}
          </p>
        </div>
      </div>
      <p className="mt-1 text-xs leading-snug text-slate-500 sm:text-[13px]">
        <span className="tabular-nums">{formatArea(tx.exclusiveArea)}</span>
        <span className="text-slate-300" aria-hidden>
          {" "}
          ·{" "}
        </span>
        <span className="tabular-nums">{tx.floor}층</span>
        <span className="text-slate-300" aria-hidden>
          {" "}
          ·{" "}
        </span>
        <span>{dealingLabel}</span>
      </p>
    </li>
  );
}

async function fetchAptDetail(
  aptName: string,
  region: string,
  months: number,
  gu?: string,
): Promise<AptDetailResponse> {
  const qs = new URLSearchParams({
    aptName,
    region,
    months: String(months),
  });
  if (gu?.trim()) qs.set("gu", gu.trim());
  const res = await fetch(`/api/apt-detail?${qs.toString()}`);
  if (!res.ok) throw new Error("failed");
  return res.json();
}

function groupByYear(items: AptDetailResponse["items"]) {
  const map = new Map<string, AptDetailResponse["items"]>();
  for (const item of items) {
    const year = item.dealDate.slice(0, 4);
    const list = map.get(year) ?? [];
    list.push(item);
    map.set(year, list);
  }
  return [...map.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
}

function ymFromDealDate(dealDate: string): string {
  return `${dealDate.slice(0, 4)}${dealDate.slice(5, 7)}`;
}

function recentYearsRange(length: number, years = RECENT_YEARS) {
  if (length <= 0) return { start: 0, end: 0 };
  const count = Math.min(years * 12, length);
  return {
    start: Math.max(0, length - count),
    end: length - 1,
  };
}

type PeriodPreset = "recent3" | "full" | "custom";

export function AptDetailPage({
  aptName,
  regionSlug,
  gu,
  initialAreaKey,
}: {
  aptName: string;
  regionSlug: string;
  gu?: string;
  /** URL ?area= — 명시 시 자동 기본값보다 우선 */
  initialAreaKey?: string;
}) {
  const aptIdentity = `${aptName}|${regionSlug}|${gu ?? ""}`;
  /** 사용자/수동 선택. aptIdentity가 바뀌면 자동 기본값으로 복귀 */
  const [areaOverride, setAreaOverride] = useState<{
    forId: string;
    key: string;
  } | null>(null);
  const [dealFilter, setDealFilter] = useState<"all" | "trade" | "rent">("all");
  const [rangeOverride, setRangeOverride] = useState<{
    start: number;
    end: number;
  } | null>(null);
  const [boundKey, setBoundKey] = useState(aptIdentity);
  const [periodPreset, setPeriodPreset] = useState<PeriodPreset>("recent3");
  const [stickyVisible, setStickyVisible] = useState(false);
  const heroRef = useRef<HTMLElement | null>(null);

  const quickQuery = useQuery({
    queryKey: ["apt-detail", aptName, regionSlug, gu ?? "", "quick", QUICK_MONTHS],
    queryFn: () => fetchAptDetail(aptName, regionSlug, QUICK_MONTHS, gu),
    staleTime: 5 * 60 * 1000,
  });

  const fullQuery = useQuery({
    queryKey: ["apt-detail", aptName, regionSlug, gu ?? "", "full", FULL_MONTHS],
    queryFn: () => fetchAptDetail(aptName, regionSlug, FULL_MONTHS, gu),
    enabled: quickQuery.isSuccess,
    staleTime: 30 * 60 * 1000,
  });

  const data = fullQuery.data ?? quickQuery.data;

  /** URL > 84㎡대/거래량 자동 > all */
  const resolvedAreaKey = useMemo(() => {
    if (!data?.areas) return initialAreaKey ?? "all";
    if (initialAreaKey && isValidAreaKey(initialAreaKey, data.areas)) {
      return initialAreaKey;
    }
    return resolveDefaultAreaKey(data.areas, data.items);
  }, [data, initialAreaKey]);

  /** 단지당 최초 확정값 (quick→full 재계산으로 선택값이 바뀌지 않게) */
  const [frozenDefault, setFrozenDefault] = useState<{
    forId: string;
    key: string;
  } | null>(null);
  if (data?.areas && frozenDefault?.forId !== aptIdentity) {
    setFrozenDefault({ forId: aptIdentity, key: resolvedAreaKey });
  }

  const defaultAreaKey =
    frozenDefault?.forId === aptIdentity
      ? frozenDefault.key
      : resolvedAreaKey;

  const areaKey =
    areaOverride?.forId === aptIdentity ? areaOverride.key : defaultAreaKey;

  // 단지 상세 진입 시 최근 조회 기록 (localStorage MVP)
  useEffect(() => {
    if (!data?.aptName || !data.regionSlug) return;
    recordRecentComplex({
      aptName: data.aptName,
      regionSlug: data.regionSlug,
      gu: data.gu || gu,
      dong: data.dong,
      regionLabel: formatComplexLocationLabel({
        regionSlug: data.regionSlug,
        regionName: data.regionName,
        gu: data.gu || gu,
        dong: data.dong,
      }),
    });
  }, [
    data?.aptName,
    data?.regionSlug,
    data?.gu,
    data?.dong,
    data?.regionName,
    gu,
  ]);

  useEffect(() => {
    if (!data) return;
    const hero = heroRef.current;
    if (!hero) return;

    let observer: IntersectionObserver | null = null;

    const bind = () => {
      observer?.disconnect();
      const header = document.querySelector<HTMLElement>("[data-site-header]");
      const headerH = Math.max(
        56,
        Math.round(header?.getBoundingClientRect().height ?? 56),
      );
      observer = new IntersectionObserver(
        ([entry]) => {
          setStickyVisible(!entry.isIntersecting);
        },
        {
          // 사이트 헤더 아래에서 히어로가 사라질 때 고정 타이틀 표시
          rootMargin: `-${headerH}px 0px 0px 0px`,
          threshold: 0,
        },
      );
      observer.observe(hero);
    };

    bind();
    const header = document.querySelector<HTMLElement>("[data-site-header]");
    const ro = header ? new ResizeObserver(bind) : null;
    if (header && ro) ro.observe(header);

    return () => {
      observer?.disconnect();
      ro?.disconnect();
      setStickyVisible(false);
    };
  }, [data]);
  const isExtendingHistory =
    quickQuery.isSuccess && !fullQuery.isSuccess && fullQuery.isFetching;
  const { show: showLoadProgress, hide: hideLoadProgress } = useLoadProgress();
  const loadProgressLabel =
    quickQuery.isLoading && !data
      ? "시세 불러오는 중…"
      : isExtendingHistory
        ? "과거 시세 추가로 불러오는 중…"
        : null;

  useEffect(() => {
    if (loadProgressLabel) showLoadProgress(loadProgressLabel);
    else hideLoadProgress();
    return () => hideLoadProgress();
  }, [loadProgressLabel, showLoadProgress, hideLoadProgress]);

  const chartMonths = data?.chart.map((p) => p.yearMonth) ?? [];
  const dataKey = `${aptName}|${regionSlug}|${chartMonths.length}|${data?.loadedMonths ?? 0}`;
  if (boundKey !== dataKey) {
    setBoundKey(dataKey);
    // 프리셋 유지 시 새 데이터 길이에 맞게 기본 구간 재계산
    if (periodPreset !== "custom") {
      setRangeOverride(null);
    }
  }

  const defaultRange =
    periodPreset === "full"
      ? { start: 0, end: Math.max(chartMonths.length - 1, 0) }
      : recentYearsRange(chartMonths.length, RECENT_YEARS);

  const startIndex = rangeOverride?.start ?? defaultRange.start;
  const endIndex = rangeOverride?.end ?? defaultRange.end;
  const startYm = chartMonths[startIndex] ?? "";
  const endYm = chartMonths[endIndex] ?? "";

  const areaFiltered = useMemo(() => {
    if (!data) return [];
    if (areaKey === "all") return data.items;
    // areas.key 와 item 면적을 동일 normalize로 맞춰 거래이력·차트에 반영
    const selected = data.areas.find((a) => a.key === areaKey);
    const matchKey = selected
      ? normalizeAreaKey(selected.exclusiveArea)
      : areaKey;
    return data.items.filter(
      (item) => normalizeAreaKey(Number(item.exclusiveArea)) === matchKey,
    );
  }, [data, areaKey]);

  const selectedArea = useMemo(
    () => data?.areas.find((a) => a.key === areaKey) ?? null,
    [data, areaKey],
  );

  const periodItems = useMemo(() => {
    if (!startYm || !endYm) return areaFiltered;
    return areaFiltered.filter((item) => {
      const ym = ymFromDealDate(item.dealDate);
      return ym >= startYm && ym <= endYm;
    });
  }, [areaFiltered, startYm, endYm]);

  const filtered = useMemo(() => {
    if (dealFilter === "all") return periodItems;
    return periodItems.filter((item) => item.dealType === dealFilter);
  }, [periodItems, dealFilter]);

  const chartPoints = useMemo(() => {
    if (!data) return [];
    const base = data.chart.slice(startIndex, endIndex + 1);
    if (areaKey === "all") return base;

    const months = base.map((p) => p.yearMonth);
    const byMonth = new Map(
      months.map((ym) => [
        ym,
        {
          yearMonth: ym,
          label: `${ym.slice(2, 4)}.${ym.slice(4, 6)}`,
          tradeSums: [] as number[],
          jeonseSums: [] as number[],
          wolseCount: 0,
        },
      ]),
    );

    for (const tx of areaFiltered) {
      const ym = ymFromDealDate(tx.dealDate);
      const bucket = byMonth.get(ym);
      if (!bucket) continue;
      if (tx.dealType === "trade") bucket.tradeSums.push(tx.dealAmount);
      else if (tx.monthlyRent > 0) bucket.wolseCount += 1;
      else bucket.jeonseSums.push(tx.dealAmount);
    }

    return months.map((ym) => {
      const b = byMonth.get(ym)!;
      const tradeCount = b.tradeSums.length;
      const jeonseCount = b.jeonseSums.length;
      return {
        yearMonth: ym,
        label: b.label,
        tradeAvg:
          tradeCount > 0
            ? Math.round(b.tradeSums.reduce((a, c) => a + c, 0) / tradeCount)
            : null,
        tradeMax: tradeCount > 0 ? Math.max(...b.tradeSums) : null,
        tradeCount,
        jeonseAvg:
          jeonseCount > 0
            ? Math.round(b.jeonseSums.reduce((a, c) => a + c, 0) / jeonseCount)
            : null,
        jeonseCount,
        wolseCount: b.wolseCount,
        volume: tradeCount + jeonseCount + b.wolseCount,
      };
    });
  }, [data, startIndex, endIndex, areaKey, areaFiltered]);

  const periodTradeCount = periodItems.filter(
    (i) => i.dealType === "trade",
  ).length;
  const periodRentCount = periodItems.filter((i) => i.dealType === "rent").length;
  const periodMax =
    periodItems
      .filter((i) => i.dealType === "trade")
      .reduce((m, i) => Math.max(m, i.dealAmount), 0) || 0;

  const latestTrade = useMemo(() => {
    const trades = periodItems
      .filter((i) => i.dealType === "trade")
      .sort((a, b) => (a.dealDate < b.dealDate ? 1 : -1));
    return trades[0] ?? null;
  }, [periodItems]);

  const vsMaxPct =
    latestTrade && periodMax > 0
      ? Math.round((latestTrade.dealAmount / periodMax - 1) * 1000) / 10
      : null;

  const grouped = useMemo(() => groupByYear(filtered), [filtered]);

  const setRecentYears = (years: number) => {
    if (chartMonths.length === 0) return;
    setPeriodPreset(years === 3 ? "recent3" : "custom");
    setRangeOverride(recentYearsRange(chartMonths.length, years));
  };

  const setFullRange = () => {
    if (chartMonths.length === 0) return;
    setPeriodPreset("full");
    setRangeOverride({ start: 0, end: chartMonths.length - 1 });
  };

  if (quickQuery.isLoading && !data) {
    return (
      <div className={`${PAGE_SHELL} max-w-5xl`}>
        <div className="h-24 animate-pulse rounded-xl bg-slate-200/70" />
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-20 animate-pulse rounded-xl bg-slate-200/60" />
          ))}
        </div>
        <div className="h-64 animate-pulse rounded-xl bg-slate-200/50" />
      </div>
    );
  }

  if ((quickQuery.isError && !data) || !data) {
    return (
      <div className={`${PAGE_SHELL} max-w-5xl text-center`}>
        <p className="text-sm font-medium text-slate-700">
          단지 정보를 불러오지 못했습니다.
        </p>
        <div className="mt-3 flex justify-center">
          <BackLink fallback="/complexes" className="hidden sm:inline-flex" />
        </div>
      </div>
    );
  }

  const locationLabel = `${data.fullName}${data.dong ? ` ${data.dong}` : ""}`;

  return (
    <div className={`${PAGE_SHELL.replace("gap-6", "gap-3")} max-w-5xl`}>
      <div
        className={`fixed inset-x-0 z-40 border-b border-slate-200/80 bg-white/95 shadow-sm backdrop-blur transition duration-200 ${
          stickyVisible
            ? "translate-y-0 opacity-100"
            : "pointer-events-none invisible -translate-y-2 opacity-0"
        }`}
        style={{ top: "var(--site-header-height, 5.5rem)" }}
        aria-hidden={!stickyVisible}
      >
        <div className="mx-auto flex w-full max-w-5xl items-center gap-2 px-3 py-2 sm:gap-3 sm:px-6">
          <BackLink fallback="/complexes" compact hideLabelOnMobile />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-slate-900">
              {data.aptName}
            </p>
            <p className="truncate text-[11px] text-slate-500">
              {locationLabel}
              {data.buildYear ? ` · ${data.buildYear}년 입주` : ""}
              {" · "}
              매매 {data.stats.totalTradeCount.toLocaleString("ko-KR")}건 · 전월세{" "}
              {data.stats.totalRentCount.toLocaleString("ko-KR")}건
            </p>
          </div>
        </div>
      </div>

      <header ref={heroRef} className={PAGE_HEADER_WITH_BACK}>
        <BackLink fallback="/complexes" className="hidden sm:inline-flex" />
        <PageHeader
          title={data.aptName}
          description={`${locationLabel}${data.buildYear ? ` · ${data.buildYear}년 입주` : ""}`}
          meta={
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span>
                매매 {data.stats.totalTradeCount.toLocaleString("ko-KR")}건 · 전월세{" "}
                {data.stats.totalRentCount.toLocaleString("ko-KR")}건
              </span>
              <Link
                href={`/region/${data.regionSlug}`}
                className="font-medium text-teal-700 underline-offset-2 hover:underline"
              >
                {data.regionName} 지역
              </Link>
            </div>
          }
        >
          <AptAreaSelector
            areas={data.areas}
            value={areaKey}
            onChange={(key) => {
              setAreaOverride({ forId: aptIdentity, key });
            }}
          />
        </PageHeader>
      </header>

      {(data.warning || data.source === "mock") && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            {data.warning ??
              "실거래 데이터 연동이 없어 데모 데이터로 표시 중입니다."}
          </p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <LabKpiCard
          label="최근 매매"
          value={latestTrade ? formatEok(latestTrade.dealAmount) : "—"}
          hint={latestTrade
              ? `${formatDealDate(latestTrade.dealDate)} · ${formatPyeong(latestTrade.exclusiveArea)}`
              : "선택 기간 거래 없음"}
        />
        <LabKpiCard
          label="기간 최고가"
          value={periodMax > 0 ? formatEok(periodMax) : "—"}
          hint="선택 기간·면적 기준"
        />
        <LabKpiCard
          label="최고가 대비"
          value={vsMaxPct == null
            ? "—"
            : `${vsMaxPct > 0 ? "↑ +" : vsMaxPct < 0 ? "↓ " : ""}${vsMaxPct}%`}
          valueClassName={
              vsMaxPct == null
                ? "!text-slate-400"
                : vsMaxPct < 0
                  ? "!text-blue-600"
                  : vsMaxPct > 0
                    ? "!text-rose-600"
                    : "!text-slate-700"
          }
          hint="최근 매매 기준"
        />
        <LabKpiCard
          label="기간 거래량"
          value={`매매 ${periodTradeCount}건`}
          hint={`전월세 ${periodRentCount}건`}
        />
      </div>

      <section className="lab-card p-4 sm:p-5">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-slate-900 sm:text-base">
              시세 추이
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              매매·전세 평균가와 월별 거래량
            </p>
          </div>
          {isExtendingHistory ? (
            <p className="inline-flex items-center gap-1.5 text-xs text-teal-700">
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
              과거 시세 추가 중…
            </p>
          ) : null}
        </div>

        <AptPriceChart points={chartPoints} />

        <PeriodRangeSlider
          months={chartMonths}
          startIndex={startIndex}
          endIndex={endIndex}
          activePreset={periodPreset === "custom" ? null : periodPreset}
          onChange={(start, end) => {
            setPeriodPreset("custom");
            setRangeOverride({ start, end });
          }}
          onRecentYears={setRecentYears}
          onFullRange={setFullRange}
        />
      </section>

      <section
        key={`trades-${areaKey}-${dealFilter}-${startYm}-${endYm}`}
        className="lab-card p-4 sm:p-5"
      >
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-slate-900 sm:text-base">
              거래이력
            </h2>
            <p className="mt-0.5 truncate text-xs text-slate-500">
              {areaKey === "all" || !selectedArea
                ? `전체 면적 · ${filtered.length.toLocaleString("ko-KR")}건`
                : `${formatPyeong(selectedArea.exclusiveArea)} (${formatExclusiveArea(selectedArea.exclusiveArea)}) · ${filtered.length.toLocaleString("ko-KR")}건`}
            </p>
          </div>

          <div className="flex shrink-0 gap-1 rounded-lg bg-slate-100 p-1">
            {(
              [
                ["all", "전체"],
                ["trade", "매매"],
                ["rent", "전월세"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setDealFilter(value)}
                className={`rounded-md px-3 py-1 text-xs font-medium transition ${
                  dealFilter === value
                    ? "bg-teal-700 text-white shadow-sm"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {grouped.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-300 px-4 py-10 text-center text-sm text-slate-500">
            선택한 조건의 거래가 없습니다.
          </p>
        ) : (
          <div className="flex flex-col gap-6">
            {grouped.map(([year, items]) => (
              <div key={year}>
                <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-800">
                  <CalendarDays className="h-4 w-4 text-teal-700" />
                  {year}년
                  <span className="font-normal text-slate-400">
                    {items.length.toLocaleString("ko-KR")}건
                  </span>
                </h3>
                <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200/80 bg-white">
                  {items.map((tx, idx) => (
                    <TradeHistoryRow key={`${tx.id}-${idx}`} tx={tx} />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

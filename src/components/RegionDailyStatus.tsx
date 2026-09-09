"use client";

import Link from "next/link";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { aptDetailHref } from "@/lib/molit/apt";
import type {
  RegionDailyDaySection,
  RegionDailyDaySummary,
  RegionDailyDeal,
  RegionDailyResponse,
} from "@/lib/molit/service";
import { seoulToday, yearMonthFromSeoulDate } from "@/lib/market/time";
import {
  CONTRACT_DATE_BASIS_HELP,
  CONTRACT_DATE_BASIS_LABEL,
  HISTORY_DATE_BASIS_HELP,
  HISTORY_INITIAL_DAY_COUNT,
  hiddenNewlySeenCount,
  increaseRatePct,
  koreanMonthDayLabel,
  koreanYearMonthLabel,
  LEGACY_FIRST_SEEN_NOTE,
  newlySeenSectionTitle,
  priorPeakAmount,
  recordDateDomId,
  regionMarketInsight,
  SEEN_DATE_BASIS_HELP,
  SEEN_DATE_BASIS_LABEL,
  shiftYearMonth,
  sortNewlySeenDeals,
  visibleNewlySeenDeals,
  volumeChangePct,
} from "@/lib/region/market-insight";
import { TypePriceSparkline } from "@/components/region/TypePriceSparkline";
import {
  formatDealDate,
  formatEok,
  formatSqmApproxPyeong,
} from "@/lib/utils/format";

async function fetchRegionPart(
  params: Record<string, string | undefined>,
): Promise<RegionDailyResponse> {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) qs.set(key, value);
  }
  const res = await fetch(`/api/region-daily?${qs.toString()}`);
  if (!res.ok) throw new Error("failed");
  return res.json();
}

function daysInMonth(ym: string): number {
  const year = Number(ym.slice(0, 4));
  const month = Number(ym.slice(4, 6));
  return new Date(year, month, 0).getDate();
}

function weekdayOfFirst(ym: string): number {
  const year = Number(ym.slice(0, 4));
  const month = Number(ym.slice(4, 6));
  return new Date(year, month - 1, 1).getDay();
}

function contractLine(date: string): string {
  return `계약 ${formatDealDate(date)}`;
}

function specLine(deal: RegionDailyDeal): string {
  return `${formatSqmApproxPyeong(deal.exclusiveArea)} · ${deal.floor}층`;
}

function monthOptions(): string[] {
  const current = yearMonthFromSeoulDate(seoulToday());
  return Array.from({ length: 6 }, (_, i) => shiftYearMonth(current, -i));
}

function FeaturedDealCard({
  deal,
  regionSlug,
}: {
  deal: RegionDailyDeal;
  regionSlug: string;
}) {
  const prior = priorPeakAmount(deal);
  const rate = increaseRatePct(deal);
  const trend = deal.priceTrend;
  const titleMeta = [
    deal.dong || null,
    deal.buildYear ? `${deal.buildYear}년 준공` : null,
  ].filter(Boolean);

  return (
    <Link
      href={aptDetailHref(deal.aptName, regionSlug, deal.gu)}
      className="block rounded-xl border border-slate-200 border-l-[3px] border-l-teal-600 bg-white px-3 py-2.5 transition hover:border-slate-300 hover:bg-slate-50"
    >
      <div className="flex items-start justify-between gap-2">
        <strong className="block min-w-0 flex-1 text-[17px] font-bold leading-snug text-slate-900 line-clamp-2">
          {deal.aptName}
        </strong>
        <span className="inline-flex shrink-0 items-center rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-700">
          신고가
        </span>
      </div>
      {titleMeta.length > 0 ? (
        <p className="mt-1.5 truncate text-xs font-normal text-slate-500">
          {titleMeta.join(" · ")}
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-[22px] font-semibold leading-none tabular-nums text-slate-900">
          {formatEok(deal.dealAmount)}
        </span>
        {deal.increaseAmount > 0 ? (
          <span className="whitespace-nowrap text-sm font-medium tabular-nums text-rose-600">
            ▲ {formatEok(deal.increaseAmount)}
            {rate != null ? ` (+${rate}%)` : ""}
          </span>
        ) : null}
      </div>
      {prior != null ? (
        <p className="mt-1 text-[12px] tabular-nums text-slate-500">
          종전 최고 {formatEok(prior)}
        </p>
      ) : null}
      <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[12px] leading-4">
        <span className="whitespace-nowrap font-medium text-slate-800">
          {specLine(deal)}
        </span>
        <span className="text-slate-500">
          {contractLine(deal.dealDate)} · {deal.dealingGbn || "중개거래"}
        </span>
      </div>
      {trend && trend.length >= 3 ? (
        <TypePriceSparkline
          points={trend}
          currentAmount={deal.dealAmount}
          currentDate={deal.dealDate}
        />
      ) : null}
    </Link>
  );
}

function RegularDealCard({
  deal,
  regionSlug,
}: {
  deal: RegionDailyDeal;
  regionSlug: string;
}) {
  return (
    <Link
      href={aptDetailHref(deal.aptName, regionSlug, deal.gu)}
      className="block rounded-xl border border-slate-200 bg-white px-3 py-2.5 transition hover:border-slate-300 hover:bg-slate-50"
    >
      <p className="truncate text-sm font-semibold text-slate-900">
        {deal.aptName}
      </p>
      <p className="mt-1.5 text-lg font-semibold tabular-nums leading-none text-slate-900">
        {formatEok(deal.dealAmount)}
      </p>
      <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[12px] leading-4">
        <span className="whitespace-nowrap font-medium text-slate-800">
          {specLine(deal)}
        </span>
        <span className="text-slate-500">
          {contractLine(deal.dealDate)} · {deal.dealingGbn || "중개거래"}
        </span>
      </div>
    </Link>
  );
}

function DealGrid({
  deals,
  regionSlug,
}: {
  deals: RegionDailyDeal[];
  regionSlug: string;
}) {
  const sorted = sortNewlySeenDeals(deals);
  return (
    <div
      className={
        sorted.length > 1
          ? "mt-2 grid grid-cols-1 gap-2 lg:grid-cols-2"
          : "mt-2 flex flex-col gap-2"
      }
    >
      {sorted.map((deal) =>
        deal.singogaKind ? (
          <FeaturedDealCard
            key={deal.id}
            deal={deal}
            regionSlug={regionSlug}
          />
        ) : (
          <RegularDealCard
            key={deal.id}
            deal={deal}
            regionSlug={regionSlug}
          />
        ),
      )}
    </div>
  );
}

function DateBasisNote({
  label,
  help,
}: {
  label: string;
  help: string;
}) {
  return (
    <details className="text-xs text-slate-500">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-slate-600 marker:content-none">
        {label}
        <span className="text-[10px] text-slate-400" aria-hidden="true">
          ⓘ
        </span>
      </summary>
      <p className="mt-1 max-w-xl text-pretty leading-5">{help}</p>
    </details>
  );
}

function MonthPager({
  value,
  options,
  onChange,
}: {
  value: string;
  options: string[];
  onChange: (next: string) => void;
}) {
  const canPrev = options.includes(shiftYearMonth(value, -1));
  const canNext = options.includes(shiftYearMonth(value, 1));
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        disabled={!canPrev}
        onClick={() => onChange(shiftYearMonth(value, -1))}
        className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 transition hover:bg-slate-50 disabled:opacity-40"
        aria-label="이전 달"
      >
        <ChevronLeft className="h-4 w-4" />
      </button>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-800 outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20"
      >
        {options.map((ym) => (
          <option key={ym} value={ym}>
            {koreanYearMonthLabel(ym)}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={!canNext}
        onClick={() => onChange(shiftYearMonth(value, 1))}
        className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 transition hover:bg-slate-50 disabled:opacity-40"
        aria-label="다음 달"
      >
        <ChevronRight className="h-4 w-4" />
      </button>
    </div>
  );
}

function MonthCalendar({
  yearMonth,
  days,
  selectedDate,
  onSelectDate,
}: {
  yearMonth: string;
  days: RegionDailyDaySummary[];
  selectedDate: string | null;
  onSelectDate: (date: string) => void;
}) {
  const byDate = useMemo(() => {
    const map = new Map<string, RegionDailyDaySummary>();
    for (const day of days) map.set(day.date, day);
    return map;
  }, [days]);

  const totalDays = daysInMonth(yearMonth);
  const offset = weekdayOfFirst(yearMonth);
  const year = yearMonth.slice(0, 4);
  const monthNum = Number(yearMonth.slice(4, 6));
  const month = yearMonth.slice(4, 6);
  const cells: Array<number | null> = [
    ...Array.from({ length: offset }, () => null),
    ...Array.from({ length: totalDays }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);
  const weekLabels = ["일", "월", "화", "수", "목", "금", "토"];

  return (
    <div className="max-w-md rounded-xl border border-slate-200 bg-white p-2 sm:p-2.5">
      <div className="mb-1 grid grid-cols-7 text-center text-[10px] font-medium text-slate-400">
        {weekLabels.map((label) => (
          <div key={label} className="py-0.5">
            {label}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-0.5">
        {cells.map((day, idx) => {
          if (!day) return <div key={`e-${idx}`} className="min-h-10" />;
          const date = `${year}-${month}-${String(day).padStart(2, "0")}`;
          const summary = byDate.get(date);
          const dealCount = summary?.dealCount ?? 0;
          const hasDeals = dealCount > 0;
          const hasSingoga =
            Boolean(summary?.singogaKnown) && (summary?.singogaCount ?? 0) > 0;
          const active = selectedDate === date;
          if (!hasDeals) {
            return (
              <div
                key={date}
                className="flex min-h-10 flex-col items-center justify-center rounded-md text-sm text-slate-300 sm:min-h-11"
                aria-hidden="true"
              >
                <span>{day}</span>
              </div>
            );
          }
          return (
            <button
              key={date}
              type="button"
              onClick={() => onSelectDate(date)}
              aria-label={`${monthNum}월 ${day}일 새로 확인된 거래 ${dealCount}건${hasSingoga ? ", 신고가 있음" : ""}`}
              aria-pressed={active}
              className={`relative flex min-h-10 flex-col items-center justify-center rounded-md text-sm transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400 sm:min-h-11 ${
                active
                  ? "bg-slate-800 text-white"
                  : "bg-slate-50 text-slate-800 hover:bg-slate-100"
              }`}
            >
              <span className="font-medium leading-none">{day}</span>
              <span
                className={`mt-0.5 text-[10px] leading-none ${
                  active ? "text-slate-200" : "text-slate-500"
                }`}
              >
                {dealCount}
                <span className="sr-only">건</span>
              </span>
              {hasSingoga ? (
                <span
                  className={`mt-0.5 h-1 w-1 rounded-full ${
                    active ? "bg-teal-200" : "bg-teal-600"
                  }`}
                  aria-hidden="true"
                />
              ) : (
                <span className="mt-0.5 h-1 w-1" aria-hidden="true" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Kpi({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-2.5 py-2">
      <p className="text-[11px] text-slate-500">{label}</p>
      <p className="mt-0.5 text-[15px] font-semibold tabular-nums text-slate-900 sm:text-base">
        {value}
      </p>
      {hint ? (
        <p className="mt-0.5 text-[11px] tabular-nums text-slate-500">{hint}</p>
      ) : null}
    </div>
  );
}

function dayCountLine(section: RegionDailyDaySection): string {
  const n = section.totalCount.toLocaleString("ko-KR");
  if (section.bulkIngestDay || !section.singogaKnown) {
    return `${n}건`;
  }
  return `${n}건 · 신고가 ${section.singogaCount.toLocaleString("ko-KR")}건`;
}

function scrollToDateHeading(date: string) {
  const el = document.getElementById(recordDateDomId(date));
  if (!el) return false;
  const reduce =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({
    behavior: reduce ? "auto" : "smooth",
    block: "start",
  });
  return true;
}

export function RegionDailyStatus({
  regionSlug,
  regionName,
}: {
  regionSlug: string;
  regionName: string;
}) {
  const yearMonths = useMemo(() => monthOptions(), []);
  const [contractMonth, setContractMonth] = useState(
    () => yearMonthFromSeoulDate(seoulToday()),
  );
  const [activityMonthUser, setActivityMonthUser] = useState<string | null>(
    null,
  );
  const [heroExpanded, setHeroExpanded] = useState(false);
  const [visibleDayCount, setVisibleDayCount] = useState(
    HISTORY_INITIAL_DAY_COUNT,
  );
  const [clickedDates, setClickedDates] = useState<string[]>([]);
  const [calendarSelected, setCalendarSelected] = useState<string | null>(null);
  const [flashDate, setFlashDate] = useState<string | null>(null);
  const [flashNonce, setFlashNonce] = useState(0);
  const [bulkExtra, setBulkExtra] = useState<Record<string, RegionDailyDeal[]>>(
    {},
  );
  const pendingScroll = useRef<string | null>(null);

  const marketQuery = useQuery({
    queryKey: ["region-market", regionSlug, contractMonth],
    queryFn: () =>
      fetchRegionPart({
        region: regionSlug,
        part: "market",
        contractMonth,
      }),
    staleTime: 60_000,
    retry: 1,
  });

  const latestQuery = useQuery({
    queryKey: ["region-latest", regionSlug],
    queryFn: () =>
      fetchRegionPart({
        region: regionSlug,
        part: "latest",
      }),
    staleTime: 60_000,
    retry: 1,
  });

  const latest = latestQuery.data;
  const activityMonth =
    activityMonthUser ??
    (latest?.selectedDate
      ? yearMonthFromSeoulDate(latest.selectedDate)
      : yearMonthFromSeoulDate(seoulToday()));

  const historyQuery = useQuery({
    queryKey: ["region-history", regionSlug, activityMonth],
    queryFn: () =>
      fetchRegionPart({
        region: regionSlug,
        part: "history",
        yearMonth: activityMonth,
      }),
    staleTime: 60_000,
    retry: 1,
  });

  const historyDays = historyQuery.data?.days ?? [];
  const activeDates = historyDays
    .filter((d) => d.dealCount > 0)
    .map((d) => d.date);
  const windowDates = activeDates.slice(0, visibleDayCount);
  const fetchDates = [
    ...new Set([...windowDates, ...clickedDates.filter((d) => activeDates.includes(d))]),
  ];

  const daysQuery = useQuery({
    queryKey: ["region-history-days", regionSlug, activityMonth, fetchDates.join(",")],
    queryFn: () =>
      fetchRegionPart({
        region: regionSlug,
        part: "days",
        yearMonth: activityMonth,
        dates: fetchDates.join(","),
      }),
    enabled: fetchDates.length > 0,
    staleTime: 60_000,
    retry: 1,
  });

  const sectionByDate = useMemo(() => {
    const map = new Map<string, RegionDailyDaySection>();
    for (const section of daysQuery.data?.historySections ?? []) {
      const extra = bulkExtra[section.date] ?? [];
      map.set(section.date, {
        ...section,
        deals: extra.length ? [...section.deals, ...extra] : section.deals,
      });
    }
    return map;
  }, [daysQuery.data, bulkExtra]);

  useLayoutEffect(() => {
    const date = pendingScroll.current;
    if (!date) return;
    if (!document.getElementById(recordDateDomId(date))) return;
    pendingScroll.current = null;
    scrollToDateHeading(date);
  }, [daysQuery.data, visibleDayCount, clickedDates]);

  const market = marketQuery.data;
  const insight = market
    ? regionMarketInsight({
        monthTradeCount: market.monthTradeCount,
        prevMonthTradeCount: market.prevMonthTradeCount,
        singogaCount: null,
        comparePartial: market.comparePartial,
      })
    : null;
  const volumePct =
    market != null
      ? volumeChangePct(market.monthTradeCount, market.prevMonthTradeCount)
      : null;

  const heroDeals = useMemo(
    () => sortNewlySeenDeals(latest?.deals ?? []),
    [latest],
  );
  const heroVisible = visibleNewlySeenDeals(heroDeals, heroExpanded);
  const heroHidden = hiddenNewlySeenCount(heroDeals, heroExpanded);
  const heroDate = latest?.selectedDate ?? null;
  const heroIsToday = Boolean(latest?.latestIsToday);

  function changeActivityMonth(next: string) {
    setActivityMonthUser(next);
    setVisibleDayCount(HISTORY_INITIAL_DAY_COUNT);
    setClickedDates([]);
    setCalendarSelected(null);
    setBulkExtra({});
  }

  function selectCalendarDate(date: string) {
    setCalendarSelected(date);
    setFlashDate(date);
    setFlashNonce((n) => n + 1);
    pendingScroll.current = date;
    const idx = activeDates.indexOf(date);
    if (idx >= visibleDayCount) {
      setVisibleDayCount(idx + 1);
    }
    if (scrollToDateHeading(date)) {
      pendingScroll.current = null;
    } else {
      setClickedDates((prev) => (prev.includes(date) ? prev : [...prev, date]));
    }
  }

  async function loadMoreBulk(section: RegionDailyDaySection) {
    const offset = section.deals.length;
    const data = await fetchRegionPart({
      region: regionSlug,
      part: "days",
      yearMonth: activityMonth,
      dates: section.date,
      offset: String(offset),
    });
    const next = data.historySections.find((s) => s.date === section.date);
    if (!next) return;
    setBulkExtra((prev) => ({
      ...prev,
      [section.date]: [...(prev[section.date] ?? []), ...next.deals],
    }));
  }

  const remainingDates = Math.max(0, activeDates.length - visibleDayCount);
  const calendarDays = (daysQuery.data?.days ?? historyDays).map((day) => {
    const section = sectionByDate.get(day.date);
    if (!section) return day;
    return {
      ...day,
      singogaCount: section.singogaCount,
      singogaKnown: section.singogaKnown,
      bulkIngestDay: section.bulkIngestDay,
    };
  });

  return (
    <div className="flex min-h-[min(70vh,42rem)] flex-col gap-8 sm:gap-10">
      <section aria-label={`${regionName} 아파트 시장 현황`} className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <h2 className="text-sm font-semibold text-slate-900">
            {regionName} 아파트 시장 현황
          </h2>
          <MonthPager
            value={contractMonth}
            options={yearMonths}
            onChange={setContractMonth}
          />
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
          <span>{koreanYearMonthLabel(contractMonth)}</span>
          <span className="text-slate-300">·</span>
          <DateBasisNote
            label={CONTRACT_DATE_BASIS_LABEL}
            help={CONTRACT_DATE_BASIS_HELP}
          />
        </div>
        {marketQuery.isError ? (
          <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            시장 현황을 불러오지 못했습니다.
          </p>
        ) : null}
        {marketQuery.isLoading && !market ? (
          <div className="h-24 animate-pulse rounded-xl border border-slate-200 bg-slate-50" />
        ) : market ? (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <Kpi
                label="거래"
                value={`${market.monthTradeCount.toLocaleString("ko-KR")}건`}
                hint={market.comparePartial ? "오늘까지" : undefined}
              />
              <Kpi
                label="중위 거래가"
                value={
                  market.medianDealAmount
                    ? formatEok(market.medianDealAmount)
                    : "—"
                }
              />
              <Kpi
                label="전월 같은 기간"
                value={
                  volumePct == null
                    ? "—"
                    : `${volumePct > 0 ? "+" : ""}${volumePct}%`
                }
                hint={
                  market.prevMonthTradeCount > 0
                    ? `${market.prevMonthTradeCount.toLocaleString("ko-KR")}건`
                    : "비교할 전월 거래 없음"
                }
              />
            </div>
            {insight ? (
              <p className="text-sm leading-6 text-pretty text-slate-600">
                {insight}
              </p>
            ) : null}
          </>
        ) : null}
      </section>

      <section
        id="newly-seen-deals"
        aria-label={`${regionName} 새로 확인된 거래`}
        className="flex flex-col gap-2"
      >
        <h2 className="text-sm font-semibold text-slate-900">
          {heroDate
            ? newlySeenSectionTitle(heroIsToday)
            : "새로 확인된 거래"}
        </h2>
        <DateBasisNote
          label={SEEN_DATE_BASIS_LABEL}
          help={SEEN_DATE_BASIS_HELP}
        />
        {latestQuery.isError ? (
          <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            새로 확인된 거래를 불러오지 못했습니다.
          </p>
        ) : null}
        {latestQuery.isLoading && !latest ? (
          <div className="h-40 animate-pulse rounded-xl border border-slate-200 bg-slate-50" />
        ) : heroDate && heroDeals.length > 0 ? (
          <>
            {heroIsToday ? (
              <p className="text-xs tabular-nums text-slate-500">
                {koreanMonthDayLabel(heroDate)} · 총{" "}
                {(latest?.tradeCount ?? heroDeals.length).toLocaleString("ko-KR")}건
                {latest?.bulkIngestDay
                  ? " · 신고가 계산 생략"
                  : ` · 신고가 ${(latest?.selectedDaySingogaCount ?? 0).toLocaleString("ko-KR")}건`}
              </p>
            ) : (
              <div className="text-xs leading-5 text-slate-500">
                <p>오늘 새로 확인된 거래는 아직 없습니다</p>
                <p className="mt-0.5 tabular-nums">
                  최근 확인 {koreanMonthDayLabel(heroDate)} · 총{" "}
                  {(latest?.tradeCount ?? heroDeals.length).toLocaleString("ko-KR")}건
                  {latest?.bulkIngestDay
                    ? " · 신고가 계산 생략"
                    : ` · 신고가 ${(latest?.selectedDaySingogaCount ?? 0).toLocaleString("ko-KR")}건`}
                </p>
              </div>
            )}
            {latest?.bulkIngestDay ? (
              <p className="text-pretty text-xs leading-5 text-slate-500">
                이날 확인 건수가 많아 신고가 강조는 생략했습니다. 신고가가 0건이라는 뜻은 아닙니다.
              </p>
            ) : null}
            <DealGrid deals={heroVisible} regionSlug={regionSlug} />
            {heroHidden > 0 ? (
              <button
                type="button"
                onClick={() => setHeroExpanded(true)}
                className="mt-1 inline-flex min-h-9 items-center rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
              >
                더보기 {heroHidden.toLocaleString("ko-KR")}건
              </button>
            ) : null}
          </>
        ) : (
          <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center text-pretty text-sm text-slate-500">
            {latest?.firstSeenReady
              ? "새로 확인된 매매가 없습니다."
              : LEGACY_FIRST_SEEN_NOTE}
          </div>
        )}
      </section>

      <section aria-label={`${regionName} 거래 내역`} className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <h2 className="text-sm font-semibold text-slate-900">거래 내역</h2>
          <MonthPager
            value={activityMonth}
            options={yearMonths}
            onChange={changeActivityMonth}
          />
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
          <span>{koreanYearMonthLabel(activityMonth)}</span>
          <span className="text-slate-300">·</span>
          <DateBasisNote
            label={SEEN_DATE_BASIS_LABEL}
            help={HISTORY_DATE_BASIS_HELP}
          />
        </div>

        <div>
          <div className="mb-2 inline-flex items-center gap-1.5 text-sm text-slate-600">
            <CalendarDays className="h-4 w-4 text-teal-700" />
            <h3 className="text-sm font-semibold text-slate-900">
              새로 확인된 거래 달력
            </h3>
          </div>
          <p className="mb-2 text-pretty text-xs leading-5 text-slate-500">
            숫자는 그날 새로 확인된 매매 건수입니다. 작은 점은 신고가가 확인된 날짜입니다.
          </p>
          <MonthCalendar
            yearMonth={activityMonth}
            days={calendarDays}
            selectedDate={calendarSelected}
            onSelectDate={selectCalendarDate}
          />
        </div>

        <div className="flex flex-col gap-5">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">
              {koreanYearMonthLabel(activityMonth)} 새로 확인된 거래
            </h3>
            <p className="mt-0.5 text-xs tabular-nums text-slate-500">
              총 {(historyQuery.data?.historyTotalCount ?? 0).toLocaleString("ko-KR")}건
            </p>
          </div>
          {!latest?.firstSeenReady && historyQuery.data && historyDays.length === 0 ? (
            <p className="text-pretty text-xs leading-5 text-slate-500">
              {LEGACY_FIRST_SEEN_NOTE}
            </p>
          ) : null}
          {activeDates.length === 0 && historyQuery.data ? (
            <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center text-pretty text-sm text-slate-500">
              이 달에 새로 확인된 매매가 없습니다.
            </div>
          ) : null}
          {activeDates.slice(0, visibleDayCount).map((date) => {
            const section = sectionByDate.get(date);
            const summary = calendarDays.find((d) => d.date === date);
            const headingClass =
              flashDate === date ? "region-date-flash rounded-md px-1 -mx-1" : "px-1 -mx-1";
            return (
              <div key={date}>
                <h4
                  key={flashDate === date ? `${date}-flash-${flashNonce}` : date}
                  id={recordDateDomId(date)}
                  className={`scroll-mt-[calc(var(--site-header-height,3.5rem)+0.75rem)] text-sm font-semibold text-slate-900 ${headingClass}`}
                >
                  {koreanMonthDayLabel(date)}
                </h4>
                <p className="mt-0.5 text-xs tabular-nums text-slate-500">
                  {section
                    ? dayCountLine(section)
                    : `${(summary?.dealCount ?? 0).toLocaleString("ko-KR")}건`}
                </p>
                {section?.bulkIngestDay ? (
                  <p className="mt-1 text-pretty text-xs leading-5 text-slate-500">
                    확인 건수가 많아 신고가 강조는 생략했습니다. 초기 적재로 하루에 많은 거래가 확인된 날일 수 있습니다.
                  </p>
                ) : null}
                {section ? (
                  <>
                    <DealGrid deals={section.deals} regionSlug={regionSlug} />
                    {section.hasMore ||
                    (section.bulkIngestDay &&
                      section.deals.length < section.totalCount) ? (
                      <button
                        type="button"
                        onClick={() => loadMoreBulk(section)}
                        className="mt-2 inline-flex min-h-9 items-center rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
                      >
                        더보기{" "}
                        {(section.totalCount - section.deals.length).toLocaleString(
                          "ko-KR",
                        )}
                        건
                      </button>
                    ) : null}
                  </>
                ) : daysQuery.isFetching ? (
                  <div className="mt-2 h-16 animate-pulse rounded-xl border border-slate-200 bg-slate-50" />
                ) : null}
              </div>
            );
          })}
          {remainingDates > 0 ? (
            <button
              type="button"
              onClick={() =>
                setVisibleDayCount((n) => n + HISTORY_INITIAL_DAY_COUNT)
              }
              className="inline-flex min-h-9 items-center self-start rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
            >
              더 이전 확인일 보기 {remainingDates.toLocaleString("ko-KR")}일
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
}

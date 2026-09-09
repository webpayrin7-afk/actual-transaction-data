"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { aptDetailHref } from "@/lib/molit/apt";
import type {
  RegionDailyDaySummary,
  RegionDailyDeal,
  RegionDailyResponse,
} from "@/lib/molit/service";
import {
  compactSingogaDeals,
  featuredSingogaGroup,
  groupDealsByDate,
  increaseRatePct,
  latestRecordDate,
  priorPeakAmount,
  recordDateDomId,
  regionMarketInsight,
  COMPACT_SINGOGA_LIMIT,
  shiftYearMonth,
  volumeChangePct,
} from "@/lib/region/market-insight";
import { TypePriceSparkline } from "@/components/region/TypePriceSparkline";
import {
  formatArea,
  formatDealDate,
  formatEok,
  yearMonthLabel,
} from "@/lib/utils/format";

async function fetchRegionDaily(params: {
  region: string;
  yearMonth: string;
}): Promise<RegionDailyResponse> {
  const qs = new URLSearchParams({
    region: params.region,
    yearMonth: params.yearMonth,
  });
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

function singogaLabel(kind: RegionDailyDeal["singogaKind"]): string {
  if (kind === "type") return "타입신고가";
  if (kind === "pyeong") return "평형신고가";
  return "신고가";
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function contractDayLabel(date: string): string {
  const d = date.slice(0, 10);
  return `${Number(d.slice(5, 7))}월 ${Number(d.slice(8, 10))}일 계약`;
}

function DealBadges({ deal }: { deal: RegionDailyDeal }) {
  const isComplexHigh =
    deal.complexMaxAmount > 0 && deal.dealAmount === deal.complexMaxAmount;
  return (
    <div className="flex shrink-0 flex-wrap justify-end gap-1">
      <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-700">
        {singogaLabel(deal.singogaKind)}
      </span>
      {isComplexHigh ? (
        <span className="inline-flex items-center rounded-full bg-teal-50 px-2 py-0.5 text-[10px] font-medium text-teal-800">
          단지 최고가
        </span>
      ) : null}
    </div>
  );
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
  const extras = [
    deal.recent3mCount > 0 ? `최근 3개월 ${deal.recent3mCount}건` : null,
    deal.buildYear ? `${deal.buildYear}년 준공` : null,
  ].filter(Boolean);
  const trend = deal.priceTrend;

  return (
    <Link
      href={aptDetailHref(deal.aptName, regionSlug, deal.gu)}
      className="block rounded-xl border border-teal-200/80 bg-teal-50/40 px-3 py-3 transition hover:border-teal-300 hover:bg-teal-50/70"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 truncate text-sm font-semibold text-slate-900">
          {deal.aptName}
        </p>
        <DealBadges deal={deal} />
      </div>
      <p className="mt-1.5 text-[22px] font-semibold leading-none tabular-nums text-slate-900">
        {formatEok(deal.dealAmount)}
      </p>
      {deal.increaseAmount > 0 ? (
        <p className="mt-1.5 text-sm font-medium tabular-nums text-rose-600">
          ▲ {formatEok(deal.increaseAmount)}
          {rate != null ? ` (+${rate}%)` : ""}
        </p>
      ) : null}
      {prior != null ? (
        <p className="mt-0.5 text-[12px] tabular-nums text-slate-500">
          종전 최고 {formatEok(prior)}
        </p>
      ) : null}
      <p className="mt-2 text-[12px] text-slate-600">
        {Number(deal.exclusiveArea).toFixed(2)}㎡ · {deal.floor}층 ·{" "}
        {contractDayLabel(deal.dealDate)}
      </p>
      {extras.length > 0 ? (
        <p className="mt-1 text-[11px] text-slate-500">{extras.join(" · ")}</p>
      ) : null}
          {trend && trend.length >= 2 ? (
            <TypePriceSparkline
              points={trend}
              currentAmount={deal.dealAmount}
              currentDate={deal.dealDate}
            />
          ) : null}
    </Link>
  );
}

function CompactDealRow({
  deal,
  regionSlug,
}: {
  deal: RegionDailyDeal;
  regionSlug: string;
}) {
  const md = Number(deal.dealDate.slice(5, 7));
  const dd = Number(deal.dealDate.slice(8, 10));
  return (
    <Link
      href={aptDetailHref(deal.aptName, regionSlug, deal.gu)}
      className="flex items-center justify-between gap-3 border-b border-slate-100 px-1 py-2 last:border-b-0 transition hover:bg-slate-50"
    >
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-slate-800">
          {deal.aptName}
        </p>
        <p className="text-[11px] text-slate-500">
          {Math.round(deal.exclusiveArea)}㎡ · {md}월 {dd}일 계약
        </p>
      </div>
      <div className="shrink-0 text-right">
        <p className="text-sm font-semibold tabular-nums text-slate-900">
          {formatEok(deal.dealAmount)}
        </p>
        {deal.increaseAmount > 0 ? (
          <p className="text-[11px] font-medium tabular-nums text-rose-600">
            ▲ {formatEok(deal.increaseAmount)}
          </p>
        ) : null}
      </div>
    </Link>
  );
}

function DealCard({
  deal,
  regionSlug,
}: {
  deal: RegionDailyDeal;
  regionSlug: string;
}) {
  const isComplexHigh =
    deal.complexMaxAmount > 0 && deal.dealAmount === deal.complexMaxAmount;
  const comparison =
    deal.increaseAmount > 0
      ? `종전 최고 +${formatEok(deal.increaseAmount)}원`
      : isComplexHigh
        ? "단지 최고가"
        : null;

  return (
    <Link
      href={aptDetailHref(deal.aptName, regionSlug, deal.gu)}
      className="block rounded-xl border border-slate-200 bg-white px-3 py-2.5 transition hover:border-slate-300 hover:bg-slate-50"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-slate-900">
            {deal.aptName}
          </p>
          <p className="mt-0.5 truncate text-[11px] text-slate-500">
            {deal.dong} · {formatArea(deal.exclusiveArea)} · {deal.floor}층
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-base font-semibold tabular-nums text-slate-900">
            {formatEok(deal.dealAmount)}
          </p>
        </div>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-500">
        <span>{formatDealDate(deal.dealDate)}</span>
        <span className="text-slate-300">·</span>
        <span>{singogaLabel(deal.singogaKind)}</span>
        {comparison ? (
          <>
            <span className="text-slate-300">·</span>
            <span
              className={
                deal.increaseAmount > 0 ? "font-medium text-rose-600" : undefined
              }
            >
              {comparison}
            </span>
          </>
        ) : null}
      </div>
    </Link>
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
              onClick={(e) => {
                e.currentTarget.blur();
                onSelectDate(date);
              }}
              aria-label={`${monthNum}월 ${day}일 신고가 ${dealCount}건 보기`}
              aria-pressed={active}
              className={`relative flex min-h-10 flex-col items-center justify-center rounded-md text-sm transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600 sm:min-h-11 ${
                active
                  ? "bg-teal-700 text-white"
                  : "bg-teal-50 text-teal-900 hover:bg-teal-100"
              }`}
            >
              <span className="font-medium leading-none">{day}</span>
              <span
                className={`mt-0.5 text-[10px] leading-none ${
                  active ? "text-teal-100" : "text-teal-700"
                }`}
              >
                {dealCount}
                <span className="sr-only">건</span>
              </span>
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

export function RegionDailyStatus({
  regionSlug,
  regionName,
  yearMonth,
  yearMonths,
  onYearMonthChange,
}: {
  regionSlug: string;
  regionName: string;
  yearMonth: string;
  yearMonths: string[];
  onYearMonthChange: (value: string) => void;
}) {
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [highlightDate, setHighlightDate] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ["region-daily", regionSlug, yearMonth],
    queryFn: () =>
      fetchRegionDaily({
        region: regionSlug,
        yearMonth,
      }),
    staleTime: 60_000,
    retry: 1,
  });

  const data = query.data;
  const monthDeals = useMemo(() => data?.monthDeals ?? [], [data]);
  const featuredDate = useMemo(
    () => latestRecordDate(monthDeals),
    [monthDeals],
  );
  const featuredDeals = useMemo(
    () => featuredSingogaGroup(monthDeals),
    [monthDeals],
  );
  const compactDeals = useMemo(
    () =>
      compactSingogaDeals(monthDeals, featuredDate, COMPACT_SINGOGA_LIMIT),
    [monthDeals, featuredDate],
  );
  const grouped = useMemo(() => groupDealsByDate(monthDeals), [monthDeals]);

  const insight = data
    ? regionMarketInsight({
        monthTradeCount: data.monthTradeCount,
        prevMonthTradeCount: data.prevMonthTradeCount,
        singogaCount: monthDeals.length,
        comparePartial: data.comparePartial,
      })
    : null;

  const volumePct =
    data != null
      ? volumeChangePct(data.monthTradeCount, data.prevMonthTradeCount)
      : null;

  const canPrev = yearMonths.includes(shiftYearMonth(yearMonth, -1));
  const canNext = yearMonths.includes(shiftYearMonth(yearMonth, 1));

  function changeMonth(nextYm: string) {
    setSelectedDate(null);
    setHighlightDate(null);
    onYearMonthChange(nextYm);
  }

  function selectRecordDate(date: string) {
    setSelectedDate(date);
    const el = document.getElementById(recordDateDomId(date));
    if (!el) return;
    const reduce = prefersReducedMotion();
    const headerRaw = getComputedStyle(document.documentElement)
      .getPropertyValue("--site-header-height")
      .trim();
    const headerPx = Number.parseFloat(headerRaw) || 56;
    const top =
      window.scrollY + el.getBoundingClientRect().top - headerPx - 12;
    const distance = Math.abs(top - window.scrollY);
    window.scrollTo({
      top: Math.max(0, top),
      behavior: reduce || distance > 800 ? "auto" : "smooth",
    });
    if (!reduce) {
      setHighlightDate(date);
    }
  }

  useEffect(() => {
    if (!highlightDate) return;
    const id = window.setTimeout(() => setHighlightDate(null), 1600);
    return () => window.clearTimeout(id);
  }, [highlightDate]);

  const latestSingogaDate = grouped[0]?.date ?? null;

  return (
    <div className="flex min-h-[min(70vh,42rem)] flex-col gap-5 sm:gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-600">
          <span className="font-medium text-slate-800">
            {yearMonthLabel(yearMonth)}
          </span>
          <span className="text-slate-400"> · </span>
          매매 계약일 기준
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={!canPrev}
            onClick={() => changeMonth(shiftYearMonth(yearMonth, -1))}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 transition hover:bg-slate-50 disabled:opacity-40"
            aria-label="이전 달"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <select
            value={yearMonth}
            onChange={(e) => changeMonth(e.target.value)}
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20"
          >
            {yearMonths.map((ym) => (
              <option key={ym} value={ym}>
                {yearMonthLabel(ym)}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={!canNext}
            onClick={() => changeMonth(shiftYearMonth(yearMonth, 1))}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 transition hover:bg-slate-50 disabled:opacity-40"
            aria-label="다음 달"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      {query.isError && (
        <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          일별 신고가를 불러오지 못했습니다.
        </p>
      )}

      {data?.warning ? (
        <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {data.warning}
        </p>
      ) : null}

      {query.isLoading && !data ? (
        <div className="flex flex-col gap-5 sm:gap-6" aria-hidden="true">
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                className="h-[4.25rem] animate-pulse rounded-xl border border-slate-200 bg-slate-50"
              />
            ))}
          </div>
          <div className="h-16 animate-pulse rounded-xl border border-slate-200 bg-slate-50" />
          <div className="h-20 animate-pulse rounded-xl border border-slate-200 bg-slate-50" />
        </div>
      ) : data ? (
        <>
          <section aria-label={`${regionName} 시장 요약`}>
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
              <Kpi
                label={data.comparePartial ? "이번 달 거래량" : "거래량"}
                value={`${data.monthTradeCount.toLocaleString("ko-KR")}건`}
                hint={
                  data.comparePartial ? "오늘까지" : undefined
                }
              />
              <Kpi
                label={data.comparePartial ? "전월 같은 기간" : "전월 대비"}
                value={
                  volumePct == null
                    ? "—"
                    : `${volumePct > 0 ? "+" : ""}${volumePct}%`
                }
                hint={
                  data.prevMonthTradeCount > 0
                    ? `${data.prevMonthTradeCount.toLocaleString("ko-KR")}건`
                    : "비교할 전월 거래 없음"
                }
              />
              <Kpi
                label="신고가"
                value={`${monthDeals.length.toLocaleString("ko-KR")}건`}
              />
              <Kpi
                label="최근 신고일"
                value={
                  latestSingogaDate
                    ? formatDealDate(latestSingogaDate)
                    : "—"
                }
              />
            </div>
            {insight ? (
              <p className="mt-2 text-sm leading-6 text-pretty text-slate-600">
                {insight}
              </p>
            ) : null}
          </section>

          <section>
            <h2 className="text-sm font-semibold text-slate-900">
              {regionName} 최근 신고가
            </h2>
            <p className="mt-0.5 text-pretty text-xs leading-5 text-slate-500">
              단지명을 누르면 상세로 이동합니다.
            </p>
            {featuredDeals.length === 0 ? (
              <div className="mt-2 rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center text-pretty text-sm text-slate-500">
                이 달 신고가가 없습니다.
              </div>
            ) : (
              <div className="mt-2 flex flex-col gap-2">
                <div
                  className={
                    featuredDeals.length > 1
                      ? "grid grid-cols-1 gap-2 lg:grid-cols-2"
                      : "flex flex-col gap-2"
                  }
                >
                  {featuredDeals.map((deal) => (
                    <FeaturedDealCard
                      key={`featured-${deal.id}`}
                      deal={deal}
                      regionSlug={regionSlug}
                    />
                  ))}
                </div>
                {compactDeals.length > 0 ? (
                  <div className="rounded-xl border border-slate-100 bg-white px-2">
                    {compactDeals.map((deal) => (
                      <CompactDealRow
                        key={`recent-${deal.id}`}
                        deal={deal}
                        regionSlug={regionSlug}
                      />
                    ))}
                  </div>
                ) : null}
              </div>
            )}
          </section>

          {monthDeals.length > 0 ? (
            <section>
              <div className="mb-2 inline-flex items-center gap-1.5 text-sm text-slate-600">
                <CalendarDays className="h-4 w-4 text-teal-700" />
                <h2 className="text-sm font-semibold text-slate-900">
                  신고가 달력
                </h2>
              </div>
              <p className="mb-2 text-pretty text-xs leading-5 text-slate-500">
                숫자 있는 날짜를 누르면 해당 일로 이동합니다.
              </p>
              <MonthCalendar
                yearMonth={data.yearMonth ?? yearMonth}
                days={data.days ?? []}
                selectedDate={selectedDate}
                onSelectDate={selectRecordDate}
              />
            </section>
          ) : null}

          {grouped.length > 0 ? (
            <section className="flex flex-col gap-4">
              <h2 className="text-sm font-semibold text-slate-900">
                {regionName} 아파트 거래 신고가
              </h2>
              {grouped.map((group) => {
                const active = highlightDate === group.date;
                return (
                  <div
                    key={group.date}
                    id={recordDateDomId(group.date)}
                    className={`scroll-mt-[calc(var(--site-header-height,3.5rem)+0.75rem)] rounded-xl transition ${
                      active ? "bg-teal-50/80 ring-1 ring-teal-200" : ""
                    }`}
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-2 px-0.5 pb-2">
                      <p className="text-sm font-medium text-slate-900">
                        {formatDealDate(group.date)}
                      </p>
                      <p className="text-xs text-slate-500">
                        신고가 {group.deals.length.toLocaleString("ko-KR")}건
                      </p>
                    </div>
                    <div className="flex flex-col gap-2">
                      {group.deals.map((deal) => (
                        <DealCard
                          key={deal.id}
                          deal={deal}
                          regionSlug={regionSlug}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

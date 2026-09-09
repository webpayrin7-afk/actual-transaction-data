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
  hiddenNewlySeenCount,
  increaseRatePct,
  koreanMonthDayLabel,
  priorPeakAmount,
  regionMarketInsight,
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
  yearMonthLabel,
} from "@/lib/utils/format";

async function fetchRegionDaily(params: {
  region: string;
  yearMonth: string;
  date?: string | null;
}): Promise<RegionDailyResponse> {
  const qs = new URLSearchParams({
    region: params.region,
    yearMonth: params.yearMonth,
  });
  if (params.date) qs.set("date", params.date);
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
          const singogaCount = summary?.singogaCount ?? 0;
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
              aria-label={`${monthNum}월 ${day}일 새로 확인된 거래 ${dealCount}건${singogaCount > 0 ? `, 신고가 ${singogaCount}건` : ""}`}
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
              {singogaCount > 0 ? (
                <span
                  className={`mt-0.5 h-1 w-1 rounded-full ${
                    active ? "bg-white" : "bg-teal-600"
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
  const [userDate, setUserDate] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const query = useQuery({
    queryKey: ["region-daily", regionSlug, yearMonth, userDate],
    queryFn: () =>
      fetchRegionDaily({
        region: regionSlug,
        yearMonth,
        date: userDate,
      }),
    staleTime: 60_000,
    retry: 1,
    placeholderData: (previous) => previous,
  });

  const data = query.data;

  useEffect(() => {
    if (!data) return;
    if (data.yearMonth && data.yearMonth !== yearMonth) {
      onYearMonthChange(data.yearMonth);
    }
  }, [data, yearMonth, onYearMonthChange]);

  useEffect(() => {
    setExpanded(false);
  }, [userDate, regionSlug, yearMonth]);

  const selectedDate = userDate ?? data?.selectedDate ?? null;
  const dayDeals = useMemo(
    () => sortNewlySeenDeals(data?.deals ?? []),
    [data],
  );

  const visibleDeals = useMemo(
    () => visibleNewlySeenDeals(dayDeals, expanded),
    [dayDeals, expanded],
  );
  const hiddenCount = hiddenNewlySeenCount(dayDeals, expanded);
  const daySingoga =
    data?.selectedDaySingogaCount ??
    dayDeals.filter((d) => d.singogaKind != null).length;

  const insight = data
    ? regionMarketInsight({
        monthTradeCount: data.monthTradeCount,
        prevMonthTradeCount: data.prevMonthTradeCount,
        singogaCount: null,
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
    setUserDate(null);
    setExpanded(false);
    onYearMonthChange(nextYm);
  }

  function selectSeenDate(date: string) {
    setUserDate(date);
    setExpanded(false);
    const el = document.getElementById("newly-seen-deals");
    if (!el) return;
    const headerRaw = getComputedStyle(document.documentElement)
      .getPropertyValue("--site-header-height")
      .trim();
    const headerPx = Number.parseFloat(headerRaw) || 56;
    const top =
      window.scrollY + el.getBoundingClientRect().top - headerPx - 12;
    window.scrollTo({ top: Math.max(0, top), behavior: "auto" });
  }

  const calendarYm = data?.yearMonth ?? yearMonth;

  return (
    <div className="flex min-h-[min(70vh,42rem)] flex-col gap-4 sm:gap-6">
      <div className="flex flex-col gap-2.5 sm:gap-4">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <p className="text-sm text-slate-600">
            <span className="font-medium text-slate-800">
              {yearMonthLabel(yearMonth)}
            </span>
            <span className="text-slate-400"> · </span>
            새로 확인된 거래
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
              className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-800 outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20"
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
            새로 확인된 거래를 불러오지 못했습니다.
          </p>
        )}

        {data?.warning ? (
          <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            {data.warning}
          </p>
        ) : null}

        {query.isLoading && !data ? (
          <div className="flex flex-col gap-5 sm:gap-6" aria-hidden="true">
            <div className="h-16 animate-pulse rounded-xl border border-slate-200 bg-slate-50" />
            <div className="h-40 animate-pulse rounded-xl border border-slate-200 bg-slate-50" />
          </div>
        ) : data ? (
          <p className="text-pretty text-xs leading-5 text-slate-500">
            {data.dateBasisNote}
          </p>
        ) : null}
      </div>

      {data ? (
        <>
          <section id="newly-seen-deals" aria-label={`${regionName} 새로 확인된 거래`}>
            {selectedDate && dayDeals.length > 0 ? (
              <>
                <h2 className="text-sm font-semibold text-slate-900">
                  {koreanMonthDayLabel(selectedDate)} 새로 확인된 거래
                </h2>
                <p className="mt-0.5 text-xs tabular-nums text-slate-500">
                  총 {dayDeals.length.toLocaleString("ko-KR")}건 · 신고가{" "}
                  {daySingoga.toLocaleString("ko-KR")}건
                </p>
                {data.bulkIngestDay ? (
                  <p className="mt-1 text-pretty text-xs leading-5 text-slate-500">
                    이날 확인 건수가 많아 신고가 강조는 생략했습니다.
                  </p>
                ) : null}
                <div
                  className={
                    visibleDeals.length > 1
                      ? "mt-2 grid grid-cols-1 gap-2 lg:grid-cols-2"
                      : "mt-2 flex flex-col gap-2"
                  }
                >
                  {visibleDeals.map((deal) =>
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
                {hiddenCount > 0 ? (
                  <button
                    type="button"
                    onClick={() => setExpanded(true)}
                    className="mt-2 inline-flex min-h-9 items-center rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
                  >
                    더보기 {hiddenCount.toLocaleString("ko-KR")}건
                  </button>
                ) : null}
              </>
            ) : (
              <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center text-pretty text-sm text-slate-500">
                {data.firstSeenReady
                  ? "이 달에 새로 확인된 매매가 없습니다."
                  : "확인 시각이 있는 거래가 아직 없습니다. 확인 데이터가 쌓인 이후부터 볼 수 있습니다."}
              </div>
            )}
          </section>

          <section>
            <div className="mb-2 inline-flex items-center gap-1.5 text-sm text-slate-600">
              <CalendarDays className="h-4 w-4 text-teal-700" />
              <h2 className="text-sm font-semibold text-slate-900">
                새로 확인된 거래 달력
              </h2>
            </div>
            <p className="mb-2 text-pretty text-xs leading-5 text-slate-500">
              숫자는 그날 새로 확인된 매매 건수입니다. 점은 신고가가 있다는 표시입니다.
            </p>
            <MonthCalendar
              yearMonth={calendarYm}
              days={data.days ?? []}
              selectedDate={selectedDate}
              onSelectDate={selectSeenDate}
            />
          </section>

          <section aria-label="매매 계약월 현황" className="border-t border-slate-100 pt-4">
            <p className="mb-2 text-xs font-medium text-slate-500">
              매매 계약일 기준 · {yearMonthLabel(data.contractYearMonth)} (시장 규모)
            </p>
            <div className="grid grid-cols-2 gap-2">
              <Kpi
                label="이번 달 계약 매매"
                value={`${data.monthTradeCount.toLocaleString("ko-KR")}건`}
                hint="오늘까지"
              />
              <Kpi
                label="전월 같은 기간"
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
            </div>
            {insight ? (
              <p className="mt-2 text-sm leading-6 text-pretty text-slate-600">
                {insight}
              </p>
            ) : null}
          </section>
        </>
      ) : null}
    </div>
  );
}

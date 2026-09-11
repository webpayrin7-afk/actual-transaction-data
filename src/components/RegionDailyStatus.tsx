"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, ChevronLeft, ChevronRight } from "lucide-react";
import { useLoadProgressWhen } from "@/components/layout/LoadProgress";
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
  CALENDAR_HELPER,
  CONTRACT_MONTH_LOOKBACK,
  EMPTY_MONTH_HISTORY,
  EMPTY_NEWLY_SEEN,
  HISTORY_INITIAL_DAY_COUNT,
  contractMonthOptions,
  hiddenNewlySeenCount,
  increaseRatePct,
  koreanMonthDayLabel,
  koreanYearMonthLabel,
  listedHistoryDates,
  newlySeenCompactStatus,
  priorPeakAmount,
  recordDateDomId,
  SEEN_DATE_BASIS_HELP,
  SEEN_DATE_BASIS_LABEL,
  shiftYearMonth,
  sortNewlySeenDeals,
  visibleNewlySeenDeals,
  formatMomChangeValue,
  momChangePct,
  singogaSharePct,
  vsPreviousTypeDeal,
} from "@/lib/region/market-insight";
import { TypePriceSparkline } from "@/components/region/TypePriceSparkline";
import { InfoChip } from "@/components/ui/InfoChip";
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

const SECTION_SURFACE =
  "lab-card px-3.5 py-4 sm:px-5 sm:py-5";

function contractLine(date: string): string {
  return `계약 ${formatDealDate(date)}`;
}

function specLine(deal: RegionDailyDeal): string {
  return `${formatSqmApproxPyeong(deal.exclusiveArea)} · ${deal.floor}층`;
}

function DealMetaLine({
  deal,
  emphasizeSpec = false,
}: {
  deal: RegionDailyDeal;
  emphasizeSpec?: boolean;
}) {
  return (
    <div className="mt-1.5 flex flex-wrap items-baseline text-[12px] leading-4">
      <span
        className={`whitespace-nowrap ${
          emphasizeSpec ? "font-medium text-slate-800" : "text-slate-500"
        }`}
      >
        {specLine(deal)}
      </span>
      <span className="whitespace-nowrap text-slate-500">
        {" · "}
        {contractLine(deal.dealDate)}
      </span>
      <span className="whitespace-nowrap text-slate-500">
        {" · "}
        {deal.dealingGbn || "중개거래"}
      </span>
    </div>
  );
}

function fallbackContractMonths(): string[] {
  return contractMonthOptions(
    yearMonthFromSeoulDate(seoulToday()),
    CONTRACT_MONTH_LOOKBACK,
  );
}

function singogaLabel(kind: RegionDailyDeal["singogaKind"]): string {
  if (kind === "type") return "타입 신고가";
  return "신고가";
}

function SingogaBadge({
  variant,
  children,
}: {
  variant: "featured" | "compact";
  children: ReactNode;
}) {
  const cls =
    variant === "featured"
      ? "inline-flex shrink-0 items-center whitespace-nowrap rounded-full bg-teal-600 px-2.5 py-1 text-[11px] font-bold leading-none text-white"
      : "inline-flex shrink-0 items-center whitespace-nowrap rounded-full border border-teal-300 bg-teal-50 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-teal-800";
  return <span className={cls}>{children}</span>;
}

function prevDealDelta(
  current: number,
  previous: number | null,
): { text: string; tone: "up" | "down" | "same" } | null {
  const vs = vsPreviousTypeDeal(current, previous);
  if (!vs) return null;
  if (vs.kind === "same") return { text: "직전 대비 동일", tone: "same" };
  const arrow = vs.kind === "up" ? "▲" : "▼";
  return { text: `${arrow} ${formatEok(vs.amount)}`, tone: vs.kind };
}

function prevDealDeltaClass(tone: "up" | "down" | "same"): string {
  if (tone === "up") return "whitespace-nowrap text-[12px] font-medium tabular-nums text-rose-600";
  if (tone === "down") return "whitespace-nowrap text-[12px] font-medium tabular-nums text-blue-600";
  return "whitespace-nowrap text-[12px] tabular-nums text-slate-500";
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
      className="block rounded-xl border border-teal-200 bg-teal-50 px-3 py-2.5 transition hover:border-teal-300 hover:bg-teal-50"
    >
      <SingogaBadge variant="featured">
        {singogaLabel(deal.singogaKind)}
      </SingogaBadge>
      <strong className="mt-1.5 block break-keep text-[17px] font-bold leading-snug text-slate-900 line-clamp-2">
        {deal.aptName}
      </strong>
      {titleMeta.length > 0 ? (
        <p className="mt-1.5 truncate text-xs font-normal text-slate-500">
          {titleMeta.join(" · ")}
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap items-baseline justify-start gap-x-2 gap-y-0.5">
        <span className="whitespace-nowrap text-[22px] font-semibold leading-none tabular-nums text-slate-900">
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
        <p className="mt-1 whitespace-nowrap text-[12px] tabular-nums text-slate-500">
          종전 최고 {formatEok(prior)}
        </p>
      ) : null}
      <DealMetaLine deal={deal} emphasizeSpec />
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
  const delta = prevDealDelta(deal.dealAmount, deal.prevTypeDealAmount);
  return (
    <Link
      href={aptDetailHref(deal.aptName, regionSlug, deal.gu)}
      className="block rounded-xl border border-slate-200/80 bg-slate-50/50 px-3 py-2.5 transition hover:border-slate-300 hover:bg-slate-50"
    >
      <p className="break-keep text-sm font-semibold leading-snug text-slate-900 line-clamp-2">
        {deal.aptName}
      </p>
      <div className="mt-1.5 flex flex-wrap items-baseline justify-start gap-x-2 gap-y-0.5">
        <span className="whitespace-nowrap text-lg font-semibold tabular-nums leading-none text-slate-900">
          {formatEok(deal.dealAmount)}
        </span>
        {delta ? (
          <span className={prevDealDeltaClass(delta.tone)}>
            {delta.text}
          </span>
        ) : null}
      </div>
      <DealMetaLine deal={deal} emphasizeSpec />
    </Link>
  );
}

function HistoryDealCard({
  deal,
  regionSlug,
}: {
  deal: RegionDailyDeal;
  regionSlug: string;
}) {
  const delta = prevDealDelta(deal.dealAmount, deal.prevTypeDealAmount);
  return (
    <Link
      href={aptDetailHref(deal.aptName, regionSlug, deal.gu)}
      className="block rounded-lg border border-solid border-slate-100 px-3 py-2 transition hover:bg-slate-50/80"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 flex-1 break-keep text-sm font-semibold leading-snug text-slate-900 line-clamp-2">
          {deal.aptName}
        </p>
        {deal.singogaKind ? (
          <SingogaBadge variant="compact">신고가</SingogaBadge>
        ) : null}
      </div>
      <div className="mt-1 flex flex-wrap items-baseline justify-start gap-x-2 gap-y-0.5">
        <span className="whitespace-nowrap text-base font-semibold tabular-nums leading-none text-slate-900">
          {formatEok(deal.dealAmount)}
        </span>
        {delta ? (
          <span className={prevDealDeltaClass(delta.tone)}>
            {delta.text}
          </span>
        ) : null}
      </div>
      <DealMetaLine deal={deal} />
    </Link>
  );
}

function DealGrid({
  deals,
  regionSlug,
  variant,
}: {
  deals: RegionDailyDeal[];
  regionSlug: string;
  variant: "featured" | "history";
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
        variant === "history" ? (
          <HistoryDealCard
            key={deal.id}
            deal={deal}
            regionSlug={regionSlug}
          />
        ) : deal.singogaKind ? (
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

function DateBasisChip({
  label,
  help,
}: {
  label: string;
  help: string;
}) {
  return <InfoChip label={label}>{help}</InfoChip>;
}

function SectionHeading({
  title,
  basisLabel,
  basisHelp,
  aside,
}: {
  title: string;
  basisLabel: string;
  basisHelp: string;
  aside?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <h2 className="shrink-0 text-[15px] font-semibold tracking-tight text-slate-900 sm:text-base">
        {title}
      </h2>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        <DateBasisChip label={basisLabel} help={basisHelp} />
        {aside}
      </div>
    </div>
  );
}

function MonthNav({
  value,
  options,
  onChange,
  spread = false,
}: {
  value: string;
  options: string[];
  onChange: (next: string) => void;
  spread?: boolean;
}) {
  const bounds = [...new Set([...options, value])].sort();
  const oldestYm = bounds[0] ?? value;
  const newestYm = bounds.at(-1) ?? value;
  const olderYm = shiftYearMonth(value, -1);
  const newerYm = shiftYearMonth(value, 1);
  const canPrev = olderYm >= oldestYm;
  const canNext = newerYm <= newestYm;
  const years = [...new Set(bounds.map((ym) => ym.slice(0, 4)))].sort(
    (a, b) => Number(b) - Number(a),
  );
  const selectedYear = value.slice(0, 4);
  const selectedMonth = value.slice(4, 6);
  const changePart = (year: string, month: string) => {
    const next = `${year}${month}`;
    if (next >= oldestYm && next <= newestYm) onChange(next);
  };
  const btn =
    "inline-flex h-10 w-10 shrink-0 items-center justify-center text-slate-600 transition hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400 disabled:opacity-30";
  return (
    <div
      className={`inline-flex items-center rounded-xl border border-slate-200 bg-white ${
        spread ? "w-full" : "w-full max-w-xs"
      }`}
    >
      <button
        type="button"
        disabled={!canPrev}
        onClick={() => canPrev && onChange(olderYm)}
        className={`${btn} rounded-l-xl`}
        aria-label="이전 달"
      >
        <ChevronLeft className="h-5 w-5" />
      </button>
      <div className="flex min-w-0 flex-1 items-center justify-center gap-1 px-1" aria-label={koreanYearMonthLabel(value)}>
        <select
          value={selectedYear}
          onChange={(event) => changePart(event.target.value, selectedMonth)}
          className="bg-transparent text-sm font-semibold tabular-nums text-slate-800 focus-visible:outline-2 focus-visible:outline-slate-400"
          aria-label="연도 선택"
        >
          {years.map((year) => <option key={year} value={year}>{year}년</option>)}
        </select>
        <select
          value={selectedMonth}
          onChange={(event) => changePart(selectedYear, event.target.value)}
          className="bg-transparent text-sm font-semibold tabular-nums text-slate-800 focus-visible:outline-2 focus-visible:outline-slate-400"
          aria-label="월 선택"
        >
          {Array.from({ length: 12 }, (_, index) => String(index + 1).padStart(2, "0")).map((month) => {
            const ym = `${selectedYear}${month}`;
            return <option key={month} value={month} disabled={ym < oldestYm || ym > newestYm}>{Number(month)}월</option>;
          })}
        </select>
      </div>
      <button
        type="button"
        disabled={!canNext}
        onClick={() => canNext && onChange(newerYm)}
        className={`${btn} rounded-r-xl`}
        aria-label="다음 달"
      >
        <ChevronRight className="h-5 w-5" />
      </button>
    </div>
  );
}

function MoreControl({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-1 inline-flex min-h-9 items-center self-start whitespace-nowrap px-0.5 text-sm font-medium text-slate-600 underline-offset-2 transition hover:text-slate-900 hover:underline"
    >
      {children}
    </button>
  );
}

function MonthCalendar({
  yearMonth,
  days,
  selectedDate,
  onSelectDate,
  monthOptions,
  onChangeMonth,
}: {
  yearMonth: string;
  days: RegionDailyDaySummary[];
  selectedDate: string | null;
  onSelectDate: (date: string) => void;
  monthOptions: string[];
  onChangeMonth: (next: string) => void;
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
    <div className="max-w-md">
      <MonthNav
        value={yearMonth}
        options={monthOptions}
        onChange={onChangeMonth}
        spread
      />
      <div className="mt-1.5 rounded-xl border border-slate-200 bg-slate-50/70 p-1.5 sm:p-2">
        <div className="mb-1 grid grid-cols-7 border-b border-slate-200/80 text-center text-[10px] font-medium text-slate-400">
          {weekLabels.map((label) => (
            <div key={label} className="py-1">
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
            return (
              <button
                key={date}
                type="button"
                onClick={() => onSelectDate(date)}
                aria-label={`${monthNum}월 ${day}일 거래${hasDeals ? ` ${dealCount}건` : " 없음"}${hasSingoga ? ", 신고가 있음" : ""}`}
                aria-pressed={active}
                className={`relative flex min-h-10 flex-col items-center justify-center rounded-md px-0.5 text-sm transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400 sm:min-h-11 ${
                  active
                    ? "bg-teal-700 text-white"
                    : hasDeals
                      ? "text-slate-800 hover:bg-slate-100/80"
                      : "text-slate-400 hover:bg-slate-100/80"
                }`}
              >
                <span className="font-medium leading-none">{day}</span>
                {hasDeals ? <span
                  className={`mt-0.5 text-[10px] leading-none tabular-nums ${
                    active ? "text-teal-50" : "text-slate-500"
                  }`}
                >
                  {dealCount}
                  <span className="sr-only">건</span>
                </span> : null}
                {hasSingoga ? (
                  <span
                    className={`mt-0.5 h-1 w-1 rounded-full ${active ? "bg-white" : "bg-teal-600"}`}
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
    </div>
  );
}

function formatPyeongMedian(manwon: number): string {
  if (manwon >= 10000) return formatEok(manwon);
  return `${manwon.toLocaleString("ko-KR")}만원`;
}

function volumeChangeSide(
  current: number,
  previous: number,
  pct: number | null,
): { full: string; compact: string } | undefined {
  if (pct == null || previous <= 0) return undefined;
  const from = previous.toLocaleString("ko-KR");
  const to = current.toLocaleString("ko-KR");
  return {
    full: `${from}건 → ${to}건`,
    compact: `${from}→${to}건`,
  };
}

function volumeChangeClass(pct: number | null): string {
  if (pct == null) return "text-slate-400";
  if (pct === 0) return "text-slate-500";
  if (pct > 0) return "text-rose-600";
  return "text-blue-600";
}

function volumeChangeSideClass(pct: number | null): string {
  if (pct == null || pct === 0) return "text-slate-400";
  if (pct > 0) return "text-rose-500";
  return "text-blue-500";
}

function singogaValueClass(count: number | null): string {
  if (count == null || count === 0) return "text-slate-400";
  return "text-teal-700";
}

function formatSharePct(pct: number | null): string {
  if (pct == null) return "—";
  return `${pct.toFixed(1)}%`;
}

function Kpi({
  label,
  value,
  side,
  className,
  valueClassName = "text-teal-700",
  sideClassName = "text-teal-600/80",
}: {
  label: string;
  value: string;
  side?: string | { full: string; compact: string };
  className?: string;
  valueClassName?: string;
  sideClassName?: string;
}) {
  const sideFull = typeof side === "string" ? side : side?.full;
  const sideCompact = typeof side === "string" ? side : side?.compact;
  return (
    <div
      className={`overflow-hidden rounded-lg border border-slate-200 bg-white px-2 py-3 shadow-[0_1px_2px_rgba(15,23,42,0.04)] sm:px-4 sm:py-3.5 ${className ?? ""}`}
    >
      <p className="whitespace-nowrap text-[11px] leading-4 text-slate-600">
        {label}
      </p>
      <div className="mt-1.5 flex min-w-0 items-baseline gap-x-1 sm:mt-2 sm:gap-x-2">
        <p
          className={`lab-kpi-figure whitespace-nowrap text-base font-semibold leading-none sm:text-xl ${valueClassName}`}
        >
          {value}
        </p>
        {sideFull ? (
          <>
            <p
              className={`whitespace-nowrap text-[10px] leading-none tabular-nums sm:hidden ${sideClassName}`}
            >
              {sideCompact}
            </p>
            <p
              className={`hidden whitespace-nowrap text-[11px] leading-none tabular-nums sm:inline ${sideClassName}`}
            >
              {sideFull}
            </p>
          </>
        ) : null}
      </div>
    </div>
  );
}

function PhraseRow({
  items,
  className,
  leadingClassName,
  restClassName,
}: {
  items: Array<string | null | undefined>;
  className?: string;
  leadingClassName?: string;
  restClassName?: string;
}) {
  const parts = items.filter((item): item is string => Boolean(item));
  if (parts.length === 0) return null;
  return (
    <div
      className={`flex flex-wrap items-baseline gap-y-0.5 ${className ?? ""}`}
    >
      {parts.map((part, index) => (
        <span
          key={`${part}-${index}`}
          className={`whitespace-nowrap ${
            index === 0 ? (leadingClassName ?? "") : (restClassName ?? "")
          }`}
        >
          {index > 0 ? <span className="text-slate-300"> · </span> : null}
          {part}
        </span>
      ))}
    </div>
  );
}

function dayCountPhrases(section: RegionDailyDaySection): string[] {
  const n = section.totalCount.toLocaleString("ko-KR");
  if (section.bulkIngestDay || !section.singogaKnown) {
    return [`총 ${n}건`];
  }
  return [`총 ${n}건`, `신고가 ${section.singogaCount.toLocaleString("ko-KR")}건`];
}

function seenCountPhrases(opts: {
  total: number;
  singogaCount: number;
  bulk: boolean;
}): string[] {
  const n = opts.total.toLocaleString("ko-KR");
  if (opts.bulk) return [`총 ${n}건`, "신고가 계산 생략"];
  return [`총 ${n}건`, `신고가 ${opts.singogaCount.toLocaleString("ko-KR")}건`];
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
  const contractMonthFallback = useMemo(() => fallbackContractMonths(), []);
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
  const [visibleDealCount, setVisibleDealCount] = useState(15);
  const [clickedDates, setClickedDates] = useState<string[]>([]);
  const [calendarSelected, setCalendarSelected] = useState<string | null>(null);
  const [flashDate, setFlashDate] = useState<string | null>(null);
  const [flashNonce, setFlashNonce] = useState(0);
  const [bulkExtra, setBulkExtra] = useState<Record<string, RegionDailyDeal[]>>(
    {},
  );
  const [extraSections, setExtraSections] = useState<RegionDailyDaySection[]>(
    [],
  );
  const [pendingDates, setPendingDates] = useState<string[]>([]);
  const pendingScroll = useRef<string | null>(null);
  const historySentinel = useRef<HTMLDivElement | null>(null);
  const requestEpoch = useRef(0);
  const activityMonthRef = useRef(activityMonthUser ?? yearMonthFromSeoulDate(seoulToday()));
  const inFlightDates = useRef(new Set<string>());
  const inFlightPages = useRef(new Set<string>());

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
    activityMonthUser ?? yearMonthFromSeoulDate(seoulToday());

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

  const initialDaysQuery = useQuery({
    queryKey: ["region-history-days-initial", regionSlug, activityMonth],
    queryFn: () =>
      fetchRegionPart({
        region: regionSlug,
        part: "days",
        yearMonth: activityMonth,
      }),
    staleTime: 60_000,
    retry: 1,
  });


  const section1Months =
    marketQuery.data?.contractMonthOptions?.length
      ? marketQuery.data.contractMonthOptions
      : contractMonthFallback;
  const section3Months =
    historyQuery.data?.activityYearMonths?.length
      ? historyQuery.data.activityYearMonths
      : latest?.activityYearMonths?.length
        ? latest.activityYearMonths
        : [activityMonth];

  const activeDates = useMemo(
    () =>
      (historyQuery.data?.days ?? [])
        .filter((d) => d.dealCount > 0)
        .map((d) => d.date),
    [historyQuery.data?.days],
  );
  const listedDates = useMemo(
    () =>
      listedHistoryDates({
        activeDates,
        visibleDayCount,
        selectedDate: calendarSelected,
        extraDates: clickedDates,
      }),
    [activeDates, calendarSelected, clickedDates, visibleDayCount],
  );

  const sectionByDate = useMemo(() => {
    const map = new Map<string, RegionDailyDaySection>();
    for (const section of [
      ...(initialDaysQuery.data?.historySections ?? []),
      ...extraSections,
    ]) {
      const extra = bulkExtra[section.date] ?? [];
      const deals = [...section.deals, ...extra];
      const uniqueDeals = [...new Map(deals.map((deal) => [deal.id, deal])).values()];
      map.set(section.date, {
        ...section,
        deals: uniqueDeals,
        hasMore: uniqueDeals.length < section.totalCount,
      });
    }
    return map;
  }, [initialDaysQuery.data, extraSections, bulkExtra]);

  const historyShellLoading =
    (historyQuery.isFetching || initialDaysQuery.isFetching) &&
    !historyQuery.data &&
    !initialDaysQuery.data;
  const marketStatusLoading =
    (marketQuery.isFetching && !marketQuery.data) ||
    (latestQuery.isFetching && !latestQuery.data) ||
    historyShellLoading ||
    pendingDates.length > 0;

  useLoadProgressWhen(marketStatusLoading, "시장 현황 불러오는 중…");

  const fetchDaySections = useCallback(
    async (dates: string[]) => {
      const missing = [
        ...new Set(
          dates.filter(
            (date) =>
              !sectionByDate.has(date) &&
              !inFlightDates.current.has(`${activityMonth}:${date}`),
          ),
        ),
      ];
      if (missing.length === 0) return;
      const epoch = requestEpoch.current;
      const requestedMonth = activityMonth;
      missing.forEach((date) =>
        inFlightDates.current.add(`${requestedMonth}:${date}`),
      );
      setPendingDates((prev) => [...new Set([...prev, ...missing])]);
      try {
        const data = await fetchRegionPart({
          region: regionSlug,
          part: "days",
          yearMonth: activityMonth,
          dates: missing.join(","),
        });
        if (epoch !== requestEpoch.current || requestedMonth !== activityMonthRef.current) return;
        setExtraSections((prev) => {
          const map = new Map(prev.map((section) => [section.date, section]));
          for (const section of data.historySections) {
            map.set(section.date, section);
          }
          for (const date of missing) {
            if (!map.has(date)) {
              map.set(date, {
                date,
                deals: [],
                bulkIngestDay: false,
                singogaKnown: true,
                totalCount: 0,
                singogaCount: 0,
                hasMore: false,
              });
            }
          }
          return [...map.values()];
        });
      } finally {
        missing.forEach((date) =>
          inFlightDates.current.delete(`${requestedMonth}:${date}`),
        );
        if (epoch === requestEpoch.current) {
          setPendingDates((prev) =>
            prev.filter((date) => !missing.includes(date)),
          );
        }
      }
    },
    [activityMonth, regionSlug, sectionByDate],
  );

  useLayoutEffect(() => {
    const date = pendingScroll.current;
    if (!date) return;
    if (!sectionByDate.has(date)) return;
    if (!document.getElementById(recordDateDomId(date))) return;
    pendingScroll.current = null;
    scrollToDateHeading(date);
  }, [listedDates, sectionByDate, visibleDayCount, clickedDates]);

  const market = marketQuery.data;
  const volumePct =
    market != null
      ? momChangePct(market.monthTradeCount, market.prevMonthTradeCount)
      : null;
  const yearAgoPct =
    market?.yearAgoMonthTradeCount != null
      ? momChangePct(market.monthTradeCount, market.yearAgoMonthTradeCount)
      : null;
  const singogaPct =
    market?.monthSingogaCount != null
      ? singogaSharePct(market.monthSingogaCount, market.monthTradeCount)
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
    requestEpoch.current += 1;
    activityMonthRef.current = next;
    inFlightDates.current.clear();
    inFlightPages.current.clear();
    setActivityMonthUser(next);
    setVisibleDayCount(HISTORY_INITIAL_DAY_COUNT);
    setVisibleDealCount(15);
    setClickedDates([]);
    setCalendarSelected(null);
    setBulkExtra({});
    setExtraSections([]);
    setPendingDates([]);
  }

  function selectCalendarDate(date: string) {
    setCalendarSelected(date);
    setFlashDate(date);
    setFlashNonce((n) => n + 1);
    pendingScroll.current = date;
    setClickedDates((prev) => (prev.includes(date) ? prev : [...prev, date]));
    if (sectionByDate.has(date)) {
      if (scrollToDateHeading(date)) pendingScroll.current = null;
      return;
    }
    void fetchDaySections([date]);
  }

  const loadMoreBulk = useCallback(async (section: RegionDailyDaySection) => {
    const offset = section.deals.length;
    const requestKey = `${activityMonth}:${section.date}:${offset}`;
    if (inFlightPages.current.has(requestKey)) return;
    const epoch = requestEpoch.current;
    inFlightPages.current.add(requestKey);
    try {
      const data = await fetchRegionPart({
        region: regionSlug,
        part: "days",
        yearMonth: activityMonth,
        dates: section.date,
        offset: String(offset),
      });
      if (epoch !== requestEpoch.current || activityMonth !== activityMonthRef.current) return;
      const next = data.historySections.find((s) => s.date === section.date);
      if (!next) return;
      setBulkExtra((prev) => ({
        ...prev,
        [section.date]: [
          ...new Map([...(prev[section.date] ?? []), ...next.deals].map((deal) => [deal.id, deal])).values(),
        ],
      }));
    } finally {
      inFlightPages.current.delete(requestKey);
    }
  }, [activityMonth, regionSlug]);

  const remainingDates = Math.max(0, activeDates.length - visibleDayCount);
  const listedSections = listedDates.map((date) => sectionByDate.get(date));
  const loadedDealCount = listedSections.reduce(
    (sum, section) => sum + (section?.deals.length ?? 0),
    0,
  );
  const hasMoreHistory =
    remainingDates > 0 ||
    visibleDealCount < loadedDealCount ||
    listedSections.some((section) => section?.hasMore);

  const loadNextHistory = useCallback(() => {
    setVisibleDealCount((count) => count + 15);
    const paged = listedDates
      .map((date) => sectionByDate.get(date))
      .find((section) => section?.hasMore);
    if (paged) {
      void loadMoreBulk(paged);
      return;
    }
    const nextDates = activeDates.slice(
      visibleDayCount,
      visibleDayCount + HISTORY_INITIAL_DAY_COUNT,
    );
    if (nextDates.length > 0) {
      setVisibleDayCount((count) => count + HISTORY_INITIAL_DAY_COUNT);
      void fetchDaySections(nextDates);
    }
  }, [activeDates, fetchDaySections, listedDates, loadMoreBulk, sectionByDate, visibleDayCount]);

  useEffect(() => {
    const target = historySentinel.current;
    if (!target || !hasMoreHistory) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadNextHistory();
      },
      { rootMargin: "320px 0px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasMoreHistory, loadNextHistory]);
  const calendarDays = (historyQuery.data?.days ?? []).map((day) => {
    const section = sectionByDate.get(day.date);
    if (!section) return day;
    return {
      ...day,
      singogaCount: section.singogaCount,
      singogaKnown: section.singogaKnown,
      bulkIngestDay: section.bulkIngestDay,
    };
  });

  const heroCountPhrases = seenCountPhrases({
    total: latest?.tradeCount ?? heroDeals.length,
    singogaCount: latest?.selectedDaySingogaCount ?? 0,
    bulk: Boolean(latest?.bulkIngestDay),
  });
  const visibleDealsByDate = useMemo(() => {
    const map = new Map<string, RegionDailyDeal[]>();
    let remaining = visibleDealCount;
    for (const date of listedDates) {
      const section = sectionByDate.get(date);
      if (!section) continue;
      const limit = date === calendarSelected ? section.deals.length : remaining;
      const deals = section.deals.slice(0, Math.max(0, limit));
      map.set(date, deals);
      if (date !== calendarSelected) remaining -= deals.length;
    }
    return map;
  }, [calendarSelected, listedDates, sectionByDate, visibleDealCount]);

  return (
    <div className="flex min-h-[min(70vh,42rem)] flex-col gap-4 sm:gap-5">
      <section
        aria-label={`${regionName} 지역 시장 현황`}
        className={`${SECTION_SURFACE} flex flex-col gap-3`}
      >
        <SectionHeading
          title="지역 시장 현황"
          basisLabel={CONTRACT_DATE_BASIS_LABEL}
          basisHelp={CONTRACT_DATE_BASIS_HELP}
        />
        <div className="flex flex-col gap-2">
        <MonthNav
          value={contractMonth}
          options={section1Months}
          onChange={setContractMonth}
        />
        {marketQuery.isError ? (
          <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            시장 현황을 불러오지 못했습니다.
          </p>
        ) : null}
        {marketQuery.isLoading && !market ? (
          <div className="h-24 animate-pulse rounded-lg bg-slate-200/50" />
        ) : market ? (
          <>
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
              <Kpi
                label="거래량"
                value={`${market.monthTradeCount.toLocaleString("ko-KR")}건`}
                side={market.comparePartial ? "오늘까지" : undefined}
              />
              <Kpi
                label="전월 대비"
                value={formatMomChangeValue(volumePct)}
                side={volumeChangeSide(
                  market.monthTradeCount,
                  market.prevMonthTradeCount,
                  volumePct,
                )}
                valueClassName={volumeChangeClass(volumePct)}
                sideClassName={volumeChangeSideClass(volumePct)}
              />
              <Kpi
                label="전년 동월 대비"
                value={formatMomChangeValue(yearAgoPct)}
                side={
                  market.yearAgoMonthTradeCount != null
                    ? volumeChangeSide(
                        market.monthTradeCount,
                        market.yearAgoMonthTradeCount,
                        yearAgoPct,
                      )
                    : undefined
                }
                valueClassName={volumeChangeClass(yearAgoPct)}
                sideClassName={volumeChangeSideClass(yearAgoPct)}
              />
              <Kpi
                label="신고가"
                value={
                  market.monthSingogaCount != null
                    ? `${market.monthSingogaCount.toLocaleString("ko-KR")}건`
                    : "—"
                }
                valueClassName={singogaValueClass(market.monthSingogaCount)}
              />
              <Kpi
                label="신고가 비율"
                value={formatSharePct(singogaPct)}
                valueClassName={singogaValueClass(
                  market.monthSingogaCount,
                )}
              />
              <Kpi
                label="평당 중위가"
                value={
                  market.medianPyeongPrice != null
                    ? formatPyeongMedian(market.medianPyeongPrice)
                    : "—"
                }
              />
            </div>
            <Link
              href="/stats"
              className="inline-flex items-center gap-1 self-start text-sm font-medium text-slate-600 transition hover:text-slate-900"
            >
              시장 동향 자세히 보기
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </>
        ) : null}
        </div>
      </section>

      <section
        id="newly-seen-deals"
        aria-label={`${regionName} 새로 확인된 거래`}
        className={`${SECTION_SURFACE} flex flex-col gap-2.5`}
      >
        <SectionHeading
          title="새로 확인된 거래"
          basisLabel={SEEN_DATE_BASIS_LABEL}
          basisHelp={SEEN_DATE_BASIS_HELP}
        />
        {latestQuery.isError ? (
          <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            새로 확인된 거래를 불러오지 못했습니다.
          </p>
        ) : null}
        {latestQuery.isLoading && !latest ? (
          <div className="h-40 animate-pulse rounded-lg bg-slate-200/50" />
        ) : heroDate && heroDeals.length > 0 ? (
          <>
            {heroIsToday ? (
              <PhraseRow
                className="text-sm leading-5"
                leadingClassName="font-medium text-slate-900"
                restClassName="tabular-nums text-slate-500"
                items={[koreanMonthDayLabel(heroDate), ...heroCountPhrases]}
              />
            ) : (
              <p className="break-keep text-sm text-slate-600">
                {newlySeenCompactStatus({
                  isToday: false,
                  heroDate,
                })}
              </p>
            )}
            {latest?.bulkIngestDay ? (
              <p className="text-pretty text-xs leading-5 text-slate-500">
                이날 확인 건수가 많아 신고가 강조는 생략했습니다. 신고가가
                0건이라는 뜻은 아닙니다.
              </p>
            ) : null}
            <DealGrid
              deals={heroVisible}
              regionSlug={regionSlug}
              variant="featured"
            />
            {heroHidden > 0 ? (
              <MoreControl onClick={() => setHeroExpanded(true)}>
                더보기 {heroHidden.toLocaleString("ko-KR")}건
              </MoreControl>
            ) : null}
          </>
        ) : (
          <div className="px-1 py-2 text-sm text-slate-500">
            {EMPTY_NEWLY_SEEN}
          </div>
        )}
      </section>

      <section
        aria-label={`${regionName} 지역 거래 내역`}
        className={`${SECTION_SURFACE} flex flex-col gap-3`}
      >
        <SectionHeading
          title="지역 거래 내역"
          basisLabel={CONTRACT_DATE_BASIS_LABEL}
          basisHelp={CONTRACT_DATE_BASIS_HELP}
        />

        <div>
          <MonthCalendar
            yearMonth={activityMonth}
            days={calendarDays}
            selectedDate={calendarSelected}
            onSelectDate={selectCalendarDate}
            monthOptions={section3Months}
            onChangeMonth={changeActivityMonth}
          />
          <p className="mt-2 max-w-md text-[11px] leading-4 text-slate-400">
            {CALENDAR_HELPER}
          </p>
        </div>

        <div className="mt-2 flex flex-col gap-5 border-t border-slate-200/70 pt-5">
          {historyQuery.data ? (
            <p className="shrink-0 text-left text-xs tabular-nums text-slate-500">
              이 달 총{" "}
              {(historyQuery.data.historyTotalCount ?? 0).toLocaleString(
                "ko-KR",
              )}
              건
            </p>
          ) : null}
          {activeDates.length === 0 && historyQuery.data ? (
            <div className="flex min-h-[12rem] shrink-0 items-center justify-center px-1 py-8 text-center sm:min-h-[14rem]">
              <p className="break-keep text-sm text-slate-500">
                {EMPTY_MONTH_HISTORY}
              </p>
            </div>
          ) : null}
          {(historyQuery.isLoading || initialDaysQuery.isLoading) &&
          !historyQuery.data &&
          !initialDaysQuery.data ? (
            <div className="h-24 animate-pulse rounded-lg bg-slate-200/50" />
          ) : null}
          {listedDates.map((date) => {
            const section = sectionByDate.get(date);
            const summary = calendarDays.find((d) => d.date === date);
            const visibleDeals = visibleDealsByDate.get(date) ?? [];
            const headingClass =
              flashDate === date
                ? "region-date-flash rounded-md px-1 -mx-1"
                : "px-1 -mx-1";
            return (
              <div key={date}>
                <h4
                  key={
                    flashDate === date ? `${date}-flash-${flashNonce}` : date
                  }
                  id={recordDateDomId(date)}
                  className={`scroll-mt-[calc(var(--site-header-height,3.5rem)+0.75rem)] ${headingClass}`}
                >
                  <PhraseRow
                    className="text-sm font-medium text-slate-900"
                    restClassName="text-xs font-normal tabular-nums text-slate-500"
                    items={[
                      koreanMonthDayLabel(date),
                      ...(section
                        ? dayCountPhrases(section)
                        : [
                            `총 ${(summary?.dealCount ?? 0).toLocaleString("ko-KR")}건`,
                          ]),
                    ]}
                  />
                </h4>
                {section?.bulkIngestDay ? (
                  <p className="mt-1 text-pretty text-xs leading-5 text-slate-500">
                    이날 거래 건수가 많아 신고가 강조는 생략했습니다. 신고가가
                    0건이라는 뜻은 아닙니다.
                  </p>
                ) : null}
                {section ? (
                  <>
                    {visibleDeals.length > 0 ? (
                      <DealGrid
                        deals={visibleDeals}
                        regionSlug={regionSlug}
                        variant="history"
                      />
                    ) : section.totalCount === 0 ? (
                      <p className="mt-2 text-sm text-slate-500">
                        해당 날짜 거래가 없습니다.
                      </p>
                    ) : null}
                  </>
                ) : null}
              </div>
            );
          })}
          {pendingDates.length > 0 ? (
            <div className="h-16 animate-pulse rounded-lg bg-slate-200/50" />
          ) : null}
          <div ref={historySentinel} className="h-px" aria-hidden="true" />
        </div>
      </section>
    </div>
  );
}

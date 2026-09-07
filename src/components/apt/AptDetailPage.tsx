"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  Building2,
  CalendarDays,
  Flame,
  LoaderCircle,
  MapPin,
} from "lucide-react";
import type { AptDetailResponse } from "@/lib/molit/apt";
import {
  AptPriceChart,
  PeriodRangeSlider,
} from "@/components/apt/AptPriceChart";
import {
  formatDealDate,
  formatEok,
  formatRentAmount,
  toPyeong,
} from "@/lib/utils/format";

const QUICK_MONTHS = 36;
const FULL_MONTHS = 120;
const RECENT_YEARS = 3;

async function fetchAptDetail(
  aptName: string,
  region: string,
  months: number,
): Promise<AptDetailResponse> {
  const qs = new URLSearchParams({
    aptName,
    region,
    months: String(months),
  });
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
}: {
  aptName: string;
  regionSlug: string;
}) {
  const [areaKey, setAreaKey] = useState("all");
  const [dealFilter, setDealFilter] = useState<"all" | "trade" | "rent">("all");
  const [rangeOverride, setRangeOverride] = useState<{
    start: number;
    end: number;
  } | null>(null);
  const [boundKey, setBoundKey] = useState(`${aptName}|${regionSlug}`);
  const [periodPreset, setPeriodPreset] = useState<PeriodPreset>("recent3");

  const quickQuery = useQuery({
    queryKey: ["apt-detail", aptName, regionSlug, "quick", QUICK_MONTHS],
    queryFn: () => fetchAptDetail(aptName, regionSlug, QUICK_MONTHS),
    staleTime: 5 * 60 * 1000,
  });

  const fullQuery = useQuery({
    queryKey: ["apt-detail", aptName, regionSlug, "full", FULL_MONTHS],
    queryFn: () => fetchAptDetail(aptName, regionSlug, FULL_MONTHS),
    enabled: quickQuery.isSuccess,
    staleTime: 30 * 60 * 1000,
  });

  const data = fullQuery.data ?? quickQuery.data;
  const isExtendingHistory =
    quickQuery.isSuccess && !fullQuery.isSuccess && fullQuery.isFetching;
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
    return data.items.filter(
      (item) => String(Math.round(item.exclusiveArea * 100) / 100) === areaKey,
    );
  }, [data, areaKey]);

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
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-8 sm:px-6">
        <div className="h-40 animate-pulse rounded-3xl bg-slate-200/70" />
        <div className="h-72 animate-pulse rounded-2xl bg-slate-200/60" />
        <div className="h-96 animate-pulse rounded-2xl bg-slate-200/50" />
      </div>
    );
  }

  if ((quickQuery.isError && !data) || !data) {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-16 text-center sm:px-6">
        <p className="text-sm font-medium text-slate-700">
          단지 정보를 불러오지 못했습니다.
        </p>
        <Link href="/" className="text-sm text-teal-700 hover:underline">
          ← 메인으로
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8">
      <header className="relative rounded-3xl border border-teal-900/10 bg-gradient-to-br from-slate-900 via-teal-900 to-slate-800 px-5 py-7 text-white shadow-lg sm:px-8">
        <div
          className="pointer-events-none absolute inset-0 overflow-hidden rounded-3xl opacity-30"
          style={{
            backgroundImage:
              "radial-gradient(circle at 18% 20%, rgba(45,212,191,0.35), transparent 42%), radial-gradient(circle at 85% 0%, rgba(125,211,252,0.22), transparent 36%)",
          }}
        />
        <div className="relative">
          <p className="text-sm text-teal-100/85">아파트 실거래가 이력</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">
            {data.aptName}
            {data.buildYear ? (
              <span className="ml-2 text-lg font-medium text-teal-100/80">
                ({data.buildYear}년)
              </span>
            ) : null}
          </h1>
          <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-teal-50/85">
            <Link
              href={`/region/${data.regionSlug}`}
              className="inline-flex items-center gap-1 transition hover:text-white"
            >
              <MapPin className="h-4 w-4" />
              {data.fullName}
              {data.dong ? ` ${data.dong}` : ""}
            </Link>
            <span className="inline-flex items-center gap-1">
              <Building2 className="h-4 w-4" />
              매매 {data.stats.totalTradeCount.toLocaleString("ko-KR")}건 · 전월세{" "}
              {data.stats.totalRentCount.toLocaleString("ko-KR")}건
            </span>
          </p>
        </div>
      </header>

      {(data.warning || data.source === "mock") && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            {data.warning ??
              "데모 데이터로 표시 중입니다. MOLIT_API_KEY 설정 시 실거래가 반영됩니다."}
          </p>
        </div>
      )}

      <section className="rounded-2xl border border-slate-200/80 bg-white/90 p-4 shadow-sm sm:p-5">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900">시세 추이</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              매매·전세 평균가와 월별 거래량 · 국토부 실거래 기준
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            {isExtendingHistory ? (
              <p className="inline-flex items-center gap-1.5 text-teal-700">
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                과거 시세 불러오는 중…
              </p>
            ) : null}
            <p className="text-slate-600">
              선택 기간 매매{" "}
              <span className="font-semibold text-teal-800">
                {periodTradeCount}건
              </span>
            </p>
            <p className="text-slate-600">
              전월세{" "}
              <span className="font-semibold text-orange-700">
                {periodRentCount}건
              </span>
            </p>
            {periodMax > 0 ? (
              <p className="text-slate-600">
                최고{" "}
                <span className="font-semibold text-rose-600">
                  {formatEok(periodMax)}
                </span>
              </p>
            ) : null}
          </div>
        </div>

        <div className="mb-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setAreaKey("all")}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
              areaKey === "all"
                ? "bg-slate-900 text-white"
                : "bg-slate-100 text-slate-700 hover:bg-slate-200"
            }`}
          >
            전체 면적
          </button>
          {data.areas.map((area) => (
            <button
              key={area.key}
              type="button"
              onClick={() => setAreaKey(area.key)}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                areaKey === area.key
                  ? "bg-teal-700 text-white"
                  : "bg-slate-100 text-slate-700 hover:bg-slate-200"
              }`}
            >
              {area.label} · {area.count}건
            </button>
          ))}
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

      <section className="rounded-2xl border border-slate-200/80 bg-white/85 p-4 shadow-sm sm:p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-slate-900">거래이력</h2>
          <div className="flex gap-1 rounded-lg bg-slate-100 p-1">
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
                    ? "bg-white text-slate-900 shadow-sm"
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
                </h3>
                <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200/80 bg-white">
                  {items.map((tx) => (
                    <li
                      key={tx.id}
                      className="flex flex-wrap items-center justify-between gap-3 px-3.5 py-3 sm:px-4"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-slate-900">
                          {formatDealDate(tx.dealDate).slice(5)}{" "}
                          <span className="font-normal text-slate-500">
                            {tx.exclusiveArea.toFixed(2)}㎡ (
                            {Math.round(toPyeong(tx.exclusiveArea))}평) ·{" "}
                            {tx.floor}층
                          </span>
                        </p>
                        <p className="mt-0.5 text-xs text-slate-500">
                          {tx.dong} · {tx.dealingGbn || "중개거래"}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        {tx.isSingoga ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-rose-500 px-2 py-0.5 text-[11px] font-semibold text-white">
                            <Flame className="h-3 w-3" />
                            신고가
                          </span>
                        ) : null}
                        <p
                          className={`text-base font-semibold ${
                            tx.dealType === "trade"
                              ? "text-teal-800"
                              : "text-orange-700"
                          }`}
                        >
                          {tx.dealType === "trade"
                            ? `매매 ${formatEok(tx.dealAmount)}`
                            : formatRentAmount(tx.dealAmount, tx.monthlyRent)}
                        </p>
                      </div>
                    </li>
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

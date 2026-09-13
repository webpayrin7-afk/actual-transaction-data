"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, LoaderCircle } from "lucide-react";
import { BackLink } from "@/components/layout/BackLink";
import { useLoadProgressWhen } from "@/components/layout/LoadProgress";
import { AptAreaSelector } from "@/components/apt/AptAreaSelector";
import {
  GroupedTransactionList,
  TransactionTypeTabs,
} from "@/components/apt/TransactionHistory";
import {
  parseTransactionTabType,
  transactionTypeToParam,
  type TransactionTabType,
} from "@/lib/apt/transaction-type";
import {
  kpiDateShort,
  kpiHintForYear,
  parseTransactionYear,
  type TransactionYear,
} from "@/lib/apt/transaction-year";
import type { AptTransactionArchiveResponse } from "@/lib/apt/transaction-archive-types";
import { formatEok, formatKpiMonthlyRent } from "@/lib/utils/format";

const PAGE_SIZE = 20;

const PAGE_WRAP =
  "mx-auto flex w-full max-w-5xl flex-col overflow-x-clip px-4 pt-3 pb-8 sm:px-6 sm:pt-4 sm:pb-10 lg:px-8";

async function fetchArchive(params: {
  aptName: string;
  region: string;
  gu?: string;
  area?: string;
  type: TransactionTabType;
  year: TransactionYear;
  offset: number;
}): Promise<AptTransactionArchiveResponse> {
  const qs = new URLSearchParams({
    aptName: params.aptName,
    region: params.region,
    type: transactionTypeToParam(params.type),
    year: params.year,
    offset: String(params.offset),
    limit: String(PAGE_SIZE),
  });
  if (params.gu?.trim()) qs.set("gu", params.gu.trim());
  if (params.area) qs.set("area", params.area);
  const started = performance.now();
  const res = await fetch(`/api/apt-transactions?${qs.toString()}`);
  if (!res.ok) throw new Error("failed");
  const data = (await res.json()) as AptTransactionArchiveResponse;
  if (typeof window !== "undefined") {
    const ms = Math.round(performance.now() - started);
    console.info(
      `[transactions] year=${params.year} type=${params.type} offset=${params.offset} latency=${ms}ms items=${data.items?.length ?? 0} total=${data.total} kpiMs=${data.timingMs?.kpiMs ?? "-"} pageMs=${data.timingMs?.pageMs ?? "-"}`,
    );
  }
  return data;
}

function YearSelect({
  value,
  years,
  onChange,
}: {
  value: TransactionYear;
  years: number[];
  onChange: (next: TransactionYear) => void;
}) {
  const options = useMemo(() => {
    const set = new Set(years);
    if (value !== "all") {
      const n = Number(value);
      if (Number.isFinite(n)) set.add(n);
    }
    return [...set].sort((a, b) => b - a);
  }, [years, value]);

  return (
    <label className="relative inline-flex min-w-0 max-w-full items-center">
      <span className="sr-only">년도</span>
      <select
        value={value}
        aria-label="조회 연도"
        onChange={(e) => onChange(parseTransactionYear(e.target.value))}
        className="h-9 max-w-full appearance-none rounded-lg border border-slate-200 bg-white py-0 pl-2.5 pr-8 text-sm font-medium text-slate-800"
      >
        <option value="all">전체년도</option>
        {options.map((y) => (
          <option key={y} value={String(y)}>
            {y}년
          </option>
        ))}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-2 h-3.5 w-3.5 text-slate-500"
        aria-hidden
      />
    </label>
  );
}

function KpiCell({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="min-w-0 overflow-hidden px-1 py-1.5 text-center sm:px-3 sm:py-2 sm:text-left">
      <p className="text-[9px] font-medium leading-tight text-slate-500 sm:text-[11px]">
        {label}
      </p>
      <p className="lab-kpi-value mt-0.5 truncate text-[13px] font-semibold leading-tight tabular-nums text-slate-900 sm:text-base">
        {value}
      </p>
      <p className="mt-0.5 truncate text-[9px] leading-snug text-slate-500 sm:text-[11px]">
        {hint}
      </p>
    </div>
  );
}

export function AptTransactionsPage({
  aptName,
  regionSlug,
  gu,
  initialAreaKey,
  initialType,
  initialYear,
}: {
  aptName: string;
  regionSlug: string;
  gu?: string;
  initialAreaKey?: string;
  initialType?: string;
  initialYear?: string;
}) {
  const router = useRouter();
  const aptIdentity = `${aptName}|${regionSlug}|${gu ?? ""}`;
  const [areaOverride, setAreaOverride] = useState<{
    forId: string;
    key: string;
  } | null>(null);
  const [dealType, setDealType] = useState<TransactionTabType>(
    parseTransactionTabType(initialType),
  );
  const [year, setYear] = useState<TransactionYear>(
    parseTransactionYear(initialYear),
  );
  const [offset, setOffset] = useState(0);
  const [listMeta, setListMeta] =
    useState<AptTransactionArchiveResponse | null>(null);

  const areaKey =
    areaOverride?.forId === aptIdentity
      ? areaOverride.key
      : (initialAreaKey ?? "");
  const requestArea = areaKey || listMeta?.areaKey || undefined;

  const query = useQuery({
    queryKey: [
      "apt-transactions",
      aptName,
      regionSlug,
      gu ?? "",
      areaKey,
      dealType,
      year,
      offset,
    ],
    queryFn: () =>
      fetchArchive({
        aptName,
        region: regionSlug,
        gu,
        area: requestArea,
        type: dealType,
        year,
        offset,
      }),
    staleTime: 2 * 60 * 1000,
    placeholderData: (previousData, previousQuery) => {
      if (!previousData || !previousQuery) return undefined;
      const pk = previousQuery.queryKey;
      const sameFilter =
        pk[1] === aptName &&
        pk[2] === regionSlug &&
        pk[3] === (gu ?? "") &&
        pk[4] === areaKey &&
        pk[5] === dealType &&
        pk[6] === year;
      return sameFilter ? previousData : undefined;
    },
  });

  const data = query.data;
  const [items, setItems] = useState(data?.items ?? []);
  const [seenData, setSeenData] = useState(data);

  // Adjust list state when the query result identity changes (React-recommended;
  // avoids cascading renders from synchronizing in an effect).
  if (data !== seenData) {
    setSeenData(data);
    if (data) {
      if (data.metaIncluded !== false) {
        setListMeta(data);
      }
      if (offset === 0) {
        setItems(data.items);
      } else if (!query.isPlaceholderData) {
        setItems((prev) => {
          const seen = new Set(prev.map((i) => i.id));
          const next = [...prev];
          for (const tx of data.items) {
            if (!seen.has(tx.id)) next.push(tx);
          }
          return next;
        });
      }
    }
  }

  useLoadProgressWhen(
    query.isLoading && offset === 0 && items.length === 0,
    query.isLoading ? "거래내역 불러오는 중…" : "",
  );

  const meta = listMeta && listMeta.metaIncluded !== false ? listMeta : data;
  const resolvedAreaKey = meta?.areaKey || areaKey;

  const detailHref = useMemo(() => {
    const qs = new URLSearchParams({ region: regionSlug });
    if (gu?.trim()) qs.set("gu", gu.trim());
    if (resolvedAreaKey) qs.set("area", resolvedAreaKey);
    return `/apt/${encodeURIComponent(aptName)}?${qs.toString()}`;
  }, [aptName, regionSlug, gu, resolvedAreaKey]);

  const syncUrl = useCallback(
    (
      nextArea: string,
      nextType: TransactionTabType,
      nextYear: TransactionYear,
    ) => {
      const qs = new URLSearchParams({
        region: regionSlug,
        area: nextArea,
        type: transactionTypeToParam(nextType),
        year: nextYear,
      });
      if (gu?.trim()) qs.set("gu", gu.trim());
      router.replace(
        `/apt/${encodeURIComponent(aptName)}/transactions?${qs.toString()}`,
        { scroll: false },
      );
    },
    [aptName, regionSlug, gu, router],
  );

  function resetAnd(next: () => void) {
    setOffset(0);
    setItems([]);
    setListMeta(null);
    next();
  }

  useEffect(() => {
    if (areaKey) return;
    if (!data?.areaKey || data.metaIncluded === false) return;
    syncUrl(data.areaKey, dealType, year);
  }, [areaKey, data?.areaKey, data?.metaIncluded, dealType, year, syncUrl]);

  const kpi = meta?.kpi;
  const yearHint = kpiHintForYear(year);
  const activeCount =
    dealType === "trade"
      ? (kpi?.tradeCount ?? 0)
      : dealType === "jeonse"
        ? (kpi?.jeonseCount ?? 0)
        : (kpi?.monthlyCount ?? 0);

  const total = meta?.total ?? 0;
  const hasMore = items.length < total;
  const loadingMore = query.isFetching && offset > 0;

  if (query.isLoading && items.length === 0 && !meta) {
    return (
      <div className={PAGE_WRAP}>
        <div className="h-48 animate-pulse rounded-xl bg-slate-200/70" />
      </div>
    );
  }

  if ((query.isError && !meta) || (!query.isLoading && !meta && !data)) {
    return (
      <div className={`${PAGE_WRAP} text-center`}>
        <p className="text-sm font-medium text-slate-700">
          거래내역을 불러오지 못했습니다.
        </p>
        <div className="mt-3 flex justify-center">
          <BackLink fallback={detailHref} compact />
        </div>
      </div>
    );
  }

  const displayName = meta?.aptName || aptName;
  const years = meta?.years ?? [];
  const areas = meta?.areas ?? [];

  return (
    <div className={PAGE_WRAP}>
      <section className="lab-card overflow-hidden">
        <div className="flex min-h-9 items-center gap-1 px-3 pt-2 sm:px-4 sm:pt-2.5">
          <BackLink fallback={detailHref} compact hideLabel />
          <p className="min-w-0 truncate text-sm font-semibold tracking-tight text-slate-900">
            {displayName}
          </p>
        </div>

        <div className="space-y-2 px-3 pb-2.5 sm:px-4 sm:pb-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <TransactionTypeTabs
              value={dealType}
              onChange={(next) => {
                resetAnd(() => {
                  setDealType(next);
                  syncUrl(resolvedAreaKey || areaKey, next, year);
                });
              }}
              counts={{
                trade: kpi?.tradeCount,
                jeonse: kpi?.jeonseCount,
                monthly: kpi?.monthlyCount,
              }}
            />
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <YearSelect
                value={year}
                years={years}
                onChange={(next) => {
                  resetAnd(() => {
                    setYear(next);
                    syncUrl(resolvedAreaKey || areaKey, dealType, next);
                  });
                }}
              />
              {areas.length > 0 ? (
                <AptAreaSelector
                  areas={areas}
                  value={resolvedAreaKey || areas[0]!.key}
                  onChange={(key) => {
                    resetAnd(() => {
                      setAreaOverride({ forId: aptIdentity, key });
                      syncUrl(key, dealType, year);
                    });
                  }}
                />
              ) : null}
            </div>
          </div>

          <div className="grid grid-cols-3 divide-x divide-slate-100 overflow-hidden rounded-xl border border-slate-100 bg-slate-50/40">
            {dealType === "monthly" ? (
              <>
                <KpiCell
                  label="최고 보증금"
                  value={
                    kpi?.monthlyDepositHigh
                      ? formatEok(kpi.monthlyDepositHigh.amount)
                      : "—"
                  }
                  hint={
                    kpi?.monthlyDepositHigh
                      ? kpiDateShort(kpi.monthlyDepositHigh.date)
                      : "—"
                  }
                />
                <KpiCell
                  label="최고 월세"
                  value={
                    kpi?.monthlyRentHigh
                      ? formatKpiMonthlyRent(kpi.monthlyRentHigh.amount)
                      : "—"
                  }
                  hint={
                    kpi?.monthlyRentHigh
                      ? kpiDateShort(kpi.monthlyRentHigh.date)
                      : "—"
                  }
                />
                <KpiCell
                  label="월세 거래"
                  value={`${activeCount.toLocaleString("ko-KR")}건`}
                  hint={yearHint}
                />
              </>
            ) : (
              <>
                <KpiCell
                  label="매매 최고"
                  value={kpi?.saleHigh ? formatEok(kpi.saleHigh.amount) : "—"}
                  hint={
                    kpi?.saleHigh ? kpiDateShort(kpi.saleHigh.date) : "—"
                  }
                />
                <KpiCell
                  label="전세 최고"
                  value={
                    kpi?.jeonseHigh ? formatEok(kpi.jeonseHigh.amount) : "—"
                  }
                  hint={
                    kpi?.jeonseHigh ? kpiDateShort(kpi.jeonseHigh.date) : "—"
                  }
                />
                <KpiCell
                  label={dealType === "jeonse" ? "전세 거래" : "매매 거래"}
                  value={`${activeCount.toLocaleString("ko-KR")}건`}
                  hint={yearHint}
                />
              </>
            )}
          </div>
        </div>

        <div className="border-t border-slate-100 px-3 pb-3 pt-2 sm:px-4 sm:pb-4">
          <GroupedTransactionList items={items} mode={dealType} />
          {hasMore ? (
            <button
              type="button"
              onClick={() => setOffset((o) => o + PAGE_SIZE)}
              disabled={loadingMore}
              className="lab-button lab-button-secondary mt-3 flex w-full min-h-10 items-center justify-center gap-1.5 text-sm disabled:opacity-60"
            >
              {loadingMore ? (
                <>
                  <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                  불러오는 중…
                </>
              ) : (
                "더보기"
              )}
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
}

"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, LoaderCircle } from "lucide-react";
import { BackLink } from "@/components/layout/BackLink";
import {
  PAGE_HEADER_WITH_BACK,
  PAGE_SHELL,
  PageHeader,
} from "@/components/layout/PageHeader";
import { useLoadProgressWhen } from "@/components/layout/LoadProgress";
import { AptAreaSelector } from "@/components/apt/AptAreaSelector";
import {
  GroupedTransactionList,
  TransactionTypeTabs,
} from "@/components/apt/TransactionHistory";
import {
  filterTransactionsByType,
  parseTransactionTabType,
  transactionTypeLabel,
  transactionTypeToParam,
  type TransactionTabType,
} from "@/lib/apt/transaction-type";
import {
  DEFAULT_TRANSACTION_PERIOD,
  parseTransactionPeriod,
  TRANSACTION_PERIODS,
  transactionPeriodLabel,
  transactionPeriodMonths,
  type TransactionPeriod,
} from "@/lib/apt/transaction-period";
import {
  areaSelectorExclusiveLabel,
  areaSelectorPyeongLabel,
} from "@/lib/apt/area-selector-label";
import {
  isValidAreaKey,
  normalizeAreaKey,
  resolveDefaultAreaKey,
} from "@/lib/apt/default-area";
import type { AptDetailResponse, AptHistoryItem } from "@/lib/molit/apt-client";
import { formatDealDate, formatEok } from "@/lib/utils/format";
import { labSecondaryTabClass } from "@/components/ui/lab";

const PAGE_SIZE = 20;

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
  const started = performance.now();
  const res = await fetch(`/api/apt-detail?${qs.toString()}`);
  if (!res.ok) throw new Error("failed");
  const data = (await res.json()) as AptDetailResponse;
  if (typeof window !== "undefined") {
    const ms = Math.round(performance.now() - started);
    console.info(
      `[transactions] apt-detail months=${months} latency=${ms}ms items=${data.items?.length ?? 0}`,
    );
  }
  return data;
}

function filterByArea(
  data: AptDetailResponse,
  areaKey: string,
): AptDetailResponse["items"] {
  if (areaKey === "all") return data.items;
  const selected = data.areas.find((a) => a.key === areaKey);
  if (
    selected?.selectorKind === "market_group" &&
    selected.exclusiveAreaMin != null &&
    selected.exclusiveAreaMax != null
  ) {
    const min = selected.exclusiveAreaMin - 0.005;
    const max = selected.exclusiveAreaMax + 0.005;
    return data.items.filter((item) => {
      const area = Number(item.exclusiveArea);
      return area >= min && area <= max;
    });
  }
  const matchKey = selected
    ? normalizeAreaKey(selected.exclusiveArea)
    : areaKey;
  return data.items.filter(
    (item) => normalizeAreaKey(Number(item.exclusiveArea)) === matchKey,
  );
}

function summaryDateLabel(dealDate: string): string {
  const full = formatDealDate(dealDate);
  return full.length >= 7 ? full.slice(0, 7) : full;
}

function findPeriodHigh(
  items: AptHistoryItem[],
  mode: TransactionTabType,
): { amount: number; date: string } | null {
  if (mode === "monthly" || items.length === 0) return null;
  let best = items[0]!;
  for (const tx of items) {
    if (tx.dealAmount > best.dealAmount) best = tx;
  }
  return { amount: best.dealAmount, date: best.dealDate };
}

function findMonthlyHighs(items: AptHistoryItem[]): {
  deposit: { amount: number; date: string } | null;
  rent: { amount: number; date: string } | null;
} {
  if (items.length === 0) return { deposit: null, rent: null };
  let bestDeposit = items[0]!;
  let bestRent = items[0]!;
  for (const tx of items) {
    if (tx.dealAmount > bestDeposit.dealAmount) bestDeposit = tx;
    if (Number(tx.monthlyRent ?? 0) > Number(bestRent.monthlyRent ?? 0)) {
      bestRent = tx;
    }
  }
  return {
    deposit: { amount: bestDeposit.dealAmount, date: bestDeposit.dealDate },
    rent: {
      amount: Number(bestRent.monthlyRent ?? 0),
      date: bestRent.dealDate,
    },
  };
}

export function AptTransactionsPage({
  aptName,
  regionSlug,
  gu,
  initialAreaKey,
  initialType,
  initialPeriod,
}: {
  aptName: string;
  regionSlug: string;
  gu?: string;
  initialAreaKey?: string;
  initialType?: string;
  initialPeriod?: string;
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
  const [period, setPeriod] = useState<TransactionPeriod>(
    parseTransactionPeriod(initialPeriod ?? DEFAULT_TRANSACTION_PERIOD),
  );
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const months = transactionPeriodMonths(period);

  const detailQuery = useQuery({
    queryKey: [
      "apt-detail",
      aptName,
      regionSlug,
      gu ?? "",
      "transactions",
      months,
    ],
    queryFn: () => fetchAptDetail(aptName, regionSlug, months, gu),
    staleTime: 5 * 60 * 1000,
    placeholderData: (prev) => prev,
  });

  const data = detailQuery.data;

  useLoadProgressWhen(
    detailQuery.isLoading && !data,
    detailQuery.isLoading && !data ? "거래내역 불러오는 중…" : "",
  );

  const resolvedAreaKey = useMemo(() => {
    if (!data?.areas) return initialAreaKey ?? "all";
    if (initialAreaKey && isValidAreaKey(initialAreaKey, data.areas)) {
      return initialAreaKey;
    }
    return resolveDefaultAreaKey(data.areas, data.items);
  }, [data, initialAreaKey]);

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

  const detailHref = useMemo(() => {
    const qs = new URLSearchParams({ region: regionSlug });
    if (gu?.trim()) qs.set("gu", gu.trim());
    if (areaKey) qs.set("area", areaKey);
    return `/apt/${encodeURIComponent(aptName)}?${qs.toString()}`;
  }, [aptName, regionSlug, gu, areaKey]);

  function syncUrl(
    nextArea: string,
    nextType: TransactionTabType,
    nextPeriod: TransactionPeriod,
  ) {
    const qs = new URLSearchParams({
      region: regionSlug,
      area: nextArea,
      type: transactionTypeToParam(nextType),
      period: nextPeriod,
    });
    if (gu?.trim()) qs.set("gu", gu.trim());
    router.replace(
      `/apt/${encodeURIComponent(aptName)}/transactions?${qs.toString()}`,
      { scroll: false },
    );
  }

  const areaFiltered = useMemo(() => {
    if (!data) return [];
    return filterByArea(data, areaKey);
  }, [data, areaKey]);

  const filtered = useMemo(
    () => filterTransactionsByType(areaFiltered, dealType),
    [areaFiltered, dealType],
  );

  const visible = useMemo(
    () => filtered.slice(0, visibleCount),
    [filtered, visibleCount],
  );

  const tabCounts = useMemo(
    () => ({
      trade: filterTransactionsByType(areaFiltered, "trade").length,
      jeonse: filterTransactionsByType(areaFiltered, "jeonse").length,
      monthly: filterTransactionsByType(areaFiltered, "monthly").length,
    }),
    [areaFiltered],
  );

  const selectedArea = useMemo(
    () => data?.areas.find((a) => a.key === areaKey) ?? null,
    [data, areaKey],
  );

  const periodHigh = useMemo(
    () => findPeriodHigh(filtered, dealType),
    [filtered, dealType],
  );
  const monthlyHighs = useMemo(
    () => (dealType === "monthly" ? findMonthlyHighs(filtered) : null),
    [filtered, dealType],
  );

  const hasMore = visibleCount < filtered.length;
  const exhausted = !hasMore && filtered.length > 0;

  const locationLabel = data
    ? `${data.fullName}${data.dong ? ` ${data.dong}` : ""}`.trim()
    : "";

  const areaSummary =
    selectedArea && areaKey !== "all"
      ? `${areaSelectorPyeongLabel(selectedArea)} · ${areaSelectorExclusiveLabel(selectedArea)}`
      : "전체 면적";

  if (detailQuery.isLoading && !data) {
    return (
      <div className={`${PAGE_SHELL} max-w-5xl`}>
        <div className="h-20 animate-pulse rounded-xl bg-slate-200/70" />
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="h-14 animate-pulse rounded-xl bg-slate-200/50"
            />
          ))}
        </div>
      </div>
    );
  }

  if ((detailQuery.isError && !data) || !data) {
    return (
      <div className={`${PAGE_SHELL} max-w-5xl text-center`}>
        <p className="text-sm font-medium text-slate-700">
          거래내역을 불러오지 못했습니다.
        </p>
        <div className="mt-3 flex justify-center">
          <BackLink fallback={detailHref} className="hidden sm:inline-flex" />
        </div>
      </div>
    );
  }

  return (
    <div className={`${PAGE_SHELL} max-w-5xl overflow-x-clip`}>
      <header className={PAGE_HEADER_WITH_BACK}>
        <BackLink fallback={detailHref} className="hidden sm:inline-flex" />
        <PageHeader
          title={data.aptName}
          description="거래내역"
          meta={locationLabel ? <span>{locationLabel}</span> : undefined}
          showDivider
        />
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

      <section className="lab-card space-y-4 p-4 sm:p-5">
        {/* 1. Transaction type */}
        <div className="space-y-1.5">
          <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
            거래유형
          </p>
          <TransactionTypeTabs
            value={dealType}
            onChange={(next) => {
              setDealType(next);
              setVisibleCount(PAGE_SIZE);
              syncUrl(areaKey, next, period);
            }}
            counts={tabCounts}
          />
        </div>

        {/* 2. Period */}
        <div className="space-y-1.5">
          <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
            기간
          </p>
          <div
            className="flex w-fit flex-wrap items-center gap-1"
            role="group"
            aria-label="조회 기간"
          >
            {TRANSACTION_PERIODS.map((p) => {
              const pressed = period === p.value;
              return (
                <button
                  key={p.value}
                  type="button"
                  aria-pressed={pressed}
                  className={labSecondaryTabClass(pressed)}
                  onClick={() => {
                    setPeriod(p.value);
                    setVisibleCount(PAGE_SIZE);
                    syncUrl(areaKey, dealType, p.value);
                  }}
                >
                  {p.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* 3. Area / pyeong (Phase5 AptAreaSelector) */}
        <div className="space-y-1.5">
          <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
            평형
          </p>
          <AptAreaSelector
            areas={data.areas}
            value={areaKey}
            onChange={(key) => {
              setAreaOverride({ forId: aptIdentity, key });
              setVisibleCount(PAGE_SIZE);
              syncUrl(key, dealType, period);
            }}
          />
        </div>

        {/* 4. Filter summary */}
        <div className="rounded-lg border border-slate-200/80 bg-slate-50/70 px-3 py-2.5 sm:px-3.5">
          <p className="text-xs text-slate-500">
            <span className="font-medium text-slate-700">
              {transactionTypeLabel(dealType)}
            </span>
            <span className="text-slate-300"> · </span>
            <span>{transactionPeriodLabel(period)}</span>
            <span className="text-slate-300"> · </span>
            <span>{areaSummary}</span>
            <span className="text-slate-300"> · </span>
            <span className="tabular-nums">
              총 {filtered.length.toLocaleString("ko-KR")}건
            </span>
          </p>

          {dealType !== "monthly" && periodHigh ? (
            <p className="mt-1.5 text-sm text-slate-800">
              <span className="text-xs text-slate-500">
                기간 최고 {transactionTypeLabel(dealType)}
              </span>
              <span className="ml-2 font-semibold tabular-nums text-[color:var(--lab-navy-950)]">
                {formatEok(periodHigh.amount)}
              </span>
              <span className="ml-1.5 text-xs tabular-nums text-slate-500">
                {summaryDateLabel(periodHigh.date)}
              </span>
            </p>
          ) : null}

          {dealType === "monthly" && monthlyHighs ? (
            <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-800">
              {monthlyHighs.deposit ? (
                <p>
                  <span className="text-xs text-slate-500">최고 보증금</span>
                  <span className="ml-2 font-semibold tabular-nums">
                    {formatEok(monthlyHighs.deposit.amount)}
                  </span>
                  <span className="ml-1.5 text-xs tabular-nums text-slate-500">
                    {summaryDateLabel(monthlyHighs.deposit.date)}
                  </span>
                </p>
              ) : null}
              {monthlyHighs.rent && monthlyHighs.rent.amount > 0 ? (
                <p>
                  <span className="text-xs text-slate-500">최고 월세</span>
                  <span className="ml-2 font-semibold tabular-nums">
                    {monthlyHighs.rent.amount.toLocaleString("ko-KR")}만원
                  </span>
                  <span className="ml-1.5 text-xs tabular-nums text-slate-500">
                    {summaryDateLabel(monthlyHighs.rent.date)}
                  </span>
                </p>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* 5. Transaction list */}
        <div className="space-y-3">
          <p className="text-xs text-slate-500">최신순 · 계약일</p>
          <GroupedTransactionList items={visible} mode={dealType} />
        </div>

        {hasMore ? (
          <button
            type="button"
            onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
            className="lab-button lab-button-secondary flex w-full min-h-10 items-center justify-center gap-1.5 text-sm"
          >
            더보기
          </button>
        ) : null}

        {exhausted ? (
          <p className="text-center text-xs text-slate-500">
            {transactionPeriodLabel(period)} 기간 내 거래를 모두 표시했습니다
            {detailQuery.isFetching ? (
              <span className="ml-1 inline-flex items-center gap-1">
                <LoaderCircle className="h-3 w-3 animate-spin" />
              </span>
            ) : null}
          </p>
        ) : null}
      </section>
    </div>
  );
}

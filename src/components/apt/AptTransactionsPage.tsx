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
  TransactionList,
  TransactionTypeTabs,
} from "@/components/apt/TransactionHistory";
import {
  filterTransactionsByType,
  parseTransactionTabType,
  type TransactionTabType,
} from "@/lib/apt/transaction-type";
import {
  areaSelectorExclusiveLabel,
  areaSelectorPyeongLabel,
} from "@/lib/apt/area-selector-label";
import {
  isValidAreaKey,
  normalizeAreaKey,
  resolveDefaultAreaKey,
} from "@/lib/apt/default-area";
import type { AptDetailResponse } from "@/lib/molit/apt-client";

const PAGE_SIZE = 20;
const QUICK_MONTHS = 36;
const FULL_MONTHS = 120;

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

export function AptTransactionsPage({
  aptName,
  regionSlug,
  gu,
  initialAreaKey,
  initialType,
}: {
  aptName: string;
  regionSlug: string;
  gu?: string;
  initialAreaKey?: string;
  initialType?: string;
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
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [extendingReveal, setExtendingReveal] = useState(false);

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
  const isExtendingHistory =
    quickQuery.isSuccess && !fullQuery.isSuccess && fullQuery.isFetching;

  useLoadProgressWhen(
    (quickQuery.isLoading && !data) || isExtendingHistory || extendingReveal,
    quickQuery.isLoading && !data ? "거래내역 불러오는 중…" : "",
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

  function syncUrl(nextArea: string, nextType: TransactionTabType) {
    const qs = new URLSearchParams({
      region: regionSlug,
      area: nextArea,
      type: nextType,
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

  const canShowMoreFromLoaded = visibleCount < filtered.length;
  const waitingForFull =
    !canShowMoreFromLoaded &&
    !fullQuery.isSuccess &&
    (fullQuery.isFetching || quickQuery.isSuccess);
  const hasMore = canShowMoreFromLoaded || waitingForFull || isExtendingHistory;
  const exhausted =
    fullQuery.isSuccess && !canShowMoreFromLoaded && filtered.length > 0;

  async function onLoadMore() {
    if (canShowMoreFromLoaded) {
      setVisibleCount((c) => c + PAGE_SIZE);
      return;
    }
    if (fullQuery.isSuccess) return;
    setExtendingReveal(true);
    try {
      const result = await fullQuery.refetch();
      const nextItems = result.data ? filterByArea(result.data, areaKey) : [];
      const nextFiltered = filterTransactionsByType(nextItems, dealType);
      setVisibleCount((c) =>
        Math.min(c + PAGE_SIZE, Math.max(nextFiltered.length, c)),
      );
    } finally {
      setExtendingReveal(false);
    }
  }

  if (quickQuery.isLoading && !data) {
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

  if ((quickQuery.isError && !data) || !data) {
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
          meta={
            selectedArea && areaKey !== "all" ? (
              <span>
                {areaSelectorPyeongLabel(selectedArea)}
                <span className="text-slate-300"> · </span>
                {areaSelectorExclusiveLabel(selectedArea)}
              </span>
            ) : (
              <span>전체 면적</span>
            )
          }
        >
          <AptAreaSelector
            areas={data.areas}
            value={areaKey}
            onChange={(key) => {
              setAreaOverride({ forId: aptIdentity, key });
              setVisibleCount(PAGE_SIZE);
              syncUrl(key, dealType);
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

      <section className="lab-card space-y-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-slate-500">
            {filtered.length.toLocaleString("ko-KR")}건 · 최신순
            {data.partial || !fullQuery.isSuccess
              ? ` · 최근 ${data.loadedMonths}개월`
              : ` · 최근 ${FULL_MONTHS}개월`}
          </p>
          <TransactionTypeTabs
            value={dealType}
            onChange={(next) => {
              setDealType(next);
              setVisibleCount(PAGE_SIZE);
              syncUrl(areaKey, next);
            }}
            counts={tabCounts}
          />
        </div>

        <TransactionList items={visible} mode={dealType} />

        {hasMore ? (
          <button
            type="button"
            onClick={() => void onLoadMore()}
            disabled={extendingReveal || isExtendingHistory}
            className="lab-button lab-button-secondary flex w-full min-h-10 items-center justify-center gap-1.5 text-sm disabled:opacity-60"
          >
            {extendingReveal || isExtendingHistory ? (
              <>
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                불러오는 중…
              </>
            ) : (
              "더보기"
            )}
          </button>
        ) : null}

        {exhausted ? (
          <p className="text-center text-xs text-slate-500">
            최근 {FULL_MONTHS}개월 내 거래를 모두 표시했습니다
          </p>
        ) : null}
      </section>
    </div>
  );
}

"use client";

import {
  use,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
} from "lucide-react";
import { BackLink } from "@/components/layout/BackLink";
import { ComplexHeroMeta } from "@/components/apt/ComplexHeroMeta";
import { complexHeroMeta } from "@/lib/complex-detail/hero-meta";
import { ComplexJeonseBenchmark } from "@/components/apt/ComplexJeonseBenchmark";
import { ComplexTradeActivity } from "@/components/apt/ComplexTradeActivity";
import { ComplexRentMetrics } from "@/components/apt/ComplexRentMetrics";
import { SaveComplexButton } from "@/components/complexes/SaveComplexButton";
import type { ComplexDetailV1 } from "@/lib/complex-detail/get-complex-detail-v1";
import { getRegion } from "@/lib/constants/regions";
import type { AptDetailResponse } from "@/lib/molit/apt-client";
import { APT_DETAIL_MONTHS, buildAptDetailUrl } from "@/lib/apt/apt-detail-url";
import { unpackAptDetail } from "@/lib/molit/apt-detail-wire";
import {
  AptPriceChart,
  PeriodRangeSlider,
} from "@/components/apt/AptPriceChart";
import { AptAreaSelector } from "@/components/apt/AptAreaSelector";
import { areaOptionContains, resolveAreaKeyAlias } from "@/lib/apt/area-groups";
import { AptStickyNav } from "@/components/apt/AptStickyNav";
import {
  TransactionList,
} from "@/components/apt/TransactionHistory";
import {
  filterTransactionsByType,
  filterTransactionsForList,
  dealTypePriceTextClass,
  type TransactionTabType,
} from "@/lib/apt/transaction-type";
import {
  areaSelectorClosedLabel,
  areaSelectorPyeongLabel,
} from "@/lib/apt/area-selector-label";
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
  DETAIL_PAGE_SHELL,
  PageHeader,
} from "@/components/layout/PageHeader";
import { useLoadProgressWhen } from "@/components/layout/LoadProgress";
import { LabSectionLoading } from "@/components/ui/LabLoading";
import { LabTabs } from "@/components/ui/LabTabs";
import { Complex3dEntryCard } from "@/components/complex-3d/Complex3dEntry";
import { ComplexRedevSection } from "@/components/apt/ComplexRedevSection";
import { attachTypeSupply, fetchComplexTypes } from "@/lib/apt/area-supply";
import { pickLatestDeal } from "@/lib/deals/latest";

const DETAIL_PICK = {
  date: (i: { dealDate: string }) => i.dealDate,
  floor: (i: { floor?: number | string | null }) => (i.floor == null || i.floor === "" ? null : Number(i.floor)),
  amount: (i: { dealAmount: number }) => Number(i.dealAmount),
  gbn: (i: { dealingGbn?: string | null }) => i.dealingGbn ?? null,
};
import {
  LAB_SUBSECTION_RULE,
  LabSection,
  LabSubsectionHeader,
} from "@/components/ui/LabSection";
import { LabStatTiles } from "@/components/ui/LabStatTiles";
import { LabSectionBoundary } from "@/components/ui/LabSectionBoundary";
import { lazySection } from "@/components/ui/lazySection";
import {
  LazyMountProvider,
  scrollToSectionWhenReady,
  useMountAllLazy,
} from "@/components/ui/LazyMountWhenNear";
import {
  formatDealDate,
  formatEok,
} from "@/lib/utils/format";

/** DB 모드는 months와 무관하게 전체 이력을 주므로 한 번에 120개월로 요청 */
const DETAIL_MONTHS = APT_DETAIL_MONTHS;
const RECENT_YEARS = 3;

/*
 * 첫 화면(헤더·실거래 현황·차트) 아래 섹션은 따로 받는다 — 첫 로드 JS에서 빼고,
 * 시세가 뜬 뒤 한가할 때 미리 받아 둔다(preloadSectionChunks).
 */
const loadTradeInsight = () =>
  import("@/components/apt/ComplexTradeInsightSection").then((m) => m.ComplexTradeInsightSection);
const loadTypeDong = () =>
  import("@/components/apt/ComplexTypeDongSection").then((m) => m.ComplexTypeDongSection);
const loadUnitMix = () =>
  import("@/components/apt/ComplexUnitMixSection").then((m) => m.ComplexUnitMixSection);
const loadCalculator = () =>
  import("@/components/apt/calculator/ComplexPurchaseCalculatorSection").then(
    (m) => m.ComplexPurchaseCalculatorSection,
  );
const loadRegionRank = () =>
  import("@/components/apt/ComplexRegionRankSection").then((m) => m.ComplexRegionRankSection);
const loadCompare = () =>
  import("@/components/apt/ComplexCompareSection").then((m) => m.ComplexCompareSection);
const loadNearbyLife = () =>
  import("@/components/apt/ComplexNearbyLifeSection").then((m) => m.ComplexNearbyLifeSection);
const loadNearbySales = () =>
  import("@/components/apt/ComplexNearbySalesSection").then((m) => m.ComplexNearbySalesSection);
const loadMgmtFeeCard = () =>
  import("@/components/apt/ComplexMgmtFeeCard").then((m) => m.ComplexMgmtFeeCard);
const loadMgmtFeeEmpty = () =>
  import("@/components/apt/ComplexMgmtFeeCard").then((m) => m.ComplexMgmtFeeEmpty);

const ComplexTradeInsightSection = lazySection(loadTradeInsight);
const ComplexTypeDongSection = lazySection(loadTypeDong);
const ComplexUnitMixSection = lazySection(loadUnitMix);
const ComplexPurchaseCalculatorSection = lazySection(loadCalculator);
const ComplexRegionRankSection = lazySection(loadRegionRank);
const ComplexCompareSection = lazySection(loadCompare);
const ComplexNearbyLifeSection = lazySection(loadNearbyLife);
const ComplexNearbySalesSection = lazySection(loadNearbySales);
const ComplexMgmtFeeCard = lazySection(loadMgmtFeeCard);
const ComplexMgmtFeeEmpty = lazySection(loadMgmtFeeEmpty);

const LAZY_SECTIONS = [
  ComplexTradeInsightSection,
  ComplexTypeDongSection,
  ComplexUnitMixSection,
  ComplexPurchaseCalculatorSection,
  ComplexRegionRankSection,
  ComplexCompareSection,
  ComplexNearbyLifeSection,
  ComplexNearbySalesSection,
  ComplexMgmtFeeCard,
  ComplexMgmtFeeEmpty,
];

let sectionChunksRequested = false;
/** 시세가 뜬 뒤 한가할 때 섹션 코드만 미리 받는다(데이터 요청은 섹션이 마운트될 때). */
function preloadSectionChunks(): () => void {
  if (sectionChunksRequested || typeof window === "undefined") return () => {};
  const run = () => {
    sectionChunksRequested = true;
    for (const section of LAZY_SECTIONS) void section.preload();
  };
  if (typeof window.requestIdleCallback === "function") {
    const id = window.requestIdleCallback(run, { timeout: 3000 });
    return () => window.cancelIdleCallback(id);
  }
  const t = window.setTimeout(run, 300);
  return () => window.clearTimeout(t);
}

async function fetchAptDetail(
  aptName: string,
  region: string,
  months: number,
  gu?: string,
): Promise<AptDetailResponse> {
  // page.tsx가 같은 주소로 preload해 두므로 JS가 늦게 떠도 요청은 HTML 파싱 때 이미 출발해 있다.
  const res = await fetch(buildAptDetailUrl({ aptName, region, months, gu }));
  if (!res.ok) throw new Error("failed");
  return unpackAptDetail(await res.json());
}

/**
 * 시세가 오기 전 첫 화면 자리 — 서버 스트리밍 대기(page.tsx Suspense)와 시세 첫 로딩이 같은 모양.
 * 회색 상자 대신 섹션 로딩 + 화면 맨 위 진행 막대.
 */
export function AptDetailSkeleton() {
  useLoadProgressWhen(true, "시세 불러오는 중…", "apt-shell");
  return (
    <div className={DETAIL_PAGE_SHELL}>
      <LabSectionLoading title="실거래 현황" label="시세 불러오는 중" minHeight={280} />
    </div>
  );
}

/**
 * 한 번 받은 단지정보를 기억 — 이미 본 단지로 다시 들어오면(시세도 React Query에 있음)
 * 서버가 새로 스트리밍하는 단지정보를 기다리느라 첫 화면 자리가 번쩍이지 않게, 기억한 값으로 바로 그린다.
 * 새로 온 값은 도착하면 바꿔 끼운다. 표시하는 내용만 담는다(단지당 한 건, 탭을 닫으면 사라짐).
 */
const complexDetailMemory = new Map<string, ComplexDetailV1 | null>();
const COMPLEX_DETAIL_MEMORY_MAX = 30;

function rememberComplexDetail(key: string, value: ComplexDetailV1 | null) {
  complexDetailMemory.delete(key);
  complexDetailMemory.set(key, value);
  if (complexDetailMemory.size > COMPLEX_DETAIL_MEMORY_MAX) {
    const oldest = complexDetailMemory.keys().next().value;
    if (oldest !== undefined) complexDetailMemory.delete(oldest);
  }
}

function useStreamedComplexDetail({
  memoryKey,
  promise,
  fallback,
  ready,
}: {
  memoryKey: string;
  promise: Promise<ComplexDetailV1 | null> | undefined;
  fallback: ComplexDetailV1 | null;
  /** 시세가 온 뒤에만 읽는다 — 그 전(서버 렌더 포함)에는 단지정보를 기다리지 않는다. */
  ready: boolean;
}): ComplexDetailV1 | null {
  const [fresh, setFresh] = useState<{
    promise: Promise<ComplexDetailV1 | null>;
    value: ComplexDetailV1 | null;
  } | null>(null);

  useEffect(() => {
    if (!promise) return;
    let cancelled = false;
    promise.then(
      (value) => {
        rememberComplexDetail(memoryKey, value);
        if (!cancelled) setFresh({ promise, value });
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [memoryKey, promise]);

  if (!promise) return fallback;
  if (fresh && fresh.promise === promise) return fresh.value;
  if (!ready) return fallback;
  if (complexDetailMemory.has(memoryKey)) return complexDetailMemory.get(memoryKey) ?? null;
  // `use`는 조건부 호출 가능 — 기억한 값이 없을 때만 스트리밍 도착을 기다린다(보통 시세보다 먼저 온다).
  return use(promise);
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

type PeriodPreset = "recent1" | "recent3" | "recent5" | "full" | "custom";

export function AptDetailPage({
  aptName,
  regionSlug,
  gu,
  initialAreaKey,
  complexDetail: complexDetailProp = null,
  complexDetailPromise,
  initialNearbyTab,
  initialSchoolLevel,
}: {
  aptName: string;
  regionSlug: string;
  gu?: string;
  /** URL ?area= — 명시 시 자동 기본값보다 우선 */
  initialAreaKey?: string;
  /** Phase 7.2 enrichment (nullable; market must render without it) */
  complexDetail?: ComplexDetailV1 | null;
  /**
   * 서버가 기다리지 않고 넘기는 단지정보(스트리밍). 시세가 온 뒤에만 읽으므로
   * 셸 HTML·시세 요청은 이것을 기다리지 않는다. 보통 시세보다 먼저 도착한다.
   */
  complexDetailPromise?: Promise<ComplexDetailV1 | null>;
  initialNearbyTab?: string;
  /** Restore school-level sub-tab when returning from school detail. */
  initialSchoolLevel?: string;
}) {
  const aptIdentity = `${aptName}|${regionSlug}|${gu ?? ""}`;
  /** 사용자/수동 선택. aptIdentity가 바뀌면 자동 기본값으로 복귀 */
  const [areaOverride, setAreaOverride] = useState<{
    forId: string;
    key: string;
  } | null>(null);
  const [dealFilter, setDealFilter] = useState<TransactionTabType>("trade");
  const [rangeOverride, setRangeOverride] = useState<{
    start: number;
    end: number;
  } | null>(null);
  const [boundKey, setBoundKey] = useState(aptIdentity);
  const [periodPreset, setPeriodPreset] = useState<PeriodPreset>("recent3");
  const [monthSelection, setMonthSelection] = useState<{
    scope: string;
    ym: string | null;
  }>({ scope: "", ym: null });
  const stickyAnchorRef = useRef<HTMLDivElement | null>(null);

  // quick(36)→full(120) 두 번 받던 것을 한 번으로: 서버가 어차피 전체 이력을 줌
  const detailQuery = useQuery({
    queryKey: ["apt-detail", aptName, regionSlug, gu ?? "", "full", DETAIL_MONTHS],
    queryFn: () => fetchAptDetail(aptName, regionSlug, DETAIL_MONTHS, gu),
    staleTime: 30 * 60 * 1000,
  });

  const data = detailQuery.data;
  const complexDetail = useStreamedComplexDetail({
    memoryKey: `${aptName}|${regionSlug}|${gu ?? ""}`,
    promise: complexDetailPromise,
    fallback: complexDetailProp,
    ready: !!data,
  });

  /** URL > 84㎡대/거래량 자동 > all */
  const resolvedAreaKey = useMemo(() => {
    if (!data?.areas) return initialAreaKey ?? "all";
    if (initialAreaKey && isValidAreaKey(initialAreaKey, data.areas)) {
      return initialAreaKey;
    }
    // 예전 링크의 전용 key("84.98")는 그 전용이 든 묶음 평형으로
    const aliased = initialAreaKey ? resolveAreaKeyAlias(initialAreaKey, data.areas) : null;
    if (aliased) return aliased;
    return resolveDefaultAreaKey(data.areas, data.items);
  }, [data, initialAreaKey]);

  /** 단지당 최초 확정값 (재조회로 데이터가 바뀌어도 선택값이 바뀌지 않게) */
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

  useLoadProgressWhen(detailQuery.isLoading && !data, "시세 불러오는 중…");

  const hasData = !!data;
  useEffect(() => {
    if (!hasData) return;
    return preloadSectionChunks();
  }, [hasData]);

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
      : periodPreset === "recent1"
        ? recentYearsRange(chartMonths.length, 1)
        : periodPreset === "recent5"
          ? recentYearsRange(chartMonths.length, 5)
          : recentYearsRange(chartMonths.length, RECENT_YEARS);

  const startIndex = rangeOverride?.start ?? defaultRange.start;
  const endIndex = rangeOverride?.end ?? defaultRange.end;
  const startYm = chartMonths[startIndex] ?? "";
  const endYm = chartMonths[endIndex] ?? "";

  const areaFiltered = useMemo(() => {
    if (!data) return [];
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
  }, [data, areaKey]);

  // 평형 목록의 공급면적 — 타입·동 섹션과 같은 캐시(complex-types)를 쓴다
  const typesComplexId = complexDetail?.identity?.complexId ?? null;
  const typesQuery = useQuery({
    queryKey: ["complex-types", typesComplexId],
    queryFn: () => fetchComplexTypes(typesComplexId!),
    enabled: !!typesComplexId,
    staleTime: 60 * 60 * 1000,
  });
  const areasWithSupply = useMemo(() => {
    const withSupply = attachTypeSupply(data?.areas ?? [], typesQuery.data?.types ?? []);
    // 평형 시트에 보여줄 평형별 최근 매매 실거래
    const trades = filterTransactionsByType(data?.items ?? [], "trade");
    return withSupply.map((area) => {
      const tx = trades.find((t) => areaOptionContains(area, Number(t.exclusiveArea)));
      return tx
        ? { ...area, latestTrade: { amount: tx.dealAmount, date: tx.dealDate, singoga: tx.isSingoga } }
        : { ...area, latestTrade: null };
    });
  }, [data, typesQuery.data]);

  const selectedArea = useMemo(
    () => areasWithSupply.find((a) => a.key === areaKey) ?? null,
    [areasWithSupply, areaKey],
  );

  const periodItems = (() => {
    if (!startYm || !endYm) return areaFiltered;
    return areaFiltered.filter((item) => {
      const ym = ymFromDealDate(item.dealDate);
      return ym >= startYm && ym <= endYm;
    });
  })();

  // Summary list shares area + period + deal-type with the chart.
  // 전월세 탭: 차트는 전세만, 거래내역은 전세+월세.
  const chartDealType: TransactionTabType =
    dealFilter === "monthly" ? "jeonse" : dealFilter;
  const listDealMode =
    chartDealType === "trade" ? ("trade" as const) : ("rent" as const);

  const monthScope = `${areaKey}|${chartDealType}|${startYm}|${endYm}`;
  const selectedMonthYm =
    monthSelection.scope === monthScope ? monthSelection.ym : null;
  const setSelectedMonthYm = (ym: string | null) => {
    setMonthSelection({ scope: monthScope, ym });
  };

  const listSourceItems = useMemo(() => {
    const base = selectedMonthYm
      ? periodItems.filter(
          (item) => ymFromDealDate(item.dealDate) === selectedMonthYm,
        )
      : periodItems;
    return filterTransactionsForList(base, listDealMode);
  }, [periodItems, selectedMonthYm, listDealMode]);

  const LIST_PREVIEW = 5;
  const visibleTrades = listSourceItems.slice(0, LIST_PREVIEW);

  /** Chart overlays: 매매 or 전세 only (월세는 그래프 미표현). */
  const chartDeals = useMemo(
    () =>
      filterTransactionsByType(
        periodItems,
        chartDealType === "trade" ? "trade" : "jeonse",
      ),
    [periodItems, chartDealType],
  );
  const chartPoints = (() => {
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
  })();

  const periodTradeCount = periodItems.filter(
    (i) => i.dealType === "trade",
  ).length;
  /** Area-wide peak for 최고가 대비 — independent of chart period / deal tab. */
  const areaTradeMax =
    areaFiltered
      .filter((i) => i.dealType === "trade")
      .reduce((m, i) => Math.max(m, i.dealAmount), 0) || 0;

  // 최근 매매·전세: 선택 평수(area) 기준 최신건. 기간 슬라이더와 독립.
  // 최근 거래 — 지도와 같은 규칙 (매매 직거래 제외 · 전세 갱신 제외 · 같은 날이면 높은 층)
  const latestTrade = useMemo(
    () => pickLatestDeal(areaFiltered.filter((i) => i.dealType === "trade"), "trade", DETAIL_PICK),
    [areaFiltered],
  );

  const vsMaxPct =
    latestTrade && areaTradeMax > 0
      ? Math.round((latestTrade.dealAmount / areaTradeMax - 1) * 1000) / 10
      : null;

  const latestJeonse = useMemo(
    () =>
      pickLatestDeal(
        areaFiltered.filter((i) => i.dealType === "rent" && Number(i.monthlyRent ?? 0) === 0),
        "jeonse",
        DETAIL_PICK,
      ),
    [areaFiltered],
  );

  const periodJeonseCount = periodItems.filter(
    (i) => i.dealType === "rent" && Number(i.monthlyRent ?? 0) === 0,
  ).length;

  const jeonseRatio =
    latestTrade && latestJeonse && latestTrade.dealAmount > 0
      ? Math.round((latestJeonse.dealAmount / latestTrade.dealAmount) * 1000) /
        10
      : null;
  const saleJeonseGap =
    latestTrade && latestJeonse
      ? latestTrade.dealAmount - latestJeonse.dealAmount
      : null;

  const transactionsHref = useMemo(() => {
    const qs = new URLSearchParams({
      region: regionSlug,
      area: areaKey,
      type: dealFilter === "trade" ? "sale" : dealFilter,
      year: "all",
    });
    if (gu?.trim()) qs.set("gu", gu.trim());
    return `/apt/${aptName}/transactions?${qs.toString()}`;
  }, [aptName, regionSlug, gu, areaKey, dealFilter]);


  const setRecentYears = (years: number) => {
    if (chartMonths.length === 0) return;
    const preset =
      years === 1
        ? "recent1"
        : years === 3
          ? "recent3"
          : years === 5
            ? "recent5"
            : "custom";
    setPeriodPreset(preset);
    setRangeOverride(recentYearsRange(chartMonths.length, years));
  };

  const setFullRange = () => {
    if (chartMonths.length === 0) return;
    setPeriodPreset("full");
    setRangeOverride({ start: 0, end: chartMonths.length - 1 });
  };

  // 계산기 화면에서 돌아옴(#calculator): 계산기 섹션이 마운트·배치된 뒤 스크롤(아래 섹션은 해시가 있으면 바로 마운트된다)
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.location.hash !== "#calculator") return;
    return scrollToSectionWhenReady("section-calculator");
  }, []);

  /**
   * Only when returning from school detail (?nearbyTab=school#section-nearby-life):
   * scroll to 주변 생활 once it is mounted and laid out, then strip restore markers so a later fresh apt entry
   * defaults to 교통 again.
   */
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (initialNearbyTab !== "school") return;
    if (window.location.hash !== "#section-nearby-life") return;
    return scrollToSectionWhenReady("section-nearby-life", {
      onScrolled: () => {
        try {
          const u = new URL(window.location.href);
          u.searchParams.delete("nearbyTab");
          u.searchParams.delete("schoolLevel");
          u.hash = "";
          window.history.replaceState(
            window.history.state,
            "",
            `${u.pathname}${u.search}`,
          );
        } catch {
          /* ignore */
        }
      },
    });
  }, [initialNearbyTab]);

  const periodButtons = (
    <LabTabs
      variant="compact"
      ariaLabel="시세 기간"
      equalWidth={false}
      allowEmpty
      value={
        periodPreset === "recent1" ||
        periodPreset === "recent3" ||
        periodPreset === "recent5" ||
        periodPreset === "full"
          ? periodPreset
          : null
      }
      items={[
        { id: "recent1", label: "1년" },
        { id: "recent3", label: "3년" },
        { id: "recent5", label: "5년" },
        { id: "full", label: "전체" },
      ]}
      onChange={(next) => {
        if (next === "full") setFullRange();
        else if (next === "recent1") setRecentYears(1);
        else if (next === "recent3") setRecentYears(3);
        else setRecentYears(5);
      }}
    />
  );


  if (detailQuery.isLoading && !data) {
    return <AptDetailSkeleton />;
  }

  if ((detailQuery.isError && !data) || !data) {
    return (
      <div className={`${DETAIL_PAGE_SHELL} text-center`}>
        <p className="detail-body font-medium text-[color:var(--lab-navy-950)]">
          단지 정보를 불러오지 못했습니다.
        </p>
        <div className="mt-3 flex justify-center">
          <BackLink fallback="/complexes" className="hidden sm:inline-flex" />
        </div>
      </div>
    );
  }

  const identity = complexDetail?.identity;
  const region = getRegion(regionSlug);
  /** Prefer master identity; fall back to ?gu= then region display name (e.g. 송파구). */
  const nearbySigungu =
    identity?.sigungu?.trim() ||
    gu?.trim() ||
    region?.name?.trim() ||
    null;
  /** 단지 시군구 코드 — 없으면 지역이 구 하나일 때만 그 코드 */
  const nearbyLawdCd =
    identity?.lawdCd?.trim() ||
    (region?.lawdCodes.length === 1 ? region.lawdCodes[0] : null) ||
    null;
  const locationLabel =
    identity?.sigungu || identity?.legalDongName
      ? [identity.sido, identity.sigungu, identity.legalDongName]
          .filter(Boolean)
          .join(" ")
      : `${data.fullName}${data.dong ? ` ${data.dong}` : ""}`;
  const heroMeta = complexHeroMeta({
    sido: identity?.sido,
    sigungu: identity?.sigungu,
    legalDongName: identity?.legalDongName,
    approvalDate: complexDetail?.basic?.approvalDate,
    buildYear: data.buildYear,
    householdCount: complexDetail?.basic?.householdCount,
    buildingCount: complexDetail?.basic?.buildingCount,
    maxFloor: complexDetail?.building?.maxFloor,
    parkingPerHousehold: complexDetail?.basic?.parkingPerHousehold,
    farRatio: complexDetail?.building?.farRatio,
    bcrRatio: complexDetail?.building?.bcrRatio,
    heatingType: complexDetail?.basic?.heatingType,
    locationFallback: locationLabel,
  });

  return (
    <LazySectionShell className={DETAIL_PAGE_SHELL}>
      <AptStickyNav
        anchor={stickyAnchorRef}
        aptName={data.aptName}
        areas={areasWithSupply}
        areaKey={areaKey}
        onAreaChange={(key) => setAreaOverride({ forId: aptIdentity, key })}
      />

      <header className="-mt-1 sm:-mt-1.5">
        <PageHeader
          leading={
            <BackLink fallback="/complexes" compact hideLabel />
          }
          title={data.aptName}
          titleSuffix={heroMeta.location ?? undefined}
          titleClassName="detail-page-title"
          action={
            <SaveComplexButton
              entry={{
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
                snapshot: latestTrade
                  ? {
                      areaLabel:
                        areaKey === "all" || !selectedArea
                          ? "전체 면적"
                          : areaSelectorClosedLabel(selectedArea),
                      latestTradeMan: latestTrade.dealAmount,
                      latestTradeDate: latestTrade.dealDate,
                    }
                  : null,
              }}
            />
          }
          showDivider={false}
        >
          {/* 라벨 행은 전체 폭 children 슬롯 (지역 헤더와 같음) — meta 슬롯은 제목 옆이라 좁다. */}
          <ComplexHeroMeta
            lines={heroMeta}
            extraTags={[
              complexDetail?.basic?.managementType,
              complexDetail?.building?.structureType,
            ]}
          />
          <AptAreaSelector
            areas={areasWithSupply}
            value={areaKey}
            onChange={(key) => {
              setAreaOverride({ forId: aptIdentity, key });
            }}
          />
        </PageHeader>
        <div ref={stickyAnchorRef} aria-hidden />
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

      {identity?.complexId ? (
        <LabSectionBoundary id="section-3d" title="3D 단지 보기">
          <Complex3dEntryCard complexId={identity.complexId} />
        </LabSectionBoundary>
      ) : null}
      {identity?.complexId ? (
        <LabSectionBoundary id="section-redev" title="정비사업">
          <ComplexRedevSection complexId={identity.complexId} />
        </LabSectionBoundary>
      ) : null}

      {/* 시세 = 요약(면적 기준) → 추이(차트) → 거래내역. 한 주제 한 섹션 (policy §12.1). */}
      <LabSection
        id="section-market"
        title="실거래 현황"
        meta={
          areaKey === "all" || !selectedArea
            ? "전체 면적 기준"
            : `${areaSelectorClosedLabel(selectedArea)} 기준`
        }
        className="gap-4"
      >
        <LabStatTiles
          columns={4}
          items={[
            {
              key: "trade",
              label: "최근 매매",
              value: (
                <span
                  className={`detail-summary-value ${dealTypePriceTextClass("trade")}`}
                >
                  {latestTrade ? formatEok(latestTrade.dealAmount) : "—"}
                </span>
              ),
              sub: latestTrade ? formatDealDate(latestTrade.dealDate) : "—",
            },
            {
              key: "jeonse",
              label: "최근 전세",
              value: (
                <span
                  className={`detail-summary-value ${dealTypePriceTextClass("jeonse")}`}
                >
                  {latestJeonse ? formatEok(latestJeonse.dealAmount) : "—"}
                </span>
              ),
              sub: latestJeonse ? formatDealDate(latestJeonse.dealDate) : "—",
            },
            {
              key: "vs-max",
              label: "최고가 대비",
              value: (
                <span
                  className={`detail-summary-value ${
                    vsMaxPct == null || vsMaxPct === 0
                      ? ""
                      : vsMaxPct < 0
                        ? "detail-change-down"
                        : "detail-change-up"
                  }`.trim()}
                >
                  {vsMaxPct == null
                    ? "—"
                    : `${vsMaxPct > 0 ? "+" : ""}${vsMaxPct}%`}
                </span>
              ),
              sub: "최근 매매 기준",
            },
            {
              key: "ratio",
              label: "전세가율",
              value: (
                <span className="detail-summary-value">
                  {jeonseRatio != null ? `${jeonseRatio}%` : "—"}
                </span>
              ),
              sub:
                saleJeonseGap != null && saleJeonseGap !== 0
                  ? `갭 ${formatEok(Math.abs(saleJeonseGap))}`
                  : "갭 —",
            },
          ]}
        />

        <ComplexJeonseBenchmark
          lawdCd={identity?.lawdCd ?? null}
          regionName={region?.name ?? data.regionName ?? null}
          complexRatioPct={jeonseRatio}
        />
        <ComplexTradeActivity items={areaFiltered} />
        <ComplexRentMetrics items={areaFiltered} />

        <div className={LAB_SUBSECTION_RULE}>
          <div className="detail-market-header">
            <h3 className="detail-subsection-title shrink-0">시세 추이</h3>
            <div className="detail-market-period">{periodButtons}</div>
          </div>

          <LabTabs
            className="detail-market-deal-tabs"
            variant="secondary"
            ariaLabel="거래 유형"
            value={chartDealType === "jeonse" ? "jeonse" : "trade"}
            items={[
              { id: "trade", label: "매매" },
              { id: "jeonse", label: "전월세" },
            ]}
            onChange={(next) => setDealFilter(next)}
          />

          <div className="detail-market-chart">
            <AptPriceChart
              points={chartPoints}
              deals={chartDeals}
              dealType={chartDealType}
              dealCount={
                chartDealType === "trade" ? periodTradeCount : periodJeonseCount
              }
              dealCountLabel={chartDealType === "trade" ? "매매" : "전세"}
              selectedMonthYm={selectedMonthYm}
              onMonthSelect={setSelectedMonthYm}
            />
          </div>

          <div className="detail-market-slider min-h-11 px-1">
            <PeriodRangeSlider
              months={chartMonths}
              startIndex={startIndex}
              endIndex={endIndex}
              activePreset={periodPreset === "custom" ? null : periodPreset}
              showPresets={false}
              onChange={(start, end) => {
                setPeriodPreset("custom");
                setRangeOverride({ start, end });
              }}
              onRecentYears={setRecentYears}
              onFullRange={setFullRange}
            />
          </div>

          <div className="detail-market-trades">
            <div className="mb-3">
              <LabSubsectionHeader title="거래내역" meta="최근 계약일순" />
            </div>

            {selectedMonthYm ? (
              <div className="detail-market-month-filter">
                <p className="detail-meta">
                  차트에서 선택한{" "}
                  <b className="font-semibold text-[color:var(--lab-navy-950)]">
                    {Number(selectedMonthYm.slice(0, 4))}년 {Number(selectedMonthYm.slice(4, 6))}월
                  </b>{" "}
                  거래만 조회
                </p>
                <button
                  type="button"
                  className="lab-button lab-button-tertiary detail-market-month-clear"
                  onClick={() => setSelectedMonthYm(null)}
                >
                  전체 보기
                </button>
              </div>
            ) : null}

            <TransactionList
              items={visibleTrades}
              mode={listDealMode}
              layout="split"
            />

            {listSourceItems.length > 0 ? (
              <div className="detail-cta">
                {/* Full document navigation — soft Link nav is unreliable via the preview tunnel. */}
                <a
                  href={transactionsHref}
                  className="lab-button lab-button-secondary w-full"
                >
                  {`거래 내역 자세히 보기 (${listSourceItems.length.toLocaleString("ko-KR")}건)`}
                  <span aria-hidden className="ml-1">
                    →
                  </span>
                </a>
              </div>
            ) : null}
          </div>
        </div>
      </LabSection>

      <LabSectionBoundary id="section-trade-insight" mountWhenNear title="거래 분석">
        <ComplexTradeInsightSection
          items={areaFiltered}
          maxFloor={complexDetail?.building?.maxFloor ?? null}
          areaLabel={
            areaKey === "all" || !selectedArea
              ? "전체 면적"
              : areaSelectorClosedLabel(selectedArea)
          }
        />
      </LabSectionBoundary>

      {identity?.complexId ? (
        <LabSectionBoundary id="section-type-dong" mountWhenNear title="타입·동 정보">
          <ComplexTypeDongSection complexId={identity.complexId} selectedArea={selectedArea} items={data.items} />
        </LabSectionBoundary>
      ) : null}

      <LabSectionBoundary id="section-unit-mix" mountWhenNear title="평형 구성">
        <ComplexUnitMixSection
          unitMix={complexDetail?.unitMix}
          areas={areasWithSupply}
          areaKey={areaKey}
          onAreaChange={(key) => setAreaOverride({ forId: aptIdentity, key })}
          complexHouseholdCount={complexDetail?.basic?.householdCount ?? null}
        />
      </LabSectionBoundary>

      <LabSectionBoundary id="section-region-rank" mountWhenNear title="지역 비교">
      <ComplexRegionRankSection
          complexId={identity?.complexId ?? null}
          aptName={data.aptName}
          regionSlug={regionSlug}
          regionName={region?.name ?? data.regionName}
          dongName={identity?.legalDongName ?? data.dong}
          lawdCd={identity?.lawdCd ?? null}
          bjdongCd={identity?.bjdongCd ?? null}
          selectedArea={areaKey === "all" ? null : selectedArea}
        />
      </LabSectionBoundary>

      {data ? (
        <LabSectionBoundary id="section-comparison" mountWhenNear title="단지 비교">
      <ComplexCompareSection
            aptName={aptName}
            regionSlug={regionSlug}
            gu={gu}
            dong={data.dong}
            detail={data}
            selectedArea={selectedArea}
            areaKey={areaKey}
            householdCount={complexDetail?.basic?.householdCount ?? null}
          />
        </LabSectionBoundary>
      ) : null}

      <LabSectionBoundary id="section-nearby-life" mountWhenNear title="주변 생활">
      <ComplexNearbyLifeSection
          aptName={aptName}
          identity={identity ?? null}
          initialTab={
            // Default apt entry → 교통. School tab only via back-from-detail restore.
            initialNearbyTab === "school"
              ? "school"
              : undefined
          }
          initialSchoolLevel={initialSchoolLevel}
          presetAnchor={complexDetail?.mapAnchor ?? null}
        />
      </LabSectionBoundary>

      <LabSectionBoundary id="section-nearby-sales" mountWhenNear title="주변 공급">
      <ComplexNearbySalesSection
          aptName={aptName}
          sigungu={nearbySigungu}
          lawdCd={nearbyLawdCd}
        />
      </LabSectionBoundary>

      {/* 세금·대출 계산 — 관리비 바로 위 (집값·대출·관리비를 이어서 보게) */}
      <LabSectionBoundary id="section-calculator" mountWhenNear title="세금·대출 계산">
      <ComplexPurchaseCalculatorSection
          complexId={identity?.complexId ?? null}
          complexName={data.aptName}
          areaKey={areaKey}
          areaLabel={
            areaKey === "all" || !selectedArea
              ? "전체 면적"
              : areaSelectorClosedLabel(selectedArea)
          }
          latestTradeMan={latestTrade?.dealAmount ?? 0}
          exclusiveAreaMinSqm={
            selectedArea
              ? (selectedArea.exclusiveAreaMin ?? selectedArea.exclusiveArea ?? null)
              : null
          }
          exclusiveAreaMaxSqm={
            selectedArea
              ? (selectedArea.exclusiveAreaMax ?? selectedArea.exclusiveArea ?? null)
              : null
          }
          regionSlug={regionSlug}
          locationLabel={locationLabel}
        />
      </LabSectionBoundary>

      {complexDetail?.management ? (
        <LabSectionBoundary id="section-management" mountWhenNear title="관리비">
      <ComplexMgmtFeeCard
            management={complexDetail.management}
            selectedPyeongLabel={
              areaKey === "all" || !selectedArea
                ? null
                : areaSelectorPyeongLabel(selectedArea)
            }
            exclusiveAreaMinSqm={
              selectedArea
                ? (selectedArea.exclusiveAreaMin ??
                  selectedArea.exclusiveArea ??
                  null)
                : null
            }
            exclusiveAreaMaxSqm={
              selectedArea
                ? (selectedArea.exclusiveAreaMax ??
                  selectedArea.exclusiveArea ??
                  null)
                : null
            }
            aptName={data.aptName}
            complexId={identity?.complexId ?? null}
            unitMixRows={complexDetail?.unitMix?.rows ?? null}
          />
        </LabSectionBoundary>
      ) : complexDetail ? (
        <LabSectionBoundary id="section-management" mountWhenNear title="관리비">
          <ComplexMgmtFeeEmpty householdCount={complexDetail.basic?.householdCount ?? null} />
        </LabSectionBoundary>
      ) : null}
    </LazySectionShell>
  );
}

/**
 * 아래 섹션 마운트 게이트의 범위. 시세가 뜬 뒤 한가할 때 남은 섹션을 동시 요청 2개 이하로 차례로 마운트한다.
 */
function LazySectionShell({ className, children }: { className: string; children: ReactNode }) {
  return (
    <LazyMountProvider backgroundActive maxConcurrent={2}>
      <SectionNavJumpCapture className={className}>{children}</SectionNavJumpCapture>
    </LazyMountProvider>
  );
}

/**
 * 섹션 탭(포털로 떠 있지만 React 이벤트는 여기로 올라온다)을 누르면 남은 섹션을 전부 마운트 —
 * 위 섹션이 뒤늦게 자라 점프 위치가 밀리지 않게.
 */
function SectionNavJumpCapture({
  className,
  children,
}: {
  className: string;
  children: ReactNode;
}) {
  const mountAll = useMountAllLazy();
  return (
    <div
      className={className}
      onClickCapture={(e) => {
        const target = e.target as Element | null;
        if (target?.closest?.("button[data-section]")) mountAll();
      }}
    >
      {children}
    </div>
  );
}

import {
  FEATURED_LAWD_CODES,
  LAWD_TO_REGION,
  PAGE_SIZE,
  getRegion,
  type RegionDef,
} from "@/lib/constants/regions";
import { hasDb } from "@/lib/db/client";
import { productDiscoveryIso } from "@/lib/db/discovery-axis";
import {
  listAptCatalog,
  normalizeAptName,
  queryAptTypePriorMaxes,
  queryRegionBrowseApts,
  queryRegionMonthPool,
  queryTradePool,
  type AptTypePriorCandidate,
} from "@/lib/db/repository";
import {
  beginDbQueryCount,
  takeDbQueryCount,
} from "@/lib/db/query-stats";
import {
  seoulDateOf,
  seoulToday,
  yearMonthFromSeoulDate,
} from "@/lib/market/time";
import { fetchTransactionsByType, hasApiKey } from "@/lib/molit/client";
import { filterTransactions, sortByDealDateDesc } from "@/lib/molit/parse";
import { buildRegionDemoTransactions } from "@/lib/mock/region-demo";
import { MOCK_TRANSACTIONS } from "@/lib/mock/sample-data";
import {
  CONTRACT_DATE_BASIS_HELP,
  CONTRACT_MONTH_LOOKBACK,
  HISTORY_DATE_BASIS_HELP,
  HISTORY_DAY_FETCH_CAP,
  HISTORY_INITIAL_DAY_COUNT,
  activityYearMonthsFromSeenDates,
  contractMonthOptions,
  contractMonthOptionsFromCoverage,
  medianPyeongPrice,
  oldestYearMonthFromDates,
  pickHeroSeenDate,
  priorTypeMaxAmount,
  yearMonthInLookback,
  SEEN_DATE_BASIS_HELP,
  shiftYearMonth,
  sortNewlySeenDeals,
  TYPE_TREND_MIN_POINTS,
  previousTypeDealAmount,
  typePriceTrend,
  typeRecordHigh,
  yearMonthFromDealDate,
} from "@/lib/region/market-insight";
import {
  matchesAreaFilter,
  recentYearMonths,
} from "@/lib/utils/format";
import type {
  AreaFilter,
  DealType,
  Transaction,
  TransactionStats,
  TransactionsResponse,
} from "@/types/transaction";

const REGION_DAILY_HISTORY_MONTHS = CONTRACT_MONTH_LOOKBACK;

function monthsBefore(dateStr: string, months: number): string {
  const d = new Date(`${dateStr.slice(0, 10)}T00:00:00`);
  d.setMonth(d.getMonth() - months);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function buildStats(items: Transaction[]): TransactionStats {
  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  const weekAgoStr = weekAgo.toISOString().slice(0, 10);

  const tradeItems = items.filter((i) => i.dealType === "trade");
  const maxDeal =
    tradeItems.length > 0
      ? tradeItems.reduce((max, cur) =>
          cur.dealAmount > max.dealAmount ? cur : max,
        )
      : null;

  const avgDealAmount =
    tradeItems.length > 0
      ? Math.round(
          tradeItems.reduce((sum, i) => sum + i.dealAmount, 0) /
            tradeItems.length,
        )
      : 0;

  return {
    totalCount: items.length,
    recentCount: items.filter((i) => i.dealDate >= weekAgoStr).length,
    todayCount: items.filter((i) => i.dealDate === today).length,
    maxDeal,
    avgDealAmount,
  };
}

function paginate(
  items: Transaction[],
  page: number,
  pageSize: number,
): Transaction[] {
  const start = (page - 1) * pageSize;
  return items.slice(start, start + pageSize);
}

function resolveRegion(
  lawdCodes: string[],
  regionSlug?: string,
): RegionDef | undefined {
  if (regionSlug) return getRegion(regionSlug);

  // 단일 지역에 속한 코드만 넘어온 경우 해당 지역으로 데모 생성
  if (lawdCodes.length > 0) {
    const regions = new Set(
      lawdCodes
        .map((code) => LAWD_TO_REGION[code]?.slug)
        .filter((slug): slug is string => Boolean(slug)),
    );
    if (regions.size === 1) {
      return getRegion([...regions][0]);
    }
  }

  return undefined;
}

function loadDemoItems(
  yearMonth: string,
  lawdCodes: string[],
  regionSlug?: string,
): Transaction[] {
  const region = resolveRegion(lawdCodes, regionSlug);
  if (region) {
    return buildRegionDemoTransactions(region, yearMonth);
  }

  // 메인/랭킹용: 정적 샘플 + 주요지역 데모 혼합
  const ymPrefix = `${yearMonth.slice(0, 4)}-${yearMonth.slice(4, 6)}`;
  const staticItems = MOCK_TRANSACTIONS.filter((i) =>
    i.dealDate.startsWith(ymPrefix),
  );
  return staticItems.length > 0 ? staticItems : [...MOCK_TRANSACTIONS];
}

export async function loadRawTransactions(
  yearMonth: string,
  dealType: DealType | "all" = "all",
  lawdCodes: string[] = [...FEATURED_LAWD_CODES],
  regionSlug?: string,
  options?: { maxMonthTries?: number },
): Promise<{
  items: Transaction[];
  source: "api" | "mock";
  warning?: string;
  resolvedYearMonth: string;
}> {
  if (hasApiKey()) {
    const maxTries = Math.max(1, options?.maxMonthTries ?? 4);
    const monthsToTry = [
      yearMonth,
      ...recentYearMonths(6).filter((ym) => ym !== yearMonth),
    ].slice(0, maxTries);

    let lastError = "";
    // dealType=all 일 때: 전월세만 있는 당월에 멈추면 매매가 비어 보임 → 매매가 있는 월 우선
    let rentOnlyFallback:
      | { items: Transaction[]; ym: string }
      | undefined;

    for (const ym of monthsToTry) {
      try {
        const items = await fetchTransactionsByType(ym, dealType, lawdCodes);
        if (items.length === 0) continue;

        if (dealType === "all") {
          const hasTrade = items.some((item) => item.dealType === "trade");
          if (!hasTrade) {
            if (!rentOnlyFallback) {
              rentOnlyFallback = { items, ym };
            }
            continue;
          }
        }

        return {
          items,
          source: "api",
          resolvedYearMonth: ym,
          warning:
            ym !== yearMonth
              ? `${yearMonth.slice(0, 4)}.${yearMonth.slice(4, 6)} 데이터가 없어 ${ym.slice(0, 4)}.${ym.slice(4, 6)} 기준으로 표시합니다.`
              : undefined,
        };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        console.error("[molit] fetch failed:", ym, lastError);
      }
    }

    if (rentOnlyFallback) {
      return {
        items: rentOnlyFallback.items,
        source: "api",
        resolvedYearMonth: rentOnlyFallback.ym,
        warning:
          rentOnlyFallback.ym !== yearMonth
            ? `${yearMonth.slice(0, 4)}.${yearMonth.slice(4, 6)} 데이터가 없어 ${rentOnlyFallback.ym.slice(0, 4)}.${rentOnlyFallback.ym.slice(4, 6)} 기준으로 표시합니다.`
            : "선택한 기간에 매매 실거래가 아직 없어 전월세만 표시합니다.",
      };
    }

    return {
      items: loadDemoItems(yearMonth, lawdCodes, regionSlug),
      source: "mock",
      resolvedYearMonth: yearMonth,
      warning: lastError
        ? `API 오류로 데모 데이터 표시: ${lastError}`
        : "선택한 기간에 API 데이터가 없어 데모 데이터를 표시합니다.",
    };
  }

  return {
    items: loadDemoItems(yearMonth, lawdCodes, regionSlug),
    source: "mock",
    resolvedYearMonth: yearMonth,
    warning:
      "MOLIT_API_KEY가 없어 지역별 데모 데이터로 표시 중입니다. Vercel/로컬 환경변수에 키를 설정하세요.",
  };
}

export async function getTransactions(params: {
  aptName?: string;
  gu?: string;
  dong?: string;
  dealType?: DealType | "all";
  area?: AreaFilter;
  yearMonth?: string;
  page?: number;
  pageSize?: number;
  lawdCodes?: string[];
  regionSlug?: string;
}): Promise<
  TransactionsResponse & {
    warning?: string;
    lawdCodes: string[];
    apiConfigured: boolean;
  }
> {
  const yearMonth = params.yearMonth || recentYearMonths(1)[0];
  const dealType = params.dealType ?? "all";
  const page = Math.max(1, params.page ?? 1);
  const pageSize = params.pageSize ?? PAGE_SIZE;
  const lawdCodes = params.lawdCodes?.length
    ? params.lawdCodes
    : [...FEATURED_LAWD_CODES];

  let items: Transaction[] = [];
  let source: "api" | "mock" = "api";
  let warning: string | undefined;
  let resolvedYearMonth = yearMonth;
  let usedDb = false;

  if (hasDb()) {
    try {
      const dealKinds: DealType[] =
        dealType === "all" ? ["trade", "rent"] : [dealType];
      const fromDb = await queryRegionMonthPool({
        lawdCodes,
        yearMonths: [yearMonth],
        dealKinds,
      });
      if (fromDb) {
        items = fromDb;
        usedDb = true;
        resolvedYearMonth = yearMonth;
      }
    } catch (error) {
      console.warn("[transactions] db read failed:", error);
    }
  }

  if (!usedDb) {
    try {
      const loaded = await loadRawTransactions(
        yearMonth,
        dealType,
        lawdCodes,
        params.regionSlug,
        { maxMonthTries: 1 },
      );
      items = loaded.items;
      source = loaded.source;
      warning = loaded.warning;
      resolvedYearMonth = loaded.resolvedYearMonth;
    } catch (error) {
      console.warn("[transactions] api read failed:", error);
      items = [];
      source = "api";
      warning = "실거래 조회 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.";
    }
  }

  const filtered = sortByDealDateDesc(
    filterTransactions(items, {
      aptName: params.aptName,
      gu: params.gu,
      dong: params.dong,
      dealType,
      areaMatcher: (sqm) => matchesAreaFilter(sqm, params.area ?? "all"),
    }),
  );

  const totalCount = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const safePage = Math.min(page, totalPages);

  return {
    items: paginate(filtered, safePage, pageSize),
    totalCount,
    page: safePage,
    pageSize,
    totalPages,
    stats: buildStats(filtered),
    source,
    yearMonth: resolvedYearMonth,
    warning,
    lawdCodes,
    apiConfigured: hasApiKey(),
  };
}

export interface RegionDongSummary {
  dong: string;
  gu: string;
  aptCount: number;
  dealCount: number;
}

export interface RegionDongApt {
  aptName: string;
  gu: string;
  dong: string;
  dealCount: number;
  tradeCount: number;
  maxDealAmount: number;
  latestDealDate: string;
  buildYear: number | null;
}

export interface RegionBrowseResponse {
  regionSlug: string;
  yearMonth: string;
  source: "api" | "mock" | "catalog" | "db";
  warning?: string;
  selectedDong: string | null;
  dongs: RegionDongSummary[];
  apts: RegionDongApt[];
}

function normalizeDongKey(dong: string): string {
  return dong.replace(/\s+/g, "");
}

function guMatchesRegion(gu: string, region: RegionDef): boolean {
  if (!gu.trim()) return false;
  if (gu.includes(region.name) || region.name === gu) return true;
  return region.districts.some(
    (d) => gu.includes(d.name) || d.name === gu || gu.includes(d.name),
  );
}

function buildBrowseFromRows(
  rows: Array<{
    aptName: string;
    gu: string;
    dong: string;
    dealCount: number;
    maxDealAmount: number;
    latestDealDate: string;
    buildYear?: number | null;
    tradeCount?: number;
  }>,
  selectedDong: string | null,
  selectedGu?: string,
): { dongs: RegionDongSummary[]; apts: RegionDongApt[] } {
  const dongMap = new Map<
    string,
    { dong: string; gu: string; apts: Set<string>; dealCount: number }
  >();

  for (const row of rows) {
    const dong = row.dong.trim();
    if (!dong) continue;
    const key = `${row.gu}|${normalizeDongKey(dong)}`;
    const prev = dongMap.get(key);
    if (!prev) {
      dongMap.set(key, {
        dong,
        gu: row.gu,
        apts: new Set([row.aptName]),
        dealCount: row.dealCount,
      });
      continue;
    }
    prev.apts.add(row.aptName);
    prev.dealCount += row.dealCount;
  }

  const dongs: RegionDongSummary[] = [...dongMap.values()]
    .map((value) => ({
      dong: value.dong,
      gu: value.gu,
      aptCount: value.apts.size,
      dealCount: value.dealCount,
    }))
    .sort(
      (a, b) =>
        b.aptCount - a.aptCount ||
        b.dealCount - a.dealCount ||
        a.dong.localeCompare(b.dong, "ko"),
    );

  let apts: RegionDongApt[] = [];
  if (selectedDong) {
    const needle = normalizeDongKey(selectedDong);
    apts = rows
      .filter((row) => {
        if (normalizeDongKey(row.dong) !== needle) return false;
        if (selectedGu && selectedGu !== "all" && !row.gu.includes(selectedGu)) {
          return false;
        }
        return true;
      })
      .map((row) => ({
        aptName: row.aptName,
        gu: row.gu,
        dong: row.dong,
        dealCount: row.dealCount,
        tradeCount: row.tradeCount ?? row.dealCount,
        maxDealAmount: row.maxDealAmount,
        latestDealDate: row.latestDealDate,
        buildYear: row.buildYear ?? null,
      }))
      .sort(
        (a, b) =>
          b.dealCount - a.dealCount ||
          b.maxDealAmount - a.maxDealAmount ||
          a.aptName.localeCompare(b.aptName, "ko"),
      );
  }

  return { dongs, apts };
}

export async function getRegionBrowse(params: {
  regionSlug: string;
  yearMonth?: string;
  dong?: string;
  gu?: string;
  months?: number;
}): Promise<RegionBrowseResponse> {
  const region = getRegion(params.regionSlug);
  if (!region) {
    throw new Error(`Unknown region: ${params.regionSlug}`);
  }

  const selectedDong = params.dong?.trim() || null;
  const selectedGu = params.gu?.trim() || undefined;

  // 거래 테이블(법정동코드) 기준으로 동/단지 목록 구성 — apt_catalog는 지역별 누락이 있을 수 있음
  if (hasDb()) {
    try {
      const fromDb = await queryRegionBrowseApts([...region.lawdCodes]);
      if (fromDb && fromDb.length > 0) {
        const { dongs, apts } = buildBrowseFromRows(
          fromDb,
          selectedDong,
          selectedGu,
        );
        return {
          regionSlug: region.slug,
          yearMonth: "",
          source: "db",
          selectedDong,
          dongs,
          apts,
        };
      }
    } catch (error) {
      console.warn("[region-browse] db aggregate failed:", error);
    }
  }

  const catalog = await listAptCatalog();
  if (catalog && catalog.length > 0) {
    const regionRows = catalog.filter((row) => guMatchesRegion(row.gu, region));
    const dongs = buildBrowseFromRows(regionRows, null).dongs;
    const apts = selectedDong
      ? buildBrowseFromRows(regionRows, selectedDong, selectedGu).apts
      : [];

    return {
      regionSlug: region.slug,
      yearMonth: "",
      source: "catalog",
      selectedDong,
      dongs,
      apts,
    };
  }

  // 카탈로그 없을 때: 최근 거래로 폴백 (월 선택 UI는 없음)
  const monthCount = Math.min(Math.max(params.months ?? 12, 1), 24);
  const months = recentYearMonths(monthCount);
  const preferredYm = params.yearMonth || months[0];
  const orderedMonths = [
    preferredYm,
    ...months.filter((ym) => ym !== preferredYm),
  ];

  const collected: Transaction[] = [];
  let source: "api" | "mock" = "mock";
  let warning: string | undefined;
  let resolvedYearMonth = preferredYm;

  for (const ym of orderedMonths) {
    const loaded = await loadRawTransactions(
      ym,
      "trade",
      [...region.lawdCodes],
      region.slug,
    );
    if (loaded.items.length === 0) continue;
    collected.push(...loaded.items);
    source = loaded.source;
    if (loaded.warning) warning = loaded.warning;
    if (ym === preferredYm) resolvedYearMonth = loaded.resolvedYearMonth;
  }

  if (collected.length === 0) {
    const demo = loadDemoItems(preferredYm, [...region.lawdCodes], region.slug);
    collected.push(...demo.filter((tx) => tx.dealType === "trade"));
    source = "mock";
    warning =
      warning ??
      "단지 카탈로그가 없어 최근 거래 기준으로 표시합니다.";
  }

  const aptMap = new Map<
    string,
    {
      aptName: string;
      gu: string;
      dong: string;
      dealCount: number;
      tradeCount: number;
      maxDealAmount: number;
      latestDealDate: string;
      buildYear: number | null;
    }
  >();

  for (const tx of collected) {
    if (selectedGu && selectedGu !== "all" && !tx.gu.includes(selectedGu)) {
      continue;
    }
    const key = `${tx.gu}|${tx.aptName}|${normalizeDongKey(tx.dong)}`;
    const prev = aptMap.get(key);
    if (!prev) {
      aptMap.set(key, {
        aptName: tx.aptName,
        gu: tx.gu,
        dong: tx.dong,
        dealCount: 1,
        tradeCount: tx.dealType === "trade" ? 1 : 0,
        maxDealAmount: tx.dealType === "trade" ? tx.dealAmount : 0,
        latestDealDate: tx.dealDate,
        buildYear: tx.buildYear,
      });
      continue;
    }
    prev.dealCount += 1;
    if (tx.dealType === "trade") {
      prev.tradeCount += 1;
      prev.maxDealAmount = Math.max(prev.maxDealAmount, tx.dealAmount);
    }
    if (tx.dealDate > prev.latestDealDate) {
      prev.latestDealDate = tx.dealDate;
      prev.dong = tx.dong;
      if (tx.buildYear) prev.buildYear = tx.buildYear;
    }
  }

  const { dongs, apts } = buildBrowseFromRows(
    [...aptMap.values()],
    selectedDong,
    selectedGu,
  );

  return {
    regionSlug: region.slug,
    yearMonth: resolvedYearMonth,
    source,
    warning,
    selectedDong,
    dongs,
    apts,
  };
}

export interface RegionDailyDaySummary {
  date: string; // KST YYYY-MM-DD of discovery_at (fallback: first_seen_at)
  dealCount: number;
  tradeCount: number;
  singogaCount: number;
  /** false면 신고가를 아직 계산하지 않음. 0건과 구분 */
  singogaKnown: boolean;
  bulkIngestDay: boolean;
  maxDealAmount: number;
}

export interface RegionDailyDaySection {
  date: string;
  deals: RegionDailyDeal[];
  bulkIngestDay: boolean;
  singogaKnown: boolean;
  totalCount: number;
  singogaCount: number;
  hasMore: boolean;
}

/** 타입 신고가 = 동일 단지 + 동일 areaKey all-time prior max 초과 */
export type RegionDailySingogaKind = "type";

export interface RegionDailyDeal {
  id: string;
  aptName: string;
  gu: string;
  dong: string;
  exclusiveArea: number;
  floor: number;
  dealAmount: number;
  dealDate: string;
  /** KST 달력일. 시스템이 처음 확인한 날. 공식 신고일 아님. */
  firstSeenDate: string;
  buildYear: number | null;
  dealingGbn: string;
  singogaKind: RegionDailySingogaKind | null;
  increaseAmount: number;
  vsHighPct: number | null;
  recent3mCount: number;
  typeMaxAmount: number;
  pyeongMaxAmount: number;
  complexMaxAmount: number;
  jeonseAmount: number | null;
  /**
   * 동일 단지·areaKey, 현재 계약일 이전 24개월 풀에서
   * 가장 가까운 매매 금액. 없으면 null.
   */
  prevTypeDealAmount: number | null;
  /** 신고가 카드만. 동일 단지·areaKey, deal_date 순, 24개월 풀 */
  priceTrend?: { date: string; amount: number }[] | null;
}

export type RegionDailyPart = "market" | "latest" | "history" | "days" | "all";

export interface RegionDailyResponse {
  regionSlug: string;
  yearMonth: string;
  source: "api" | "mock" | "db";
  warning?: string;
  selectedDate: string | null;
  latestIsToday: boolean;
  days: RegionDailyDaySummary[];
  historySections: RegionDailyDaySection[];
  historyTotalCount: number;
  /** @deprecated 히어로는 deals. 월 목록은 historySections. */
  monthDeals: RegionDailyDeal[];
  deals: RegionDailyDeal[];
  maxDeal: RegionDailyDeal | null;
  avgDealAmount: number;
  tradeCount: number;
  selectedDaySingogaCount: number;
  /** 계약월(deal_date) 매매 건수 — 확인일과 축이 다름 */
  monthTradeCount: number;
  prevMonthTradeCount: number;
  comparePartial: boolean;
  contractYearMonth: string;
  medianDealAmount: number | null;
  prevMonthMedianDealAmount: number | null;
  medianPyeongPrice: number | null;
  /** 선택 계약월 타입 신고가 건수. 계산 불가면 null */
  monthSingogaCount: number | null;
  /** 12개월 전 같은 계약월 거래량. pool coverage 없으면 null */
  yearAgoMonthTradeCount: number | null;
  dateAxis: "first_seen_kst";
  dateBasisNote: string;
  contractDateBasisNote: string;
  seenDateBasisNote: string;
  historyDateBasisNote: string;
  firstSeenReady: boolean;
  /** 히어로 확인 건수가 비정상적으로 커 all-time 신고가 lookup을 생략 */
  bulkIngestDay: boolean;
  /** SECTION 1: deal_date 최근 24개월 연속(coverage가 더 짧으면 그 범위). */
  contractMonthOptions: string[];
  /** SECTION 3: discovery_at KST 월. SECTION 1과 공유하지 않음. */
  activityYearMonths: string[];
}

const REGION_DAILY_DATE_NOTE = SEEN_DATE_BASIS_HELP;

function enrichDailyDeal(
  tx: Transaction,
  priorTypeMax: number,
  aptTrades24m: Transaction[],
  firstSeenDate: string,
): RegionDailyDeal {
  const dealDate = tx.dealDate.slice(0, 10);
  const judged = typeRecordHigh(tx.dealAmount, priorTypeMax);
  const singogaKind: RegionDailySingogaKind | null = judged.isSingoga
    ? "type"
    : null;

  const since3m = monthsBefore(dealDate, 3);
  const recent3mCount = aptTrades24m.filter(
    (h) =>
      h.dealDate.slice(0, 10) >= since3m && h.dealDate.slice(0, 10) <= dealDate,
  ).length;

  const typeMax = Math.max(tx.dealAmount, priorTypeMax);
  const prevTypeDealAmount = previousTypeDealAmount({
    exclusiveArea: tx.exclusiveArea,
    dealDate: tx.dealDate,
    history: aptTrades24m,
  });

  return {
    id: tx.id,
    aptName: tx.aptName,
    gu: tx.gu,
    dong: tx.dong,
    exclusiveArea: tx.exclusiveArea,
    floor: tx.floor,
    dealAmount: tx.dealAmount,
    dealDate: tx.dealDate,
    firstSeenDate,
    buildYear: tx.buildYear,
    dealingGbn: tx.dealingGbn || "중개거래",
    singogaKind,
    increaseAmount: judged.increaseAmount,
    vsHighPct: null,
    recent3mCount,
    typeMaxAmount: typeMax,
    pyeongMaxAmount: typeMax,
    complexMaxAmount: typeMax,
    jeonseAmount: null,
    prevTypeDealAmount,
  };
}

function groupByAptName(items: Transaction[]): Map<string, Transaction[]> {
  const map = new Map<string, Transaction[]>();
  for (const tx of items) {
    const key = normalizeAptName(tx.aptName);
    const prev = map.get(key);
    if (prev) prev.push(tx);
    else map.set(key, [tx]);
  }
  return map;
}

/** 기존 type 신고가 classifier용 prior max. 24m pool 후 필요 시 all-time SQL. */
async function typePriorMaxesForDeals(params: {
  deals: Transaction[];
  historyTrades: Transaction[];
  lawdCodes: string[];
  source: "db" | "api";
}): Promise<number[]> {
  const { deals, historyTrades, lawdCodes, source } = params;
  const tradesByApt = groupByAptName(historyTrades);
  const priorMaxes = deals.map((tx) =>
    priorTypeMaxAmount({
      exclusiveArea: tx.exclusiveArea,
      dealDate: tx.dealDate,
      history: tradesByApt.get(normalizeAptName(tx.aptName)) ?? [],
    }),
  );
  if (source !== "db" || deals.length === 0) return priorMaxes;

  const sqlIndexes: number[] = [];
  const candidates: AptTypePriorCandidate[] = [];
  deals.forEach((tx, index) => {
    if (tx.dealAmount > (priorMaxes[index] ?? 0)) {
      sqlIndexes.push(index);
      candidates.push({
        aptNameNorm: normalizeAptName(tx.aptName),
        exclusiveArea: tx.exclusiveArea,
        dealDate: tx.dealDate,
      });
    }
  });
  if (candidates.length === 0) return priorMaxes;
  if (activeProfile) {
    const unique = new Set(candidates.map(priorCandidateKey));
    activeProfile.priorCandidates += candidates.length;
    activeProfile.priorUniqueCandidates += unique.size;
  }
  try {
    const tPrior = performance.now();
    const lookedUp = await queryAptTypePriorMaxes({ lawdCodes, candidates });
    if (activeProfile) {
      activeProfile.priorMaxMs += Math.round(performance.now() - tPrior);
    }
    if (lookedUp) {
      lookedUp.forEach((sqlMax, i) => {
        const dealIndex = sqlIndexes[i]!;
        priorMaxes[dealIndex] = Math.max(priorMaxes[dealIndex] ?? 0, sqlMax);
      });
    }
  } catch (error) {
    console.warn("[region-daily] apt prior max db read failed:", error);
  }
  return priorMaxes;
}

function tradesInContractMonth(
  historyTrades: Transaction[],
  yearMonth: string,
  dayCap: string | null,
): Transaction[] {
  const out: Transaction[] = [];
  for (const tx of historyTrades) {
    const d = tx.dealDate.slice(0, 10);
    if (yearMonthFromDealDate(d) !== yearMonth) continue;
    if (dayCap && d.slice(8, 10) > dayCap) continue;
    out.push(tx);
  }
  return out;
}

function firstSeenKstDate(tx: Transaction): string | null {
  const raw = productDiscoveryIso(tx);
  if (!raw) return null;
  const day = seoulDateOf(raw);
  return day || null;
}

const REGION_DAILY_CACHE_TTL_MS = 60_000;
const REGION_DAILY_SINGOGA_DAY_CAP = 100;
const BULK_DAY_PAGE_SIZE = 24;

const regionDailyCache = new Map<
  string,
  { expires: number; payload: RegionDailyResponse }
>();

export type RegionDailyProfile = {
  poolMs: number;
  poolRows: number;
  kpiMs: number;
  kpiDeals: number;
  priorMaxMs: number;
  priorCandidates: number;
  priorUniqueCandidates: number;
  heroMs: number;
  heroDeals: number;
  calendarMs: number;
  sparklineMs: number;
  sqlQueries: number;
  totalMs: number;
};

let activeProfile: RegionDailyProfile | null = null;

function emptyProfile(): RegionDailyProfile {
  return {
    poolMs: 0,
    poolRows: 0,
    kpiMs: 0,
    kpiDeals: 0,
    priorMaxMs: 0,
    priorCandidates: 0,
    priorUniqueCandidates: 0,
    heroMs: 0,
    heroDeals: 0,
    calendarMs: 0,
    sparklineMs: 0,
    sqlQueries: 0,
    totalMs: 0,
  };
}

export function startRegionDailyProfile(): void {
  activeProfile = emptyProfile();
  beginDbQueryCount();
}

export function takeRegionDailyProfile(): RegionDailyProfile | null {
  if (!activeProfile) return null;
  activeProfile.sqlQueries = takeDbQueryCount();
  const out = activeProfile;
  activeProfile = null;
  return out;
}

function priorCandidateKey(candidate: AptTypePriorCandidate): string {
  return `${candidate.aptNameNorm}|${Math.round(candidate.exclusiveArea * 100)}|${candidate.dealDate.slice(0, 10)}`;
}

function cachePayload(
  key: string,
  payload: RegionDailyResponse,
): RegionDailyResponse {
  regionDailyCache.set(key, {
    expires: Date.now() + REGION_DAILY_CACHE_TTL_MS,
    payload,
  });
  if (regionDailyCache.size > 120) {
    const now = Date.now();
    for (const [k, entry] of regionDailyCache) {
      if (entry.expires <= now) regionDailyCache.delete(k);
    }
  }
  return payload;
}

function emptyRegionDaily(
  regionSlug: string,
  yearMonth: string,
  source: "api" | "mock" | "db",
  extras?: Partial<RegionDailyResponse>,
): RegionDailyResponse {
  const contractYearMonth =
    extras?.contractYearMonth ?? yearMonthFromSeoulDate(seoulToday());
  return {
    regionSlug,
    yearMonth,
    source,
    selectedDate: extras?.selectedDate ?? null,
    latestIsToday: extras?.latestIsToday ?? false,
    days: extras?.days ?? [],
    historySections: extras?.historySections ?? [],
    historyTotalCount: extras?.historyTotalCount ?? 0,
    monthDeals: extras?.monthDeals ?? extras?.deals ?? [],
    deals: extras?.deals ?? [],
    maxDeal: extras?.maxDeal ?? extras?.deals?.[0] ?? null,
    avgDealAmount: extras?.avgDealAmount ?? 0,
    tradeCount: extras?.tradeCount ?? extras?.deals?.length ?? 0,
    selectedDaySingogaCount: extras?.selectedDaySingogaCount ?? 0,
    monthTradeCount: extras?.monthTradeCount ?? 0,
    prevMonthTradeCount: extras?.prevMonthTradeCount ?? 0,
    comparePartial: extras?.comparePartial ?? false,
    contractYearMonth,
    medianDealAmount: extras?.medianDealAmount ?? null,
    prevMonthMedianDealAmount: extras?.prevMonthMedianDealAmount ?? null,
    medianPyeongPrice: extras?.medianPyeongPrice ?? null,
    monthSingogaCount: extras?.monthSingogaCount ?? null,
    yearAgoMonthTradeCount: extras?.yearAgoMonthTradeCount ?? null,
    dateAxis: "first_seen_kst",
    dateBasisNote: extras?.dateBasisNote ?? REGION_DAILY_DATE_NOTE,
    contractDateBasisNote:
      extras?.contractDateBasisNote ?? CONTRACT_DATE_BASIS_HELP,
    seenDateBasisNote: extras?.seenDateBasisNote ?? SEEN_DATE_BASIS_HELP,
    historyDateBasisNote:
      extras?.historyDateBasisNote ?? HISTORY_DATE_BASIS_HELP,
    firstSeenReady: extras?.firstSeenReady ?? false,
    warning: extras?.warning,
    bulkIngestDay: extras?.bulkIngestDay ?? false,
    contractMonthOptions: extras?.contractMonthOptions ?? [],
    activityYearMonths: extras?.activityYearMonths ?? [],
  };
}

export async function getRegionDaily(params: {
  regionSlug: string;
  yearMonth?: string;
  contractMonth?: string;
  date?: string;
  dates?: string[];
  offset?: number;
  part?: RegionDailyPart;
}): Promise<RegionDailyResponse> {
  const region = getRegion(params.regionSlug);
  if (!region) {
    throw new Error(`Unknown region: ${params.regionSlug}`);
  }

  const part: RegionDailyPart = params.part ?? "all";
  const today = seoulToday();
  const contractMonth =
    params.contractMonth || yearMonthFromSeoulDate(today);
  const seenMonth = params.yearMonth || yearMonthFromSeoulDate(today);
  const dateList = (
    params.dates?.length
      ? params.dates
      : params.date
        ? params.date.split(",").map((d) => d.trim()).filter(Boolean)
        : []
  ).slice(0, HISTORY_DAY_FETCH_CAP);
  const offset = Math.max(0, params.offset ?? 0);
  const cacheKey = `${region.slug}:${part}:${contractMonth}:${seenMonth}:${dateList.join(",")}:${offset}`;
  const cached = regionDailyCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return cached.payload;
  }

  const t0 = performance.now();
  const payload = await computeRegionDaily({
    region,
    part,
    contractMonth,
    seenMonth,
    dates: dateList,
    offset,
    today,
  });
  if (activeProfile) {
    activeProfile.totalMs += Math.round(performance.now() - t0);
  }
  return cachePayload(cacheKey, payload);
}

type PoolCacheEntry = {
  expires: number;
  trades: Transaction[];
  source: "db" | "api";
};

const regionTradePoolCache = new Map<string, PoolCacheEntry>();
const regionTradePoolInflight = new Map<
  string,
  Promise<{ trades: Transaction[]; source: "db" | "api" }>
>();

export function clearRegionDailyCaches(): void {
  regionDailyCache.clear();
  regionTradePoolCache.clear();
  regionTradePoolInflight.clear();
}

async function loadRegionTradePool(
  region: RegionDef,
): Promise<{ trades: Transaction[]; source: "db" | "api" }> {
  const cached = regionTradePoolCache.get(region.slug);
  if (cached && cached.expires > Date.now()) {
    return { trades: cached.trades, source: cached.source };
  }
  const pending = regionTradePoolInflight.get(region.slug);
  if (pending) return pending;

  const job = (async () => {
    let source: "db" | "api" = "api";
    let historyTrades: Transaction[] = [];
    const historyMonths = contractMonthOptions(
      yearMonthFromSeoulDate(seoulToday()),
      REGION_DAILY_HISTORY_MONTHS,
    );

    if (hasDb()) {
      try {
        const tPool = performance.now();
        const tradePool = await queryTradePool({
          lawdCodes: [...region.lawdCodes],
          yearMonths: historyMonths,
        });
        if (tradePool) {
          historyTrades = tradePool.filter((tx) => tx.dealType === "trade");
          source = "db";
        }
        if (activeProfile) {
          activeProfile.poolMs += Math.round(performance.now() - tPool);
          activeProfile.poolRows = historyTrades.length;
        }
      } catch (error) {
        console.warn("[region-daily] trade pool db read failed:", error);
      }
    }

    regionTradePoolCache.set(region.slug, {
      expires: Date.now() + REGION_DAILY_CACHE_TTL_MS,
      trades: historyTrades,
      source,
    });
    if (regionTradePoolCache.size > 24) {
      const now = Date.now();
      for (const [key, entry] of regionTradePoolCache) {
        if (entry.expires <= now) regionTradePoolCache.delete(key);
      }
    }
    return { trades: historyTrades, source };
  })();

  regionTradePoolInflight.set(region.slug, job);
  try {
    return await job;
  } finally {
    regionTradePoolInflight.delete(region.slug);
  }
}

type SeenRow = { tx: Transaction; firstSeenDate: string };

function collectSeen(historyTrades: Transaction[]): SeenRow[] {
  const seen: SeenRow[] = [];
  for (const tx of historyTrades) {
    const day = firstSeenKstDate(tx);
    if (!day) continue;
    seen.push({ tx, firstSeenDate: day });
  }
  return seen;
}

async function computeMarketKpis(
  historyTrades: Transaction[],
  contractYearMonth: string,
  today: string,
  lawdCodes: string[],
  source: "db" | "api",
) {
  const tKpi = performance.now();
  const currentYm = yearMonthFromSeoulDate(today);
  const comparePartial = contractYearMonth === currentYm;
  const dayCap = comparePartial ? today.slice(8, 10) : null;
  const current = tradesInContractMonth(
    historyTrades,
    contractYearMonth,
    dayCap,
  );
  const previous = tradesInContractMonth(
    historyTrades,
    shiftYearMonth(contractYearMonth, -1),
    dayCap,
  );
  const yearAgoYm = shiftYearMonth(contractYearMonth, -12);
  const yearAgoCovered = yearMonthInLookback(
    yearAgoYm,
    currentYm,
    REGION_DAILY_HISTORY_MONTHS,
  );
  const yearAgo = yearAgoCovered
    ? tradesInContractMonth(historyTrades, yearAgoYm, dayCap)
    : null;
  const priorMaxes = await typePriorMaxesForDeals({
    deals: current,
    historyTrades,
    lawdCodes,
    source,
  });
  let monthSingogaCount = 0;
  current.forEach((tx, index) => {
    if (typeRecordHigh(tx.dealAmount, priorMaxes[index] ?? 0).isSingoga) {
      monthSingogaCount += 1;
    }
  });
  if (activeProfile) {
    activeProfile.kpiMs += Math.round(performance.now() - tKpi);
    activeProfile.kpiDeals += current.length;
  }
  return {
    contractYearMonth,
    monthTradeCount: current.length,
    prevMonthTradeCount: previous.length,
    yearAgoMonthTradeCount: yearAgo ? yearAgo.length : yearAgoCovered ? 0 : null,
    comparePartial,
    medianPyeongPrice: medianPyeongPrice(current),
    monthSingogaCount,
  };
}

function buildCalendarDays(monthSeen: SeenRow[]): RegionDailyDaySummary[] {
  const dayMap = new Map<
    string,
    { dealCount: number; maxDealAmount: number }
  >();
  for (const { tx, firstSeenDate } of monthSeen) {
    const prev = dayMap.get(firstSeenDate);
    if (!prev) {
      dayMap.set(firstSeenDate, {
        dealCount: 1,
        maxDealAmount: tx.dealAmount,
      });
      continue;
    }
    prev.dealCount += 1;
    prev.maxDealAmount = Math.max(prev.maxDealAmount, tx.dealAmount);
  }
  return [...dayMap.entries()]
    .map(([date, value]) => ({
      date,
      dealCount: value.dealCount,
      tradeCount: value.dealCount,
      singogaCount: 0,
      singogaKnown: false,
      bulkIngestDay: value.dealCount > REGION_DAILY_SINGOGA_DAY_CAP,
      maxDealAmount: value.maxDealAmount,
    }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

async function enrichSeenDay(params: {
  lawdCodes: string[];
  source: "db" | "api";
  historyTrades: Transaction[];
  daySeen: SeenRow[];
  offset: number;
  withSparkline: boolean;
}): Promise<RegionDailyDaySection> {
  const { lawdCodes, source, historyTrades, daySeen, offset, withSparkline } =
    params;
  const date = daySeen[0]?.firstSeenDate ?? "";
  const totalCount = daySeen.length;
  const bulkIngestDay = totalCount > REGION_DAILY_SINGOGA_DAY_CAP;
  const tradesByApt = groupByAptName(historyTrades);

  if (bulkIngestDay) {
    const page = daySeen.slice(offset, offset + BULK_DAY_PAGE_SIZE);
    const deals = page.map(({ tx, firstSeenDate }) =>
      enrichDailyDeal(
        tx,
        0,
        tradesByApt.get(normalizeAptName(tx.aptName)) ?? [],
        firstSeenDate,
      ),
    );
    return {
      date,
      deals: sortNewlySeenDeals(deals),
      bulkIngestDay: true,
      singogaKnown: false,
      totalCount,
      singogaCount: 0,
      hasMore: offset + page.length < totalCount,
    };
  }

  const priorMaxes = await typePriorMaxesForDeals({
    deals: daySeen.map(({ tx }) => tx),
    historyTrades,
    lawdCodes,
    source,
  });

  const enriched = daySeen.map(({ tx, firstSeenDate }, index) =>
    enrichDailyDeal(
      tx,
      priorMaxes[index] ?? 0,
      tradesByApt.get(normalizeAptName(tx.aptName)) ?? [],
      firstSeenDate,
    ),
  );
  const deals = sortNewlySeenDeals(enriched);
  if (withSparkline) {
    const tSpark = performance.now();
    for (const deal of deals) {
      if (deal.singogaKind == null) continue;
      const aptTrades = tradesByApt.get(normalizeAptName(deal.aptName)) ?? [];
      const points = typePriceTrend({
        trades: aptTrades,
        exclusiveArea: deal.exclusiveArea,
        throughDate: deal.dealDate,
      });
      deal.priceTrend =
        points.length >= TYPE_TREND_MIN_POINTS ? points : null;
    }
    if (activeProfile) {
      activeProfile.sparklineMs += Math.round(performance.now() - tSpark);
    }
  }
  const singogaCount = deals.filter((d) => d.singogaKind != null).length;
  return {
    date,
    deals,
    bulkIngestDay: false,
    singogaKnown: true,
    totalCount,
    singogaCount,
    hasMore: false,
  };
}

async function computeRegionDaily(params: {
  region: RegionDef;
  part: RegionDailyPart;
  contractMonth: string;
  seenMonth: string;
  dates: string[];
  offset: number;
  today: string;
}): Promise<RegionDailyResponse> {
  const { region, part, contractMonth, seenMonth, dates, offset, today } =
    params;
  const lawdCodes = [...region.lawdCodes];
  const { trades: historyTrades, source } = await loadRegionTradePool(region);
  const src = source === "db" ? "db" : "api";
  const seen = collectSeen(historyTrades);
  const firstSeenReady = seen.length > 0;
  const activityYearMonths = activityYearMonthsFromSeenDates(
    seen.map((row) => row.firstSeenDate),
  );
  const contractMonthOptionList = contractMonthOptionsFromCoverage(
    yearMonthFromSeoulDate(today),
    oldestYearMonthFromDates(historyTrades.map((tx) => tx.dealDate)),
    REGION_DAILY_HISTORY_MONTHS,
  );
  const needsKpis = part === "market" || part === "all";
  const kpis = needsKpis
    ? await computeMarketKpis(
        historyTrades,
        contractMonth,
        today,
        lawdCodes,
        src,
      )
    : {
        contractYearMonth: contractMonth,
        monthTradeCount: 0,
        prevMonthTradeCount: 0,
        yearAgoMonthTradeCount: null as number | null,
        comparePartial: false,
        medianPyeongPrice: null as number | null,
        monthSingogaCount: null as number | null,
      };
  const hero = pickHeroSeenDate(
    seen.map((row) => row.firstSeenDate),
    today,
  );

  const base = emptyRegionDaily(region.slug, seenMonth, src, {
    ...kpis,
    firstSeenReady,
    selectedDate: hero.date,
    latestIsToday: hero.isToday,
    contractMonthOptions: contractMonthOptionList,
    activityYearMonths,
  });

  if (part === "market") {
    return base;
  }

  const tCal = performance.now();
  const monthSeen = seen.filter(
    (row) => yearMonthFromSeoulDate(row.firstSeenDate) === seenMonth,
  );
  const days = buildCalendarDays(monthSeen);
  const historyTotalCount = monthSeen.length;
  if (activeProfile) {
    activeProfile.calendarMs += Math.round(performance.now() - tCal);
  }

  if (part === "history") {
    return {
      ...base,
      yearMonth: seenMonth,
      days,
      historyTotalCount,
    };
  }

  const byDate = new Map<string, SeenRow[]>();
  for (const row of seen) {
    const prev = byDate.get(row.firstSeenDate);
    if (prev) prev.push(row);
    else byDate.set(row.firstSeenDate, [row]);
  }

  async function sectionsFor(
    wanted: string[],
    withSparkline: boolean,
    dayOffset: number,
  ): Promise<RegionDailyDaySection[]> {
    const out: RegionDailyDaySection[] = [];
    for (const date of wanted) {
      const daySeen = byDate.get(date);
      if (!daySeen?.length) continue;
      out.push(
        await enrichSeenDay({
          lawdCodes,
          source,
          historyTrades,
          daySeen,
          offset: dayOffset,
          withSparkline,
        }),
      );
    }
    return out;
  }

  if (part === "latest") {
    const daySeen = hero.date ? (byDate.get(hero.date) ?? []) : [];
    const tHero = performance.now();
    const section = daySeen.length
      ? await enrichSeenDay({
          lawdCodes,
          source,
          historyTrades,
          daySeen,
          offset: 0,
          withSparkline: true,
        })
      : null;
    if (activeProfile) {
      activeProfile.heroMs += Math.round(performance.now() - tHero);
      activeProfile.heroDeals += daySeen.length;
    }
    const deals = section?.deals ?? [];
    return {
      ...base,
      selectedDate: hero.date,
      latestIsToday: hero.isToday,
      deals,
      monthDeals: deals,
      maxDeal: deals[0] ?? null,
      avgDealAmount:
        deals.length > 0
          ? Math.round(
              deals.reduce((sum, d) => sum + d.dealAmount, 0) / deals.length,
            )
          : 0,
      tradeCount: section?.totalCount ?? 0,
      selectedDaySingogaCount: section?.singogaCount ?? 0,
      bulkIngestDay: section?.bulkIngestDay ?? false,
    };
  }

  if (part === "days") {
    const sections = await sectionsFor(dates, false, offset);
    const patchedDays = days.map((day) => {
      const section = sections.find((s) => s.date === day.date);
      if (!section) return day;
      return {
        ...day,
        singogaCount: section.singogaCount,
        singogaKnown: section.singogaKnown,
        bulkIngestDay: section.bulkIngestDay,
      };
    });
    return {
      ...base,
      yearMonth: seenMonth,
      days: patchedDays,
      historySections: sections,
      historyTotalCount,
    };
  }

  const initialDates = days
    .filter((d) => d.dealCount > 0)
    .slice(0, HISTORY_INITIAL_DAY_COUNT)
    .map((d) => d.date);
  const heroRows = hero.date ? (byDate.get(hero.date) ?? []) : [];
  const heroSection = heroRows.length
    ? await enrichSeenDay({
        lawdCodes,
        source,
        historyTrades,
        daySeen: heroRows,
        offset: 0,
        withSparkline: true,
      })
    : null;
  const historySections = await sectionsFor(initialDates, false, 0);
  const deals = heroSection?.deals ?? [];
  const patchedDays = days.map((day) => {
    const section =
      historySections.find((s) => s.date === day.date) ??
      (heroSection?.date === day.date ? heroSection : null);
    if (!section) return day;
    return {
      ...day,
      singogaCount: section.singogaCount,
      singogaKnown: section.singogaKnown,
      bulkIngestDay: section.bulkIngestDay,
    };
  });

  return {
    ...base,
    yearMonth: seenMonth,
    selectedDate: hero.date,
    latestIsToday: hero.isToday,
    days: patchedDays,
    historySections,
    historyTotalCount,
    deals,
    monthDeals: deals,
    maxDeal: deals[0] ?? null,
    avgDealAmount:
      deals.length > 0
        ? Math.round(
            deals.reduce((sum, d) => sum + d.dealAmount, 0) / deals.length,
          )
        : 0,
    tradeCount: heroSection?.totalCount ?? 0,
    selectedDaySingogaCount: heroSection?.singogaCount ?? 0,
    bulkIngestDay: heroSection?.bulkIngestDay ?? false,
  };
}

import {
  FEATURED_LAWD_CODES,
  LAWD_TO_REGION,
  PAGE_SIZE,
  getRegion,
  type RegionDef,
} from "@/lib/constants/regions";
import { hasDb } from "@/lib/db/client";
import {
  listAptCatalog,
  normalizeAptName,
  queryRegionBrowseApts,
  queryRegionMonthPool,
  queryTradePool,
} from "@/lib/db/repository";
import { fetchTransactionsByType, hasApiKey } from "@/lib/molit/client";
import { filterTransactions, sortByDealDateDesc } from "@/lib/molit/parse";
import { buildRegionDemoTransactions } from "@/lib/mock/region-demo";
import { MOCK_TRANSACTIONS } from "@/lib/mock/sample-data";
import {
  countTradesInYearMonth,
  featuredSingogaGroup,
  shiftYearMonth,
  splitFeaturedSingoga,
  TYPE_TREND_MIN_POINTS,
  typePriceTrend,
  yearMonthFromDealDate,
} from "@/lib/region/market-insight";
import {
  matchesAreaFilter,
  recentYearMonths,
  toPyeong,
} from "@/lib/utils/format";
import type {
  AreaFilter,
  DealType,
  Transaction,
  TransactionStats,
  TransactionsResponse,
} from "@/types/transaction";

const REGION_DAILY_HISTORY_MONTHS = 24;

function areaKey(sqm: number): string {
  return String(Math.round(sqm * 100) / 100);
}

function pyeongBucket(sqm: number): number {
  return Math.round(toPyeong(sqm));
}

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
  date: string; // YYYY-MM-DD
  dealCount: number;
  tradeCount: number;
  maxDealAmount: number;
}

export type RegionDailySingogaKind = "type" | "pyeong";

export interface RegionDailyDeal {
  id: string;
  aptName: string;
  gu: string;
  dong: string;
  exclusiveArea: number;
  floor: number;
  dealAmount: number;
  dealDate: string;
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
  /** Featured 동일 타입 추이. 비Featured는 생략 */
  priceTrend?: { date: string; amount: number }[] | null;
}

export interface RegionDailyResponse {
  regionSlug: string;
  yearMonth: string;
  source: "api" | "mock" | "db";
  warning?: string;
  selectedDate: string | null;
  days: RegionDailyDaySummary[];
  /** 해당 월의 신고가 전체 (클라이언트에서 날짜 필터) */
  monthDeals: RegionDailyDeal[];
  deals: RegionDailyDeal[];
  maxDeal: RegionDailyDeal | null;
  avgDealAmount: number;
  tradeCount: number;
  /** 해당 월 매매 건수 (신고가 여부와 무관) */
  monthTradeCount: number;
  /** 비교용 직전 월 매매 건수 (당월이면 동일 경과일까지) */
  prevMonthTradeCount: number;
  /** 당월이라 전월을 같은 일수까지만 비교했는지 */
  comparePartial: boolean;
}

function enrichDailyDeal(
  tx: Transaction,
  aptTrades: Transaction[],
  aptRents: Transaction[],
): RegionDailyDeal {
  const typeKey = areaKey(tx.exclusiveArea);
  const pyeongKey = pyeongBucket(tx.exclusiveArea);
  const dealDate = tx.dealDate.slice(0, 10);

  const prior = aptTrades.filter(
    (h) =>
      h.id !== tx.id &&
      (h.dealDate.slice(0, 10) < dealDate ||
        (h.dealDate.slice(0, 10) === dealDate && h.id < tx.id)),
  );

  let priorTypeMax = 0;
  let priorPyeongMax = 0;
  let typeMax = tx.dealAmount;
  let pyeongMax = tx.dealAmount;
  let complexMax = tx.dealAmount;

  for (const h of aptTrades) {
    complexMax = Math.max(complexMax, h.dealAmount);
    if (areaKey(h.exclusiveArea) === typeKey) {
      typeMax = Math.max(typeMax, h.dealAmount);
    }
    if (pyeongBucket(h.exclusiveArea) === pyeongKey) {
      pyeongMax = Math.max(pyeongMax, h.dealAmount);
    }
  }

  for (const h of prior) {
    if (areaKey(h.exclusiveArea) === typeKey) {
      priorTypeMax = Math.max(priorTypeMax, h.dealAmount);
    }
    if (pyeongBucket(h.exclusiveArea) === pyeongKey) {
      priorPyeongMax = Math.max(priorPyeongMax, h.dealAmount);
    }
  }

  const isTypeSingoga = tx.dealAmount > priorTypeMax;
  const isPyeongSingoga = tx.dealAmount > priorPyeongMax;
  const singogaKind: RegionDailySingogaKind | null = isTypeSingoga
    ? "type"
    : isPyeongSingoga
      ? "pyeong"
      : null;

  const baseline =
    singogaKind === "type"
      ? priorTypeMax
      : singogaKind === "pyeong"
        ? priorPyeongMax
        : Math.max(priorTypeMax, priorPyeongMax);
  const increaseAmount =
    singogaKind && baseline > 0 ? Math.max(0, tx.dealAmount - baseline) : 0;

  const since3m = monthsBefore(dealDate, 3);
  const recent3mCount = aptTrades.filter(
    (h) =>
      h.dealDate.slice(0, 10) >= since3m && h.dealDate.slice(0, 10) <= dealDate,
  ).length;

  const vsHighPct =
    complexMax > 0 ? Math.round((tx.dealAmount / complexMax) * 1000) / 10 : null;

  const matchedRents = aptRents.filter(
    (h) =>
      areaKey(h.exclusiveArea) === typeKey &&
      h.dealDate.slice(0, 10) <= dealDate,
  );
  const jeonseAmount =
    matchedRents.length > 0
      ? matchedRents.reduce((max, cur) =>
          cur.dealDate > max.dealDate ||
          (cur.dealDate === max.dealDate && cur.dealAmount > max.dealAmount)
            ? cur
            : max,
        ).dealAmount
      : null;

  return {
    id: tx.id,
    aptName: tx.aptName,
    gu: tx.gu,
    dong: tx.dong,
    exclusiveArea: tx.exclusiveArea,
    floor: tx.floor,
    dealAmount: tx.dealAmount,
    dealDate: tx.dealDate,
    buildYear: tx.buildYear,
    dealingGbn: tx.dealingGbn || "중개거래",
    singogaKind,
    increaseAmount,
    vsHighPct,
    recent3mCount,
    typeMaxAmount: typeMax,
    pyeongMaxAmount: pyeongMax,
    complexMaxAmount: complexMax,
    jeonseAmount,
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

const REGION_DAILY_CACHE_TTL_MS = 60_000;
const regionDailyCache = new Map<
  string,
  { expires: number; payload: RegionDailyResponse }
>();

function emptyRegionDaily(
  regionSlug: string,
  yearMonth: string,
  source: "api" | "mock" | "db",
): RegionDailyResponse {
  return {
    regionSlug,
    yearMonth,
    source,
    selectedDate: null,
    days: [],
    monthDeals: [],
    deals: [],
    maxDeal: null,
    avgDealAmount: 0,
    tradeCount: 0,
    monthTradeCount: 0,
    prevMonthTradeCount: 0,
    comparePartial: false,
  };
}

function withSelectedDate(
  payload: RegionDailyResponse,
  dateParam: string | null,
): RegionDailyResponse {
  const daySet = new Set(payload.days.map((d) => d.date));
  const today = new Date();
  const todayYm = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}`;
  const todayDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const requestedDate = dateParam?.trim() || null;
  const selectedDate =
    (requestedDate && daySet.has(requestedDate) ? requestedDate : null) ??
    (payload.yearMonth === todayYm && daySet.has(todayDate) ? todayDate : null) ??
    payload.days[0]?.date ??
    null;
  const deals = selectedDate
    ? payload.monthDeals
        .filter((deal) => deal.dealDate.slice(0, 10) === selectedDate)
        .map((deal) => {
          if (deal.priceTrend == null) return deal;
          const copy = { ...deal };
          delete copy.priceTrend;
          return copy;
        })
    : [];
  const maxDeal = deals[0] ?? null;
  const avgDealAmount =
    deals.length > 0
      ? Math.round(
          deals.reduce((sum, d) => sum + d.dealAmount, 0) / deals.length,
        )
      : 0;
  return {
    ...payload,
    selectedDate,
    deals,
    maxDeal,
    avgDealAmount,
    tradeCount: deals.length,
  };
}

export async function getRegionDaily(params: {
  regionSlug: string;
  yearMonth?: string;
  date?: string;
}): Promise<RegionDailyResponse> {
  const region = getRegion(params.regionSlug);
  if (!region) {
    throw new Error(`Unknown region: ${params.regionSlug}`);
  }

  const preferredYm = params.yearMonth || recentYearMonths(1)[0];
  const cacheKey = `${region.slug}:${preferredYm}`;
  const cached = regionDailyCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return withSelectedDate(cached.payload, params.date ?? null);
  }

  const payload = await computeRegionDaily(region, preferredYm);
  regionDailyCache.set(cacheKey, {
    expires: Date.now() + REGION_DAILY_CACHE_TTL_MS,
    payload,
  });
  if (regionDailyCache.size > 80) {
    const now = Date.now();
    for (const [key, entry] of regionDailyCache) {
      if (entry.expires <= now) regionDailyCache.delete(key);
    }
  }
  return withSelectedDate(payload, params.date ?? null);
}

async function computeRegionDaily(
  region: RegionDef,
  preferredYm: string,
): Promise<RegionDailyResponse> {
  const lawdCodes = [...region.lawdCodes];

  let items: Transaction[] = [];
  let source: "api" | "mock" | "db" = "api";
  let warning: string | undefined;
  let resolvedYearMonth = preferredYm;
  let historyTrades: Transaction[] = [];

  const historyMonths = recentYearMonths(REGION_DAILY_HISTORY_MONTHS);

  // DB 우선 — 24개월 매매 1회. 전세 풀은 신고가 판정에 쓰이지 않아 조회하지 않음.
  if (hasDb()) {
    try {
      const tradePool = await queryTradePool({
        lawdCodes,
        yearMonths: historyMonths,
      });
      if (tradePool) {
        historyTrades = tradePool.filter((tx) => tx.dealType === "trade");
        items = historyTrades.filter(
          (tx) => yearMonthFromDealDate(tx.dealDate) === preferredYm,
        );
        source = "db";
        resolvedYearMonth = preferredYm;
      }
    } catch (error) {
      console.warn("[region-daily] trade pool db read failed:", error);
    }
  }

  if (!historyTrades.length && source !== "db") {
    try {
      const loaded = await loadRawTransactions(
        preferredYm,
        "trade",
        lawdCodes,
        region.slug,
      );
      if (loaded.source !== "mock") {
        items = loaded.items.filter((tx) => tx.dealType === "trade");
        historyTrades = items;
        source = loaded.source;
        warning = loaded.warning;
        resolvedYearMonth = loaded.resolvedYearMonth;
      } else {
        source = "api";
        resolvedYearMonth = preferredYm;
      }
    } catch (error) {
      console.warn("[region-daily] month api read failed:", error);
      warning = "실거래 조회 중 오류가 발생했습니다.";
    }
  }

  const today = new Date();
  const todayYm = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}`;
  const todayDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const comparePartial = resolvedYearMonth === todayYm;
  const dayCap = comparePartial ? todayDate.slice(8, 10) : null;
  const prevYm = shiftYearMonth(resolvedYearMonth, -1);
  const tradeDates = (historyTrades.length ? historyTrades : items).map(
    (tx) => tx.dealDate,
  );
  const monthTradeCount = countTradesInYearMonth(
    tradeDates,
    resolvedYearMonth,
    dayCap,
  );
  const prevMonthTradeCount = countTradesInYearMonth(
    tradeDates,
    prevYm,
    dayCap,
  );

  if (items.length === 0) {
    return {
      ...emptyRegionDaily(
        region.slug,
        preferredYm,
        source === "db" ? "db" : "api",
      ),
      warning,
      monthTradeCount,
      prevMonthTradeCount,
      comparePartial,
    };
  }

  const tradesByApt = groupByAptName(historyTrades.length ? historyTrades : items);

  const enrichedMonth = items
    .map((tx) =>
      enrichDailyDeal(
        tx,
        tradesByApt.get(normalizeAptName(tx.aptName)) ?? [],
        [],
      ),
    )
    .filter((deal) => deal.singogaKind != null)
    .sort(
      (a, b) =>
        b.dealAmount - a.dealAmount ||
        a.aptName.localeCompare(b.aptName, "ko"),
    );

  const dayMap = new Map<
    string,
    { dealCount: number; tradeCount: number; maxDealAmount: number }
  >();

  for (const deal of enrichedMonth) {
    const date = deal.dealDate.slice(0, 10);
    if (!date) continue;
    const prev = dayMap.get(date);
    if (!prev) {
      dayMap.set(date, {
        dealCount: 1,
        tradeCount: 1,
        maxDealAmount: deal.dealAmount,
      });
      continue;
    }
    prev.dealCount += 1;
    prev.tradeCount += 1;
    prev.maxDealAmount = Math.max(prev.maxDealAmount, deal.dealAmount);
  }

  const days: RegionDailyDaySummary[] = [...dayMap.entries()]
    .map(([date, value]) => ({ date, ...value }))
    .sort((a, b) => b.date.localeCompare(a.date));

  const { expanded: sparklineDeals } = splitFeaturedSingoga(
    featuredSingogaGroup(enrichedMonth),
  );
  for (const deal of sparklineDeals) {
    const aptTrades = tradesByApt.get(normalizeAptName(deal.aptName)) ?? [];
    const points = typePriceTrend({
      trades: aptTrades,
      exclusiveArea: deal.exclusiveArea,
      throughDate: deal.dealDate,
    });
    deal.priceTrend =
      points.length >= TYPE_TREND_MIN_POINTS ? points : null;
  }

  return {
    regionSlug: region.slug,
    yearMonth: resolvedYearMonth,
    source,
    warning,
    selectedDate: null,
    days,
    monthDeals: enrichedMonth,
    deals: [],
    maxDeal: null,
    avgDealAmount: 0,
    tradeCount: 0,
    monthTradeCount,
    prevMonthTradeCount,
    comparePartial,
  };
}


import {
  FEATURED_LAWD_CODES,
  LAWD_TO_REGION,
  PAGE_SIZE,
  getRegion,
  type RegionDef,
} from "@/lib/constants/regions";
import { listAptCatalog } from "@/lib/db/repository";
import { fetchTransactionsByType, hasApiKey } from "@/lib/molit/client";
import { filterTransactions, sortByDealDateDesc } from "@/lib/molit/parse";
import { buildRegionDemoTransactions } from "@/lib/mock/region-demo";
import { MOCK_TRANSACTIONS } from "@/lib/mock/sample-data";
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
): Promise<{
  items: Transaction[];
  source: "api" | "mock";
  warning?: string;
  resolvedYearMonth: string;
}> {
  if (hasApiKey()) {
    const monthsToTry = [
      yearMonth,
      ...recentYearMonths(6).filter((ym) => ym !== yearMonth),
    ].slice(0, 4);

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

  const loaded = await loadRawTransactions(
    yearMonth,
    dealType,
    lawdCodes,
    params.regionSlug,
  );

  const filtered = sortByDealDateDesc(
    filterTransactions(loaded.items, {
      aptName: params.aptName,
      gu: params.gu,
      dong: params.dong,
      dealType: loaded.source === "api" ? "all" : dealType,
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
    source: loaded.source,
    yearMonth: loaded.resolvedYearMonth,
    warning: loaded.warning,
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
  source: "api" | "mock" | "catalog";
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

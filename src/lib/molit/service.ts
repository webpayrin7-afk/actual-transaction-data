import {
  FEATURED_LAWD_CODES,
  LAWD_TO_REGION,
  PAGE_SIZE,
  getRegion,
  type RegionDef,
} from "@/lib/constants/regions";
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

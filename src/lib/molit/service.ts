import {
  FEATURED_LAWD_CODES,
  PAGE_SIZE,
  districtNameFromCode,
} from "@/lib/constants/regions";
import { fetchTransactionsByType, hasApiKey } from "@/lib/molit/client";
import { filterTransactions, sortByDealDateDesc } from "@/lib/molit/parse";
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

function filterMockByLawd(
  items: Transaction[],
  lawdCodes: string[],
): Transaction[] {
  if (!lawdCodes.length) return items;
  const names = lawdCodes.map((c) => districtNameFromCode(c)).filter(Boolean);
  if (!names.length) return items;

  const matched = items.filter((item) =>
    names.some((n) => item.gu.includes(n) || n.includes(item.gu)),
  );
  return matched.length > 0 ? matched : items;
}

export async function loadRawTransactions(
  yearMonth: string,
  dealType: DealType | "all" = "all",
  lawdCodes: string[] = [...FEATURED_LAWD_CODES],
): Promise<{ items: Transaction[]; source: "api" | "mock" }> {
  if (hasApiKey()) {
    try {
      const items = await fetchTransactionsByType(
        yearMonth,
        dealType,
        lawdCodes,
      );
      return { items, source: "api" };
    } catch (error) {
      console.error("[molit] API fetch failed, falling back to mock:", error);
    }
  }

  const ymPrefix = `${yearMonth.slice(0, 4)}-${yearMonth.slice(4, 6)}`;
  let items = MOCK_TRANSACTIONS.filter((i) => i.dealDate.startsWith(ymPrefix));
  if (items.length === 0) items = [...MOCK_TRANSACTIONS];
  items = filterMockByLawd(items, lawdCodes);
  return { items, source: "mock" };
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
}): Promise<TransactionsResponse> {
  const yearMonth = params.yearMonth || recentYearMonths(1)[0];
  const dealType = params.dealType ?? "all";
  const page = Math.max(1, params.page ?? 1);
  const pageSize = params.pageSize ?? PAGE_SIZE;
  const lawdCodes = params.lawdCodes?.length
    ? params.lawdCodes
    : [...FEATURED_LAWD_CODES];

  const { items: raw, source } = await loadRawTransactions(
    yearMonth,
    dealType,
    lawdCodes,
  );

  const filtered = sortByDealDateDesc(
    filterTransactions(raw, {
      aptName: params.aptName,
      gu: params.gu,
      dong: params.dong,
      dealType: source === "api" ? "all" : dealType,
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
    yearMonth,
  };
}

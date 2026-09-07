import { FEATURED_LAWD_CODES } from "@/lib/constants/regions";
import { loadRawTransactions } from "@/lib/molit/service";
import { recentYearMonths, toPyeong } from "@/lib/utils/format";
import type { Transaction } from "@/types/transaction";

export interface RankItem {
  rank: number;
  transaction: Transaction;
  priceLabel: string;
  metaLabel: string;
}

export interface RankingsResponse {
  yearMonth: string;
  source: "api" | "mock";
  headline: string;
  tradeHigh: RankItem[];
  recent: RankItem[];
  rentHigh: RankItem[];
  largeArea: RankItem[];
}

function formatManwonShort(manwon: number): string {
  if (manwon >= 10000) {
    const eok = Math.round((manwon / 10000) * 100) / 100;
    return `${eok}억`;
  }
  return `${manwon.toLocaleString("ko-KR")}만`;
}

function toTradeRank(items: Transaction[], limit = 5): RankItem[] {
  return [...items]
    .filter((i) => i.dealType === "trade")
    .sort((a, b) => b.dealAmount - a.dealAmount)
    .slice(0, limit)
    .map((transaction, index) => ({
      rank: index + 1,
      transaction,
      priceLabel: formatManwonShort(transaction.dealAmount),
      metaLabel: `${transaction.exclusiveArea.toFixed(1)}㎡ (${toPyeong(transaction.exclusiveArea)}평) · ${transaction.dealDate.replaceAll("-", ".")}`,
    }));
}

function toRentRank(items: Transaction[], limit = 5): RankItem[] {
  return [...items]
    .filter((i) => i.dealType === "rent")
    .sort((a, b) => {
      if (b.dealAmount !== a.dealAmount) return b.dealAmount - a.dealAmount;
      return b.monthlyRent - a.monthlyRent;
    })
    .slice(0, limit)
    .map((transaction, index) => {
      const priceLabel =
        transaction.monthlyRent > 0
          ? `보 ${formatManwonShort(transaction.dealAmount)} / 월 ${transaction.monthlyRent.toLocaleString("ko-KR")}만`
          : `전세 ${formatManwonShort(transaction.dealAmount)}`;
      return {
        rank: index + 1,
        transaction,
        priceLabel,
        metaLabel: `${transaction.exclusiveArea.toFixed(1)}㎡ (${toPyeong(transaction.exclusiveArea)}평) · ${transaction.dealDate.replaceAll("-", ".")}`,
      };
    });
}

function toRecentRank(items: Transaction[], limit = 5): RankItem[] {
  return [...items]
    .sort((a, b) => {
      if (a.dealDate === b.dealDate) return b.dealAmount - a.dealAmount;
      return a.dealDate < b.dealDate ? 1 : -1;
    })
    .slice(0, limit)
    .map((transaction, index) => {
      const priceLabel =
        transaction.dealType === "rent"
          ? transaction.monthlyRent > 0
            ? `보 ${formatManwonShort(transaction.dealAmount)} / 월 ${transaction.monthlyRent.toLocaleString("ko-KR")}만`
            : `전세 ${formatManwonShort(transaction.dealAmount)}`
          : formatManwonShort(transaction.dealAmount);
      return {
        rank: index + 1,
        transaction,
        priceLabel,
        metaLabel: `${transaction.gu} ${transaction.dong} · ${transaction.dealDate.replaceAll("-", ".")}`,
      };
    });
}

function toLargeAreaRank(items: Transaction[], limit = 5): RankItem[] {
  return [...items]
    .filter((i) => i.dealType === "trade" && i.exclusiveArea >= 85)
    .sort((a, b) => b.dealAmount - a.dealAmount)
    .slice(0, limit)
    .map((transaction, index) => ({
      rank: index + 1,
      transaction,
      priceLabel: formatManwonShort(transaction.dealAmount),
      metaLabel: `${transaction.exclusiveArea.toFixed(1)}㎡ (${toPyeong(transaction.exclusiveArea)}평) · ${transaction.dealDate.replaceAll("-", ".")}`,
    }));
}

export async function getRankings(
  yearMonth?: string,
): Promise<RankingsResponse> {
  // 당월 우선. 데이터 없으면 loadRawTransactions가 데이터가 있는 월로 폴백
  const ym = yearMonth || recentYearMonths(1)[0];
  const { items, source, resolvedYearMonth } = await loadRawTransactions(
    ym,
    "all",
    [...FEATURED_LAWD_CODES],
  );

  const tradeHigh = toTradeRank(items);
  const recent = toRecentRank(items);
  const rentHigh = toRentRank(items);
  const largeArea = toLargeAreaRank(items);

  const top = tradeHigh[0];
  const rentTop = rentHigh[0];
  const displayYm = resolvedYearMonth || ym;
  const headline = top
    ? `아파트 실거래 ${displayYm.slice(0, 4)}.${displayYm.slice(4, 6)} (서울·경기 주요지역): 매매 최고가 ${top.transaction.aptName} ${top.priceLabel}${
        rentTop ? `, 전세 최고 ${rentTop.transaction.aptName} ${rentTop.priceLabel}` : ""
      }.`
    : `아파트 실거래 ${displayYm.slice(0, 4)}.${displayYm.slice(4, 6)} 순위입니다.`;

  return {
    yearMonth: displayYm,
    source,
    headline,
    tradeHigh,
    recent,
    rentHigh,
    largeArea,
  };
}

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
  /** 아파트 신고가 TOP — 단지별 최고 매매가 */
  singogaTop: RankItem[];
  recent: RankItem[];
  rentHigh: RankItem[];
  largeArea: RankItem[];
  /** @deprecated singogaTop 사용 */
  tradeHigh: RankItem[];
}

function formatManwonShort(manwon: number): string {
  if (manwon >= 10000) {
    const eok = Math.round((manwon / 10000) * 100) / 100;
    return `${eok}억`;
  }
  return `${manwon.toLocaleString("ko-KR")}만`;
}

function normalizeAptKey(tx: Transaction): string {
  const apt = tx.aptName.replace(/\s+/g, "").toLowerCase();
  const areaBucket = Math.round(tx.exclusiveArea);
  return `${apt}|${tx.gu}|${areaBucket}`;
}

/** 단지·유사면적별 최고 매매가 1건 → 금액순 TOP N (신고가) */
function toSingogaRank(items: Transaction[], limit = 5): RankItem[] {
  const bestByKey = new Map<string, Transaction>();

  for (const tx of items) {
    if (tx.dealType !== "trade" || tx.dealAmount <= 0) continue;
    const key = normalizeAptKey(tx);
    const prev = bestByKey.get(key);
    if (!prev || tx.dealAmount > prev.dealAmount) {
      bestByKey.set(key, tx);
    }
  }

  return [...bestByKey.values()]
    .sort((a, b) => {
      if (b.dealAmount !== a.dealAmount) return b.dealAmount - a.dealAmount;
      return a.dealDate < b.dealDate ? 1 : -1;
    })
    .slice(0, limit)
    .map((transaction, index) => {
      const pyeong = toPyeong(transaction.exclusiveArea);
      const perPyeong =
        pyeong > 0 ? Math.round(transaction.dealAmount / pyeong) : 0;
      return {
        rank: index + 1,
        transaction,
        priceLabel: formatManwonShort(transaction.dealAmount),
        metaLabel: `${transaction.gu} ${transaction.dong} · ${transaction.exclusiveArea.toFixed(1)}㎡ (${pyeong}평) · 평당 ${perPyeong.toLocaleString("ko-KR")}만 · ${transaction.dealDate.replaceAll("-", ".")}`,
      };
    });
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

  // 신고가는 매매 전용 조회로 구성, 나머지 섹션은 전체 거래
  const [tradeLoaded, allLoaded] = await Promise.all([
    loadRawTransactions(ym, "trade", [...FEATURED_LAWD_CODES]),
    loadRawTransactions(ym, "all", [...FEATURED_LAWD_CODES]),
  ]);

  const displayYm =
    tradeLoaded.resolvedYearMonth || allLoaded.resolvedYearMonth || ym;
  const source =
    tradeLoaded.source === "api" || allLoaded.source === "api" ? "api" : "mock";

  const singogaTop = toSingogaRank(tradeLoaded.items);
  const recent = toRecentRank(allLoaded.items);
  const rentHigh = toRentRank(allLoaded.items);
  const largeArea = toLargeAreaRank(tradeLoaded.items);

  const top = singogaTop[0];
  const rentTop = rentHigh[0];
  const headline = top
    ? `아파트 실거래 ${displayYm.slice(0, 4)}.${displayYm.slice(4, 6)} (서울·경기 주요지역): 아파트 신고가 ${top.transaction.aptName} ${top.priceLabel}${
        rentTop ? `, 전세 최고 ${rentTop.transaction.aptName} ${rentTop.priceLabel}` : ""
      }.`
    : `아파트 실거래 ${displayYm.slice(0, 4)}.${displayYm.slice(4, 6)} 순위입니다.`;

  return {
    yearMonth: displayYm,
    source,
    headline,
    singogaTop,
    tradeHigh: singogaTop,
    recent,
    rentHigh,
    largeArea,
  };
}

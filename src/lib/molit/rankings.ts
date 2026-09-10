import {
  FEATURED_LAWD_CODES,
} from "@/lib/constants/regions";
import { hasDb } from "@/lib/db/client";
import { queryRegionMonthPool } from "@/lib/db/repository";
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
  source: "api" | "mock" | "db";
  headline: string;
  /** 아파트 신고가 TOP — 단지별 최고 매매가 */
  singogaTop: RankItem[];
  /** 아파트 전세 TOP — 월세 0, 보증금 기준 */
  jeonseTop: RankItem[];
  /** 아파트 월세 TOP — 월세 > 0, 월세·보증금 기준 */
  wolseTop: RankItem[];
  /** @deprecated singogaTop 사용 */
  tradeHigh: RankItem[];
  /** @deprecated */
  recent: RankItem[];
  /** @deprecated jeonseTop/wolseTop 사용 */
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

function normalizeAptKey(tx: Transaction): string {
  const apt = tx.aptName.replace(/\s+/g, "").toLowerCase();
  const areaBucket = Math.round(tx.exclusiveArea);
  return `${apt}|${tx.gu}|${areaBucket}`;
}

function pickBestByKey(
  items: Transaction[],
  isMatch: (tx: Transaction) => boolean,
  isBetter: (next: Transaction, prev: Transaction) => boolean,
): Transaction[] {
  const bestByKey = new Map<string, Transaction>();
  for (const tx of items) {
    if (!isMatch(tx)) continue;
    const key = normalizeAptKey(tx);
    const prev = bestByKey.get(key);
    if (!prev || isBetter(tx, prev)) {
      bestByKey.set(key, tx);
    }
  }
  return [...bestByKey.values()];
}

function toMeta(tx: Transaction): string {
  return `${tx.gu} ${tx.dong} · ${tx.exclusiveArea.toFixed(1)}㎡ (${toPyeong(tx.exclusiveArea)}평) · ${tx.dealDate.replaceAll("-", ".")}`;
}

/** 단지·유사면적별 최고 매매가 1건 → 금액순 TOP N (신고가) */
function toSingogaRank(items: Transaction[], limit = 5): RankItem[] {
  return pickBestByKey(
    items,
    (tx) => tx.dealType === "trade" && tx.dealAmount > 0,
    (next, prev) => next.dealAmount > prev.dealAmount,
  )
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
        metaLabel: `${toMeta(transaction)} · 평당 ${perPyeong.toLocaleString("ko-KR")}만`,
      };
    });
}

/** 전세: monthlyRent === 0, 보증금 높은 순 */
function toJeonseRank(items: Transaction[], limit = 5): RankItem[] {
  return pickBestByKey(
    items,
    (tx) =>
      tx.dealType === "rent" && tx.monthlyRent === 0 && tx.dealAmount > 0,
    (next, prev) => next.dealAmount > prev.dealAmount,
  )
    .sort((a, b) => {
      if (b.dealAmount !== a.dealAmount) return b.dealAmount - a.dealAmount;
      return a.dealDate < b.dealDate ? 1 : -1;
    })
    .slice(0, limit)
    .map((transaction, index) => ({
      rank: index + 1,
      transaction,
      priceLabel: `전세 ${formatManwonShort(transaction.dealAmount)}`,
      metaLabel: toMeta(transaction),
    }));
}

/** 월세: monthlyRent > 0, 월세 → 보증금 순 */
function toWolseRank(items: Transaction[], limit = 5): RankItem[] {
  return pickBestByKey(
    items,
    (tx) => tx.dealType === "rent" && tx.monthlyRent > 0,
    (next, prev) => {
      if (next.monthlyRent !== prev.monthlyRent) {
        return next.monthlyRent > prev.monthlyRent;
      }
      return next.dealAmount > prev.dealAmount;
    },
  )
    .sort((a, b) => {
      if (b.monthlyRent !== a.monthlyRent) return b.monthlyRent - a.monthlyRent;
      if (b.dealAmount !== a.dealAmount) return b.dealAmount - a.dealAmount;
      return a.dealDate < b.dealDate ? 1 : -1;
    })
    .slice(0, limit)
    .map((transaction, index) => ({
      rank: index + 1,
      transaction,
      priceLabel: `보 ${formatManwonShort(transaction.dealAmount)} / 월 ${transaction.monthlyRent.toLocaleString("ko-KR")}만`,
      metaLabel: toMeta(transaction),
    }));
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
  const ym = yearMonth || recentYearMonths(1)[0];

  let tradeItems: Transaction[] = [];
  let rentItems: Transaction[] = [];
  let source: "api" | "mock" | "db" = "mock";
  let displayYm = ym;

  if (hasDb()) {
    const [tradeLoaded, rentLoaded] = await Promise.all([
      queryRegionMonthPool({
        lawdCodes: [...FEATURED_LAWD_CODES],
        yearMonths: [ym],
        dealKinds: ["trade"],
      }),
      queryRegionMonthPool({
        lawdCodes: [...FEATURED_LAWD_CODES],
        yearMonths: [ym],
        dealKinds: ["rent"],
      }),
    ]);
    tradeItems = tradeLoaded ?? [];
    rentItems = rentLoaded ?? [];
    source = "db";
  } else {
    const [tradeLoaded, rentLoaded] = await Promise.all([
      loadRawTransactions(ym, "trade", [...FEATURED_LAWD_CODES]),
      loadRawTransactions(ym, "rent", [...FEATURED_LAWD_CODES]),
    ]);
    tradeItems = tradeLoaded.items;
    rentItems = rentLoaded.items;
    displayYm =
      tradeLoaded.resolvedYearMonth || rentLoaded.resolvedYearMonth || ym;
    source =
      tradeLoaded.source === "api" || rentLoaded.source === "api"
        ? "api"
        : "mock";
  }

  const singogaTop = toSingogaRank(tradeItems);
  const jeonseTop = toJeonseRank(rentItems);
  const wolseTop = toWolseRank(rentItems);
  const largeArea = toLargeAreaRank(tradeItems);

  const top = singogaTop[0];
  const jeonseFirst = jeonseTop[0];
  const headline = top
    ? `아파트 실거래 ${displayYm.slice(0, 4)}.${displayYm.slice(4, 6)} (서울·경기 주요지역): 아파트 신고가 ${top.transaction.aptName} ${top.priceLabel}${
        jeonseFirst
          ? `, 전세 최고 ${jeonseFirst.transaction.aptName} ${jeonseFirst.priceLabel}`
          : ""
      }.`
    : `아파트 실거래 ${displayYm.slice(0, 4)}.${displayYm.slice(4, 6)} 순위입니다.`;

  return {
    yearMonth: displayYm,
    source,
    headline,
    singogaTop,
    jeonseTop,
    wolseTop,
    tradeHigh: singogaTop,
    recent: [],
    rentHigh: jeonseTop,
    largeArea,
  };
}

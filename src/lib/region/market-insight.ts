/** 지역 시장 요약용 deterministic 한 줄. LLM/외부 API 없음. */

export function yearMonthFromDealDate(dealDate: string): string {
  const d = dealDate.slice(0, 10);
  return `${d.slice(0, 4)}${d.slice(5, 7)}`;
}

export function shiftYearMonth(ym: string, delta: number): string {
  const year = Number(ym.slice(0, 4));
  const month = Number(ym.slice(4, 6));
  const date = new Date(year, month - 1 + delta, 1);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  return `${y}${m}`;
}

export function countTradesInYearMonth(
  dates: string[],
  yearMonth: string,
  maxDayInclusive?: string | null,
): number {
  let n = 0;
  for (const raw of dates) {
    const d = raw.slice(0, 10);
    if (yearMonthFromDealDate(d) !== yearMonth) continue;
    if (maxDayInclusive && d.slice(8, 10) > maxDayInclusive) continue;
    n += 1;
  }
  return n;
}

export function volumeChangePct(
  current: number,
  previous: number,
): number | null {
  if (previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}

export function regionMarketInsight(input: {
  monthTradeCount: number;
  prevMonthTradeCount: number;
  singogaCount: number;
  comparePartial: boolean;
}): string | null {
  const pct = volumeChangePct(input.monthTradeCount, input.prevMonthTradeCount);
  const vs = input.comparePartial ? "전월 같은 기간 대비" : "전월 대비";

  if (pct != null && pct !== 0) {
    const abs = Math.abs(pct).toLocaleString("ko-KR");
    if (pct > 0) {
      return `${vs} 거래량이 ${abs}% 늘었습니다.`;
    }
    return `${vs} 거래량이 ${abs}% 줄었습니다.`;
  }

  if (input.singogaCount > 0) {
    return `이번 달 신고가 ${input.singogaCount.toLocaleString("ko-KR")}건`;
  }

  if (input.monthTradeCount > 0) {
    return `이번 달 매매 ${input.monthTradeCount.toLocaleString("ko-KR")}건 · 신고가 없음`;
  }

  return "이번 달 매매 실거래 없음";
}

export function groupDealsByDate<
  T extends { dealDate: string; dealAmount: number; aptName: string },
>(deals: T[]): { date: string; deals: T[] }[] {
  const map = new Map<string, T[]>();
  for (const deal of deals) {
    const date = deal.dealDate.slice(0, 10);
    const prev = map.get(date);
    if (prev) prev.push(deal);
    else map.set(date, [deal]);
  }
  return [...map.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, group]) => ({
      date,
      deals: [...group].sort(
        (a, b) =>
          b.dealAmount - a.dealAmount ||
          a.aptName.localeCompare(b.aptName, "ko"),
      ),
    }));
}

export const RECENT_SINGOGA_LIMIT = 4;
export const COMPACT_SINGOGA_LIMIT = 3;
export const TYPE_TREND_MIN_POINTS = 3;
export const TYPE_TREND_MONTHS = 24;

export function recentSingogaDeals<T extends { dealDate: string; dealAmount: number; aptName: string }>(
  deals: T[],
  limit = RECENT_SINGOGA_LIMIT,
): T[] {
  return [...deals]
    .sort(
      (a, b) =>
        b.dealDate.slice(0, 10).localeCompare(a.dealDate.slice(0, 10)) ||
        b.dealAmount - a.dealAmount ||
        a.aptName.localeCompare(b.aptName, "ko"),
    )
    .slice(0, limit);
}

/** 전용면적 타입 키 — 0.01㎡ 반올림. service.areaKey와 동일. */
export function areaTypeKey(sqm: number): string {
  return String(Math.round(sqm * 100) / 100);
}

export function latestRecordDate<T extends { dealDate: string }>(
  deals: T[],
): string | null {
  let latest: string | null = null;
  for (const deal of deals) {
    const day = deal.dealDate.slice(0, 10);
    if (!latest || day > latest) latest = day;
  }
  return latest;
}

/** 최신 계약일 신고가 전체. 정렬은 표시 순서일 뿐 시간 순서가 아님. */
export function featuredSingogaGroup<
  T extends {
    dealDate: string;
    increaseAmount: number;
    dealAmount: number;
    aptName: string;
  },
>(deals: T[]): T[] {
  const latest = latestRecordDate(deals);
  if (!latest) return [];
  return deals
    .filter((deal) => deal.dealDate.slice(0, 10) === latest)
    .sort(
      (a, b) =>
        b.increaseAmount - a.increaseAmount ||
        b.dealAmount - a.dealAmount ||
        a.aptName.localeCompare(b.aptName, "ko"),
    );
}

export function compactSingogaDeals<
  T extends { dealDate: string; dealAmount: number; aptName: string },
>(deals: T[], latest: string | null, limit = COMPACT_SINGOGA_LIMIT): T[] {
  if (!latest) return [];
  return deals
    .filter((deal) => deal.dealDate.slice(0, 10) < latest)
    .sort(
      (a, b) =>
        b.dealDate.slice(0, 10).localeCompare(a.dealDate.slice(0, 10)) ||
        b.dealAmount - a.dealAmount ||
        a.aptName.localeCompare(b.aptName, "ko"),
    )
    .slice(0, limit);
}

export function latestRecordSectionCue(
  date: string,
  count: number,
): string {
  const d = date.slice(0, 10);
  return `${Number(d.slice(5, 7))}월 ${Number(d.slice(8, 10))}일 · ${count.toLocaleString("ko-KR")}건`;
}

export type TypeTrendPoint = { date: string; amount: number };

function monthsBeforeDate(dateStr: string, months: number): string {
  const d = new Date(`${dateStr.slice(0, 10)}T00:00:00`);
  d.setMonth(d.getMonth() - months);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * 동일 단지·동일 areaTypeKey 실거래 점. 빈 월은 0으로 채우지 않음.
 * 같은 달/같은 날 여러 거래는 모두 보존 (평균 아님).
 */
export function typePriceTrend(params: {
  trades: { dealDate: string; exclusiveArea: number; dealAmount: number }[];
  exclusiveArea: number;
  throughDate: string;
  months?: number;
}): TypeTrendPoint[] {
  const key = areaTypeKey(params.exclusiveArea);
  const through = params.throughDate.slice(0, 10);
  const from = monthsBeforeDate(through, params.months ?? TYPE_TREND_MONTHS);
  return params.trades
    .filter((tx) => {
      const day = tx.dealDate.slice(0, 10);
      return (
        areaTypeKey(tx.exclusiveArea) === key &&
        day >= from &&
        day <= through
      );
    })
    .map((tx) => ({
      date: tx.dealDate.slice(0, 10),
      amount: tx.dealAmount,
    }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.amount - b.amount);
}

/** 종전 최고가(만원). 상승액이 없으면 첫 신고가라 null. */
export function priorPeakAmount(deal: {
  dealAmount: number;
  increaseAmount: number;
}): number | null {
  if (deal.increaseAmount <= 0) return null;
  return deal.dealAmount - deal.increaseAmount;
}

/** 종전 최고 대비 상승률(%). 소수 1자리. */
export function increaseRatePct(deal: {
  dealAmount: number;
  increaseAmount: number;
}): number | null {
  const prior = priorPeakAmount(deal);
  if (prior == null || prior <= 0) return null;
  return Math.round((deal.increaseAmount / prior) * 1000) / 10;
}

/**
 * Option B 레거시: 최신일 1건. 같은 날 상승액 우선.
 * Featured는 featuredSingogaGroup(최신일 전체)을 쓴다.
 */
export function pickFeaturedSingogaDeal<
  T extends {
    dealDate: string;
    increaseAmount: number;
    dealAmount: number;
    aptName: string;
  },
>(deals: T[]): T | null {
  return featuredSingogaGroup(deals)[0] ?? null;
}

export function recordDateDomId(date: string): string {
  return `record-date-${date.slice(0, 10)}`;
}

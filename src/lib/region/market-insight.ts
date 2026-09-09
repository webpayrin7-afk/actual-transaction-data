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

export function recordDateDomId(date: string): string {
  return `record-date-${date.slice(0, 10)}`;
}

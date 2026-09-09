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
  singogaCount: number | null;
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

  if (input.singogaCount != null && input.singogaCount > 0) {
    return `이번 달 신고가 ${input.singogaCount.toLocaleString("ko-KR")}건`;
  }

  if (input.monthTradeCount > 0) {
    if (input.singogaCount == null) {
      return `이번 달 매매 ${input.monthTradeCount.toLocaleString("ko-KR")}건`;
    }
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

export const NEWLY_SEEN_INITIAL_LIMIT = 16;

export function koreanMonthDayLabel(date: string): string {
  const d = date.slice(0, 10);
  return `${Number(d.slice(5, 7))}월 ${Number(d.slice(8, 10))}일`;
}

export function koreanYearMonthLabel(ym: string): string {
  if (ym.length !== 6) return ym;
  return `${ym.slice(0, 4)}년 ${Number(ym.slice(4, 6))}월`;
}

export const CONTRACT_DATE_BASIS_LABEL = "계약일 기준";
export const CONTRACT_DATE_BASIS_HELP =
  "실제 매매계약이 체결된 날짜를 기준으로 집계합니다. 최근 월은 신고 시차로 거래량이 추가될 수 있습니다.";

export const SEEN_DATE_BASIS_LABEL = "확인일 기준";
export const SEEN_DATE_BASIS_HELP =
  "아파트 데이터랩이 거래를 처음 확인한 날짜입니다. 실제 계약일과 다를 수 있습니다.";

export const HISTORY_DATE_BASIS_HELP =
  "이 달 새로 확인된 매매 전체입니다. 계약월과 다를 수 있습니다.";

export const LEGACY_FIRST_SEEN_NOTE =
  "확인일 기반 내역은 시스템이 확인 시각을 기록한 거래부터 볼 수 있습니다.";

export function newlySeenSectionTitle(isToday: boolean): string {
  return isToday ? "오늘 새로 확인된 거래" : "최근 새로 확인된 거래";
}

/** 오늘 확인분이 있으면 오늘, 없으면 가장 최근 확인일. */
export function pickHeroSeenDate(
  dates: string[],
  today: string,
): { date: string | null; isToday: boolean } {
  const day = today.slice(0, 10);
  for (const raw of dates) {
    if (raw.slice(0, 10) === day) return { date: day, isToday: true };
  }
  let latest = "";
  for (const raw of dates) {
    const d = raw.slice(0, 10);
    if (d > latest) latest = d;
  }
  return { date: latest || null, isToday: false };
}

export function medianDealAmount(amounts: number[]): number | null {
  if (amounts.length === 0) return null;
  const sorted = [...amounts].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

export function groupDealsBySeenDate<
  T extends { firstSeenDate: string; dealAmount: number; aptName: string },
>(deals: T[]): { date: string; deals: T[] }[] {
  const map = new Map<string, T[]>();
  for (const deal of deals) {
    const date = deal.firstSeenDate.slice(0, 10);
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

/** SECTION 3: 처음 펼치는 최근 확인일 수 */
export const HISTORY_INITIAL_DAY_COUNT = 5;
/** 한 요청에서 신고가를 계산할 최대 날짜 수 */
export const HISTORY_DAY_FETCH_CAP = 8;

/** 표시 순서. 시간 순서가 아님. */
export function sortNewlySeenDeals<
  T extends {
    id: string;
    singogaKind: string | null;
    increaseAmount: number;
    dealAmount: number;
    aptName: string;
    exclusiveArea: number;
  },
>(deals: T[]): T[] {
  const records = deals.filter((d) => d.singogaKind != null);
  const rest = deals.filter((d) => d.singogaKind == null);
  records.sort(
    (a, b) =>
      b.increaseAmount - a.increaseAmount ||
      b.dealAmount - a.dealAmount ||
      a.aptName.localeCompare(b.aptName, "ko") ||
      a.id.localeCompare(b.id),
  );
  rest.sort(
    (a, b) =>
      b.dealAmount - a.dealAmount ||
      a.aptName.localeCompare(b.aptName, "ko") ||
      b.exclusiveArea - a.exclusiveArea ||
      a.id.localeCompare(b.id),
  );
  return [...records, ...rest];
}

/**
 * 신고가는 항상 포함. 나머지는 한도까지.
 * 더보기 때문에 신고가가 숨지 않는다.
 */
export function visibleNewlySeenDeals<
  T extends { singogaKind: string | null },
>(
  deals: T[],
  expanded: boolean,
  limit = NEWLY_SEEN_INITIAL_LIMIT,
): T[] {
  if (expanded || deals.length <= limit) return deals;
  const records = deals.filter((d) => d.singogaKind != null);
  const rest = deals.filter((d) => d.singogaKind == null);
  if (records.length >= limit) return records;
  return [...records, ...rest.slice(0, limit - records.length)];
}

export function hiddenNewlySeenCount<
  T extends { singogaKind: string | null },
>(
  deals: T[],
  expanded: boolean,
  limit = NEWLY_SEEN_INITIAL_LIMIT,
): number {
  return Math.max(0, deals.length - visibleNewlySeenDeals(deals, expanded, limit).length);
}

/**
 * 동일 단지·동일 전용면적(areaKey)의 deal_date 이전 최고가.
 * 같은 계약일의 다른 건은 prior에 넣지 않는다.
 */
export function priorTypeMaxAmount(params: {
  exclusiveArea: number;
  dealDate: string;
  history: { exclusiveArea: number; dealDate: string; dealAmount: number }[];
}): number {
  const key = areaTypeKey(params.exclusiveArea);
  const day = params.dealDate.slice(0, 10);
  let max = 0;
  for (const h of params.history) {
    if (areaTypeKey(h.exclusiveArea) !== key) continue;
    if (h.dealDate.slice(0, 10) >= day) continue;
    if (h.dealAmount > max) max = h.dealAmount;
  }
  return max;
}

/**
 * 동일 단지·areaKey에서 현재 계약일 이전, 가장 가까운 매매 금액.
 * 같은 계약일의 다른 건은 넣지 않는다. history가 비면 null.
 */
export function previousTypeDealAmount(params: {
  exclusiveArea: number;
  dealDate: string;
  history: { exclusiveArea: number; dealDate: string; dealAmount: number }[];
}): number | null {
  const key = areaTypeKey(params.exclusiveArea);
  const day = params.dealDate.slice(0, 10);
  let bestDate = "";
  let bestAmount: number | null = null;
  for (const h of params.history) {
    if (areaTypeKey(h.exclusiveArea) !== key) continue;
    const d = h.dealDate.slice(0, 10);
    if (d >= day) continue;
    if (d >= bestDate) {
      bestDate = d;
      bestAmount = h.dealAmount;
    }
  }
  return bestAmount;
}

export type VsPreviousDeal =
  | { kind: "up" | "down"; amount: number }
  | { kind: "same" };

export function vsPreviousTypeDeal(
  current: number,
  previous: number | null | undefined,
): VsPreviousDeal | null {
  if (previous == null || previous <= 0) return null;
  const delta = current - previous;
  if (delta === 0) return { kind: "same" };
  return {
    kind: delta > 0 ? "up" : "down",
    amount: Math.abs(delta),
  };
}

/** 역대 prior max 초과만 타입 신고가. 해당 타입 첫 거래는 신고가가 아님. */
export function typeRecordHigh(
  dealAmount: number,
  priorMax: number,
): { isSingoga: boolean; increaseAmount: number } {
  const isSingoga = priorMax > 0 && dealAmount > priorMax;
  return {
    isSingoga,
    increaseAmount: isSingoga ? Math.max(0, dealAmount - priorMax) : 0,
  };
}

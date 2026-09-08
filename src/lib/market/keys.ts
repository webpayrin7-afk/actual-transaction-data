/** 시장 홈·통계 공통: 단지/면적 키 · 신고가/하락 임계값 */

export const MARKET_COMPLEX_KEY_VERSION = "apt_norm|lawd_cd|dong|area100";

/** 과거 최고가 대비 −10% 이상이면 큰 폭 하락 */
export const DROP_THRESHOLD = -0.1;

export function areaKey(sqm: number): string {
  return String(Math.round(sqm * 100) / 100);
}

export function typeKey(
  norm: string,
  lawdCd: string,
  dong: string,
  sqm: number,
): string {
  return `${norm}|${lawdCd}|${dong}|${areaKey(sqm)}`;
}

export type StatsScope = "all" | "seoul" | "gyeonggi";
export type StatsPeriod = "daily" | "weekly" | "monthly";

export function metroFromLawd(lawdCd: string): "seoul" | "gyeonggi" | "other" {
  if (lawdCd.startsWith("11")) return "seoul";
  if (lawdCd.startsWith("41")) return "gyeonggi";
  return "other";
}

export function scopeMatchesLawd(scope: StatsScope, lawdCd: string): boolean {
  if (scope === "all") return true;
  return metroFromLawd(lawdCd) === scope;
}

/** YYYY-MM-DD → 해당 주의 월요일 (달력일, UTC 자정 산술) */
export function weekStartMonday(isoDay: string): string {
  const d = new Date(`${isoDay.slice(0, 10)}T00:00:00Z`);
  const dow = d.getUTCDay(); // 0 Sun .. 6 Sat
  const delta = dow === 0 ? -6 : 1 - dow;
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

export function weekEndSunday(isoDay: string): string {
  return addDays(weekStartMonday(isoDay), 6);
}

export function monthKey(isoDay: string): string {
  return isoDay.slice(0, 7); // YYYY-MM
}

export function monthStart(isoDay: string): string {
  return `${isoDay.slice(0, 7)}-01`;
}

export function monthEnd(isoDay: string): string {
  return addDays(addMonths(monthStart(isoDay), 1), -1);
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function addMonths(iso: string, months: number): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

export function daysBetweenInclusive(from: string, to: string): number {
  const a = new Date(`${from.slice(0, 10)}T00:00:00Z`).getTime();
  const b = new Date(`${to.slice(0, 10)}T00:00:00Z`).getTime();
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

export interface PeriodWindow {
  /** 선택 기간 KPI/실거래 시작 */
  curFrom: string;
  /** 선택 기간 KPI/실거래 종료 */
  curTo: string;
  prevFrom: string;
  prevTo: string;
  windowLabel: string;
  prevWindowLabel: string;
  /** 비교 라벨 (전일 대비 / 전주 동일기간 대비 등) */
  compareLabel: string;
  alignedPartial: boolean;
  /** 최신 계약일 구간(신고 지연 가능) */
  reportingLagRisk: boolean;
  /** 추세 차트 시작 */
  chartFrom: string;
  /** 추세 차트 종료 (= curTo) */
  chartTo: string;
  /** 네비게이션용 앵커 (일=그날, 주=월요일, 월=1일) */
  anchorDate: string;
  canGoNext: boolean;
  canGoPrev: boolean;
  prevAnchor: string;
  nextAnchor: string;
}

function fmtMd(iso: string): string {
  return `${iso.slice(5, 7)}.${iso.slice(8, 10)}`;
}

/**
 * 선택 기간(KPI/실거래)과 추세 차트 범위를 분리해 계산.
 * selectedDate: URL date (해당 기간에 속하는 아무 날)
 * asOfDate: DB 최신 계약일 — 미래/미완성 구간 클램프
 */
export function resolvePeriodWindow(
  selectedDate: string,
  period: StatsPeriod,
  asOfDate: string,
): PeriodWindow {
  const selected = selectedDate.slice(0, 10);
  const asOf = asOfDate.slice(0, 10);

  if (period === "daily") {
    const day = selected > asOf ? asOf : selected;
    const prev = addDays(day, -1);
    return {
      curFrom: day,
      curTo: day,
      prevFrom: prev,
      prevTo: prev,
      windowLabel: day,
      prevWindowLabel: prev,
      compareLabel: "전일 대비",
      alignedPartial: false,
      reportingLagRisk: day === asOf,
      chartFrom: addDays(day, -29),
      chartTo: day,
      anchorDate: day,
      canGoNext: day < asOf,
      canGoPrev: true,
      prevAnchor: prev,
      nextAnchor: addDays(day, 1),
    };
  }

  if (period === "weekly") {
    let weekStart = weekStartMonday(selected);
    const weekEnd = addDays(weekStart, 6);
    // 미래 주 진입 방지
    if (weekStart > asOf) {
      weekStart = weekStartMonday(asOf);
    }
    const curWeekEnd = addDays(weekStart, 6);
    const isCurrentWeek = asOf >= weekStart && asOf <= curWeekEnd;
    const curTo = isCurrentWeek ? asOf : curWeekEnd;
    const elapsed = daysBetweenInclusive(weekStart, curTo);
    const prevFrom = addDays(weekStart, -7);
    const prevTo = addDays(prevFrom, elapsed);
    const partial = curTo < curWeekEnd;
    const nextStart = addDays(weekStart, 7);
    return {
      curFrom: weekStart,
      curTo,
      prevFrom,
      prevTo,
      windowLabel: `${fmtMd(weekStart)} ~ ${fmtMd(curWeekEnd)}`,
      prevWindowLabel: partial
        ? `${fmtMd(prevFrom)} ~ ${fmtMd(prevTo)}`
        : `${fmtMd(prevFrom)} ~ ${fmtMd(addDays(prevFrom, 6))}`,
      compareLabel: partial ? "전주 동일기간 대비" : "직전 주 대비",
      alignedPartial: partial,
      reportingLagRisk: isCurrentWeek,
      chartFrom: addDays(weekStart, -7 * 15),
      chartTo: curTo,
      anchorDate: weekStart,
      canGoNext: nextStart <= asOf,
      canGoPrev: true,
      prevAnchor: prevFrom,
      nextAnchor: nextStart,
    };
  }

  // monthly
  let mStart = monthStart(selected);
  if (mStart > asOf) mStart = monthStart(asOf);
  const mEnd = monthEnd(mStart);
  const isCurrentMonth = asOf >= mStart && asOf <= mEnd;
  const curTo = isCurrentMonth ? asOf : mEnd;
  const dayNum = Number(curTo.slice(8, 10));
  const prevFrom = addMonths(mStart, -1);
  const prevMonthLast = addDays(mStart, -1);
  const candidate = `${prevFrom.slice(0, 7)}-${String(dayNum).padStart(2, "0")}`;
  const prevTo = candidate <= prevMonthLast ? candidate : prevMonthLast;
  const partial = curTo < mEnd;
  const nextStart = addMonths(mStart, 1);
  const ym = mStart.slice(0, 7);
  return {
    curFrom: mStart,
    curTo,
    prevFrom,
    prevTo,
    windowLabel: `${ym.slice(0, 4)}년 ${Number(ym.slice(5, 7))}월`,
    prevWindowLabel: partial
      ? `${prevFrom.slice(0, 7)} 동일 경과일`
      : `${prevFrom.slice(0, 7)}`,
    compareLabel: partial ? "전월 동일기간 대비" : "직전 월 대비",
    alignedPartial: partial,
    reportingLagRisk: isCurrentMonth,
    chartFrom: addMonths(mStart, -17),
    chartTo: curTo,
    anchorDate: mStart,
    canGoNext: nextStart <= asOf,
    canGoPrev: true,
    prevAnchor: prevFrom,
    nextAnchor: nextStart,
  };
}

export function medianSorted(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

export function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return medianSorted(sorted);
}

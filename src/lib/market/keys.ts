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

/** YYYY-MM-DD → 해당 주의 월요일 (UTC 날짜 기준) */
export function weekStartMonday(isoDay: string): string {
  const d = new Date(`${isoDay.slice(0, 10)}T00:00:00Z`);
  const dow = d.getUTCDay(); // 0 Sun .. 6 Sat
  const delta = dow === 0 ? -6 : 1 - dow;
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

export function monthKey(isoDay: string): string {
  return isoDay.slice(0, 7); // YYYY-MM
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

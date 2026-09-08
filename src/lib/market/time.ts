/** Asia/Seoul 기준 날짜·시각 헬퍼 (서버 TZ와 무관) */

const SEOUL = "Asia/Seoul";

/** 한국시간 기준 오늘 YYYY-MM-DD */
export function seoulToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: SEOUL,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** 한국시간 기준 시각의 ISO 날짜(YYYY-MM-DD) */
export function seoulDateOf(isoOrDate: string | Date): string {
  const d = typeof isoOrDate === "string" ? new Date(isoOrDate) : isoOrDate;
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: SEOUL,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/**
 * 한국시간 하루 경계를 UTC ISO로.
 * first_seen_at이 UTC로 저장된 경우 Seoul 달력일 필터에 사용.
 */
export function seoulDayBoundsUtc(seoulDay: string): {
  startIso: string;
  endIso: string;
} {
  // Asia/Seoul = UTC+9 (DST 없음)
  const startIso = `${seoulDay}T00:00:00+09:00`;
  const start = new Date(startIso);
  const end = new Date(start.getTime() + 86_400_000);
  return {
    startIso: start.toISOString(),
    endIso: end.toISOString(),
  };
}

export function formatSeoulDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: SEOUL,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

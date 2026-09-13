import type { AreaFilter, DealType, Transaction } from "@/types/transaction";

/** 전용면적(㎡) → 대략 평수 (1평 ≈ 3.3058㎡) */
export function toPyeong(sqm: number): number {
  return Math.round((sqm / 3.3058) * 10) / 10;
}

/** 정확한 전용면적 표기 — 84.97㎡ */
export function formatSqm(sqm: number): string {
  return `${Number(sqm).toFixed(2)}㎡`;
}

/** 사용자 보조 평 표기 — 26평 (정수 반올림). 공급 ‘평형’ 아님. */
export function formatPyeong(sqm: number): string {
  return `${Math.round(toPyeong(sqm))}평`;
}

/**
 * 전용면적 + 단순 평 환산 — 84.97㎡ (약 26평).
 * 공급면적 기준 ‘평형’이 아님. 별도 필드 추정 없음.
 */
export function formatSqmApproxPyeong(sqm: number): string {
  return `${formatSqm(sqm)} (약 ${Math.round(sqm / 3.3058)}평)`;
}

/** 전용 84.97㎡ */
export function formatExclusiveArea(sqm: number): string {
  return `전용 ${formatSqm(sqm)}`;
}

/** selector trigger — 26평 · 전용 84.97㎡ */
export function formatAreaTriggerLabel(sqm: number): string {
  return `${formatPyeong(sqm)} · ${formatExclusiveArea(sqm)}`;
}

/** 만원 단위 → 억 원 표기 (예: 85000 → 8.5억) */
export function formatEok(manwon: number): string {
  if (!Number.isFinite(manwon) || manwon <= 0) return "-";
  const eok = manwon / 10000;
  if (eok >= 1) {
    const rounded = Math.round(eok * 100) / 100;
    return `${rounded}억`;
  }
  return `${manwon.toLocaleString("ko-KR")}만`;
}

/** Compact KPI monthly-rent amount — 680만원, never 억+만원. */
export function formatKpiMonthlyRent(manwon: number): string {
  if (!Number.isFinite(manwon) || manwon <= 0) return "—";
  if (manwon >= 10000) return formatEok(manwon);
  return `${manwon.toLocaleString("ko-KR")}만원`;
}

/** 전월세 금액 표기 */
export function formatRentAmount(deposit: number, monthly: number): string {
  const depositLabel = formatEok(deposit);
  if (monthly > 0) {
    return `보 ${depositLabel} / 월 ${monthly.toLocaleString("ko-KR")}만`;
  }
  return `전세 ${depositLabel}`;
}

export function formatDealAmount(tx: Transaction): string {
  if (tx.dealType === "rent") {
    return formatRentAmount(tx.dealAmount, tx.monthlyRent);
  }
  return formatEok(tx.dealAmount);
}

export function formatDealDate(date: string): string {
  if (!date || date.length < 10) return date;
  return date.replaceAll("-", ".");
}

/** canonical — 전용 84.97㎡ (26평) */
export function formatArea(sqm: number): string {
  return `${formatExclusiveArea(sqm)} (${formatPyeong(sqm)})`;
}

export function matchesAreaFilter(sqm: number, area: AreaFilter): boolean {
  switch (area) {
    case "under-60":
      return sqm < 60;
    case "60-85":
      return sqm >= 60 && sqm < 85;
    case "85-102":
      return sqm >= 85 && sqm < 102;
    case "over-102":
      return sqm >= 102;
    default:
      return true;
  }
}

export function dealTypeLabel(type: DealType): string {
  return type === "trade" ? "매매" : "전월세";
}

/** YYYYMM 목록 생성 (최근 N개월, 최신 우선) */
export function recentYearMonths(count = 6): string[] {
  const result: string[] = [];
  const now = new Date();
  for (let i = 0; i < count; i += 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    result.push(`${y}${m}`);
  }
  return result;
}

export function yearMonthLabel(ym: string): string {
  if (ym.length !== 6) return ym;
  return `${ym.slice(0, 4)}.${ym.slice(4, 6)}`;
}

export function pad2(n: string | number): string {
  return String(n).trim().padStart(2, "0");
}

export function parseManwon(raw: string | number | undefined): number {
  if (raw === undefined || raw === null) return 0;
  const cleaned = String(raw).replaceAll(",", "").replaceAll(" ", "").trim();
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

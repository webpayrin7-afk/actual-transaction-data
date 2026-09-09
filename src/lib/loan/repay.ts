/**
 * 주택담보대출 상환 계산 (순수 함수, 원 단위).
 *
 * Rounding policy (원 단위 반올림, Math.round):
 * - 원리금균등: 표준 공식으로 월 납입액을 구한 뒤 원 단위로 반올림한다.
 *   마지막 달은 잔여 원금 + 해당 월 이자를 정산한다.
 * - 원금균등: 월 원금 = round(원금 / 개월수), 마지막 달은 잔여 원금.
 *   이자는 매월 (잔액 × 월이율)을 원 단위로 반올림한다.
 * - 총상환액 = 납입액 합계, 총이자 = 총상환액 − 원금.
 *
 * UI·API와 분리된 client-side 계산이다. DB / MOLIT / 외부 금리 API를 쓰지 않는다.
 */

export type RepaymentMethod = "equal_payment" | "equal_principal";

export const RATE_COMPARE_DELTA_PCT = 0.5;
export const MIN_RATE_PCT = 0;
export const MAX_RATE_PCT = 20;
export const MIN_YEARS = 1;
export const MAX_YEARS = 50;
/** 대출금액 상한 (만원) — 100억 */
export const MAX_PRINCIPAL_MAN = 1_000_000;

export function roundWon(n: number): number {
  return Math.round(n);
}

export function roundRatePct(n: number): number {
  return Math.round(n * 100) / 100;
}

export function monthsFromYears(years: number): number {
  return Math.round(years * 12);
}

export type RepaySummary = {
  method: RepaymentMethod;
  principalWon: number;
  annualRatePct: number;
  years: number;
  months: number;
  /** 원리금균등: 매월 동일 스케줄 금액. 원금균등: null */
  monthlyPaymentWon: number | null;
  firstMonthWon: number;
  lastMonthWon: number;
  firstYearPaymentWon: number;
  totalInterestWon: number;
  totalPaymentWon: number;
};

export type RateScenarioKind = "lower" | "base" | "higher";

export type RateScenario = {
  kind: RateScenarioKind;
  ratePct: number;
  label: string;
  summary: RepaySummary;
};

export type RateDelta = {
  monthlyDeltaWon: number | null;
  firstMonthDeltaWon: number;
  lastMonthDeltaWon: number;
  annualDeltaWon: number | null;
  firstYearDeltaWon: number;
  totalInterestDeltaWon: number;
  totalPaymentDeltaWon: number;
};

export type RateComparison = {
  baseRatePct: number;
  deltaPct: number;
  scenarios: RateScenario[];
  vsHigher: RateDelta | null;
  vsLower: RateDelta | null;
};

function monthlyRate(annualRatePct: number): number {
  return annualRatePct / 100 / 12;
}

/** 원리금균등 스케줄 월납입액 (원, 반올림). 마지막 달 정산 전 금액. */
export function scheduledEqualPaymentWon(
  principalWon: number,
  annualRatePct: number,
  months: number,
): number {
  if (principalWon <= 0 || months <= 0) return 0;
  const r = monthlyRate(annualRatePct);
  if (r === 0) return roundWon(principalWon / months);
  const factor = Math.pow(1 + r, months);
  return roundWon((principalWon * r * factor) / (factor - 1));
}

function simulate(
  principalWon: number,
  annualRatePct: number,
  years: number,
  method: RepaymentMethod,
): Omit<
  RepaySummary,
  "method" | "principalWon" | "annualRatePct" | "years" | "months"
> {
  const months = monthsFromYears(years);
  if (principalWon <= 0 || months <= 0) {
    return {
      monthlyPaymentWon: method === "equal_payment" ? 0 : null,
      firstMonthWon: 0,
      lastMonthWon: 0,
      firstYearPaymentWon: 0,
      totalInterestWon: 0,
      totalPaymentWon: 0,
    };
  }

  const r = monthlyRate(annualRatePct);
  const scheduled =
    method === "equal_payment"
      ? scheduledEqualPaymentWon(principalWon, annualRatePct, months)
      : roundWon(principalWon / months);

  let remaining = principalWon;
  let totalPayment = 0;
  let firstYearPayment = 0;
  let firstMonth = 0;
  let lastMonth = 0;

  for (let i = 0; i < months; i++) {
    const interest = roundWon(remaining * r);
    const isLast = i === months - 1;
    let principalPay: number;
    if (isLast) {
      principalPay = remaining;
    } else if (method === "equal_payment") {
      principalPay = Math.min(Math.max(0, scheduled - interest), remaining);
    } else {
      principalPay = Math.min(scheduled, remaining);
    }
    const payment = principalPay + interest;
    remaining -= principalPay;
    if (remaining < 0) remaining = 0;
    totalPayment += payment;
    if (i === 0) firstMonth = payment;
    if (isLast) lastMonth = payment;
    if (i < 12) firstYearPayment += payment;
  }

  return {
    monthlyPaymentWon: method === "equal_payment" ? scheduled : null,
    firstMonthWon: firstMonth,
    lastMonthWon: lastMonth,
    firstYearPaymentWon: firstYearPayment,
    totalInterestWon: totalPayment - principalWon,
    totalPaymentWon: totalPayment,
  };
}

export function summarizeRepayment(
  principalWon: number,
  annualRatePct: number,
  years: number,
  method: RepaymentMethod,
): RepaySummary {
  const months = monthsFromYears(years);
  return {
    method,
    principalWon,
    annualRatePct,
    years,
    months,
    ...simulate(principalWon, annualRatePct, years, method),
  };
}

function deltaBetween(base: RepaySummary, other: RepaySummary): RateDelta {
  const monthlyDeltaWon =
    base.monthlyPaymentWon != null && other.monthlyPaymentWon != null
      ? other.monthlyPaymentWon - base.monthlyPaymentWon
      : null;
  return {
    monthlyDeltaWon,
    firstMonthDeltaWon: other.firstMonthWon - base.firstMonthWon,
    lastMonthDeltaWon: other.lastMonthWon - base.lastMonthWon,
    annualDeltaWon: monthlyDeltaWon != null ? monthlyDeltaWon * 12 : null,
    firstYearDeltaWon: other.firstYearPaymentWon - base.firstYearPaymentWon,
    totalInterestDeltaWon: other.totalInterestWon - base.totalInterestWon,
    totalPaymentDeltaWon: other.totalPaymentWon - base.totalPaymentWon,
  };
}

function scenarioLabel(kind: RateScenarioKind, ratePct: number, baseRatePct: number): string {
  if (kind === "base") return "현재";
  const diff = roundRatePct(Math.abs(ratePct - baseRatePct));
  const formatted = Number.isInteger(diff) ? String(diff) : diff.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return kind === "lower" ? `-${formatted}%p` : `+${formatted}%p`;
}

export function compareRateScenarios(
  principalWon: number,
  years: number,
  method: RepaymentMethod,
  baseRatePct: number,
  deltaPct: number = RATE_COMPARE_DELTA_PCT,
): RateComparison {
  const base = roundRatePct(baseRatePct);
  const lower = roundRatePct(Math.max(0, base - deltaPct));
  const higher = roundRatePct(base + deltaPct);

  const raw: Array<{ kind: RateScenarioKind; ratePct: number }> = [
    ...(lower < base ? [{ kind: "lower" as const, ratePct: lower }] : []),
    { kind: "base", ratePct: base },
    ...(higher > base ? [{ kind: "higher" as const, ratePct: higher }] : []),
  ];

  const scenarios: RateScenario[] = raw.map((item) => ({
    kind: item.kind,
    ratePct: item.ratePct,
    label: scenarioLabel(item.kind, item.ratePct, base),
    summary: summarizeRepayment(principalWon, item.ratePct, years, method),
  }));

  const baseSummary = scenarios.find((s) => s.kind === "base")?.summary ?? null;
  const higherSummary = scenarios.find((s) => s.kind === "higher")?.summary ?? null;
  const lowerSummary = scenarios.find((s) => s.kind === "lower")?.summary ?? null;

  return {
    baseRatePct: base,
    deltaPct,
    scenarios,
    vsHigher:
      baseSummary && higherSummary ? deltaBetween(baseSummary, higherSummary) : null,
    vsLower:
      baseSummary && lowerSummary ? deltaBetween(baseSummary, lowerSummary) : null,
  };
}

export function formatWon(won: number): string {
  return `${roundWon(won).toLocaleString("ko-KR")}원`;
}

export function formatSignedWon(won: number): string {
  const rounded = roundWon(won);
  const body = `${Math.abs(rounded).toLocaleString("ko-KR")}원`;
  if (rounded > 0) return `+${body}`;
  if (rounded < 0) return `-${body}`;
  return "0원";
}

/** 만원 → "3억" / "3억 2,000만" / "8,000만" */
export function formatManHuman(man: number): string {
  if (!Number.isFinite(man) || man <= 0) return "";
  const whole = Math.round(man);
  const eok = Math.floor(whole / 10_000);
  const rest = whole % 10_000;
  if (eok > 0 && rest > 0) {
    return `${eok.toLocaleString("ko-KR")}억 ${rest.toLocaleString("ko-KR")}만`;
  }
  if (eok > 0) return `${eok.toLocaleString("ko-KR")}억`;
  return `${whole.toLocaleString("ko-KR")}만`;
}

export function parseManInput(raw: string): number | null {
  const digits = String(raw).replace(/\D/g, "");
  if (!digits) return null;
  const n = Number(digits);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(n, MAX_PRINCIPAL_MAN);
}

export function parseRateInput(raw: string): number | null {
  const trimmed = String(raw).replaceAll(",", "").trim();
  if (trimmed === "" || trimmed === ".") return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;
  if (n < MIN_RATE_PCT || n > MAX_RATE_PCT) return null;
  return n;
}

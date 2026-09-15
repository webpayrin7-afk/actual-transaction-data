import {
  calculateLoanLimit,
  monthlyPaymentWon,
  type LoanCalcBreakdown,
  type LoanCalcInput,
  type HomeCount,
  type MetroType,
  type RegType,
  type LimitConstraintKey,
} from "@/lib/loan/calc";
import type { MoneyMan, RuleMeta } from "@/lib/calculator/rules/types";

/** Loan estimate wrapper — reuses existing LTV/DSR engine; not a bank approval. */
export const LOAN_ESTIMATE_RULE: RuleMeta = {
  ruleVersion: "loan-estimate.v2024.1",
  effectiveFrom: "2024-01-01",
  source:
    "기존 ZIPLAB 주담대 한도 엔진(LTV·DSR·DTI) 및 금융위·은행권 규제 안내 요약. 승인 보장 아님.",
  title: "주택담보대출 추정",
};

export type LoanEstimateInput = {
  priceMan: MoneyMan;
  cashMan: MoneyMan;
  annualIncomeMan: MoneyMan;
  existingMonthlyMan: MoneyMan;
  otherAnnualInterestMan?: MoneyMan;
  years: number;
  baseRatePct: number;
  metro: MetroType;
  regulated: RegType;
  homes: HomeCount;
  firstHome: boolean;
  disposeCondition: boolean;
  repayMethod: "equal_payment" | "equal_principal";
};

export type LoanEstimateResult = {
  meta: RuleMeta;
  breakdown: LoanCalcBreakdown;
  /** 집값 기준 필요 대출 = max(매수가 − 자기자금, 0) */
  requiredLoanMan: number;
  /** DSR 계산 가능 여부 (연소득 > 0) */
  dsrAvailable: boolean;
  /**
   * 최대 대출 가능액.
   * dsrAvailable=false 이면 LTV(+DTI/절대한도)만으로 잠정 산출.
   */
  maxLoanMan: number;
  /** 잠정 한도인지 (DSR 미입력 등) */
  maxLoanProvisional: boolean;
  /** 예상 실행 대출 = min(필요 대출, 최대 한도). 잠정이면 잠정 실행액. */
  expectedLoanMan: number;
  /** @deprecated use requiredLoanMan — kept for older call sites */
  fundingGapMan: number;
  /** @deprecated use expectedLoanMan */
  estimatedLoanMan: number;
  /** 매수가 − 예상 실행 대출 (부대비용 제외) */
  requiredCashMan: number;
  monthlyPaymentMan: number;
  limitingLabels: string[];
  repayMethodLabel: string;
  disclaimer: string;
};

function constraintLabel(key: LimitConstraintKey): string {
  if (key === "ltv") return "LTV";
  if (key === "dsr") return "DSR";
  if (key === "dti") return "DTI";
  return "시가 절대한도";
}

function monthlyForPrincipal(
  principalMan: number,
  ratePct: number,
  years: number,
  repayMethod: LoanEstimateInput["repayMethod"],
): number {
  if (principalMan <= 0 || years <= 0) return 0;
  if (repayMethod === "equal_principal") {
    const principalWon = principalMan * 10_000;
    const n = years * 12;
    const monthlyPrincipal = principalWon / n;
    const firstInterest = (principalWon * (ratePct / 100)) / 12;
    return Math.round(((monthlyPrincipal + firstInterest) / 10_000) * 100) / 100;
  }
  const won = monthlyPaymentWon(principalMan * 10_000, ratePct, years);
  return Math.round((won / 10_000) * 100) / 100;
}

/**
 * Resolve max loan from engine, excluding DSR when income is missing
 * so DSR never appears as a 0원 “limit” that falsely becomes the binding constraint.
 */
function resolveMaxLoan(
  breakdown: LoanCalcBreakdown,
  dsrAvailable: boolean,
): {
  maxLoanMan: number;
  provisional: boolean;
  limitingLabels: string[];
} {
  if (breakdown.blocked) {
    return { maxLoanMan: 0, provisional: false, limitingLabels: [] };
  }

  if (dsrAvailable) {
    return {
      maxLoanMan: breakdown.finalLimitMan,
      provisional: false,
      limitingLabels: breakdown.limitingConstraints.map(constraintLabel),
    };
  }

  // Income missing → DSR not a valid candidate (engine would treat it as 0).
  const parts: { key: LimitConstraintKey; value: number }[] = [
    { key: "ltv", value: Math.floor(breakdown.ltvLimitMan) },
  ];
  if (breakdown.dtiApplied) {
    parts.push({ key: "dti", value: Math.floor(breakdown.dtiLimitMan) });
  }
  if (breakdown.absoluteCapMan != null) {
    parts.push({
      key: "absolute_cap",
      value: Math.floor(breakdown.absoluteCapMan),
    });
  }
  const maxLoanMan = Math.max(0, Math.floor(Math.min(...parts.map((p) => p.value))));
  return {
    maxLoanMan,
    provisional: true,
    limitingLabels: parts
      .filter((p) => p.value === maxLoanMan)
      .map((p) => constraintLabel(p.key)),
  };
}

export function calculateLoanEstimate(
  input: LoanEstimateInput,
): LoanEstimateResult {
  const loanInput: LoanCalcInput = {
    metro: input.metro,
    regulated: input.regulated,
    homes: input.homes,
    firstHome: input.firstHome,
    disposeCondition: input.disposeCondition,
    collateralMan: input.priceMan,
    annualIncomeMan: input.annualIncomeMan,
    existingMonthlyMan: input.existingMonthlyMan,
    otherAnnualInterestMan: input.otherAnnualInterestMan ?? 0,
    years: input.years,
    baseRatePct: input.baseRatePct,
  };
  const breakdown = calculateLoanLimit(loanInput);
  const dsrAvailable = input.annualIncomeMan > 0;
  const { maxLoanMan, provisional, limitingLabels } = resolveMaxLoan(
    breakdown,
    dsrAvailable,
  );

  const requiredLoanMan = Math.max(0, input.priceMan - input.cashMan);
  const expectedLoanMan = Math.min(maxLoanMan, requiredLoanMan);
  const requiredCashMan = Math.max(0, input.priceMan - expectedLoanMan);
  const monthlyPaymentMan = monthlyForPrincipal(
    expectedLoanMan,
    input.baseRatePct,
    breakdown.effectiveYears || input.years,
    input.repayMethod,
  );

  return {
    meta: LOAN_ESTIMATE_RULE,
    breakdown,
    requiredLoanMan,
    dsrAvailable,
    maxLoanMan,
    maxLoanProvisional: provisional,
    expectedLoanMan,
    fundingGapMan: requiredLoanMan,
    estimatedLoanMan: expectedLoanMan,
    requiredCashMan,
    monthlyPaymentMan,
    limitingLabels,
    repayMethodLabel:
      input.repayMethod === "equal_principal" ? "원금균등" : "원리금균등",
    disclaimer:
      "은행 심사를 대체하지 않으며, 승인·금리·한도를 보장하지 않는 추정치입니다.",
  };
}

import {
  calculateLoanLimit,
  monthlyPaymentWon,
  type LoanCalcBreakdown,
  type LoanCalcInput,
  type HomeCount,
  type MetroType,
  type RegType,
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
  maxLoanMan: number;
  fundingGapMan: number;
  estimatedLoanMan: number;
  requiredCashMan: number;
  monthlyPaymentMan: number;
  limitingLabels: string[];
  disclaimer: string;
};

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
  const fundingGapMan = Math.max(0, input.priceMan - input.cashMan);
  const maxLoanMan = breakdown.blocked ? 0 : breakdown.finalLimitMan;
  const estimatedLoanMan = Math.min(maxLoanMan, fundingGapMan);
  const requiredCashMan = Math.max(0, input.priceMan - estimatedLoanMan);

  let monthlyPaymentMan = 0;
  if (estimatedLoanMan > 0 && input.years > 0) {
    if (input.repayMethod === "equal_principal") {
      const principalWon = estimatedLoanMan * 10_000;
      const n = input.years * 12;
      const monthlyPrincipal = principalWon / n;
      const firstInterest = (principalWon * (input.baseRatePct / 100)) / 12;
      monthlyPaymentMan =
        Math.round(((monthlyPrincipal + firstInterest) / 10_000) * 100) / 100;
    } else {
      const won = monthlyPaymentWon(
        estimatedLoanMan * 10_000,
        input.baseRatePct,
        input.years,
      );
      monthlyPaymentMan = Math.round((won / 10_000) * 100) / 100;
    }
  }

  return {
    meta: LOAN_ESTIMATE_RULE,
    breakdown,
    maxLoanMan,
    fundingGapMan,
    estimatedLoanMan,
    requiredCashMan,
    monthlyPaymentMan,
    limitingLabels: breakdown.limitingConstraints.map((k) => {
      if (k === "ltv") return "LTV";
      if (k === "dsr") return "DSR";
      if (k === "dti") return "DTI";
      return "시가 절대한도";
    }),
    disclaimer:
      "은행 심사를 대체하지 않으며, 승인·금리·한도를 보장하지 않는 추정치입니다.",
  };
}

import type { MoneyMan, RuleMeta } from "@/lib/calculator/rules/types";

/** 종합부동산세(주택분) — 개략. 세율·공제는 2024년 개정 취지 반영. */
export const COMPREHENSIVE_TAX_RULE: RuleMeta = {
  ruleVersion: "comprehensive-ret.v2024.1",
  effectiveFrom: "2024-01-01",
  source:
    "종합부동산세법(2024년 주택분 기본공제·세율 개정 취지). 공정시장가액비율 60%. 세액공제·상한·특례 미반영 개략치.",
  title: "종합부동산세(주택분)",
};

export type ComprehensiveTaxInput = {
  officialPriceMan: MoneyMan;
  /** 1세대 1주택이면 12억 공제, 아니면 9억 */
  singleHomeHousehold: boolean;
};

export type ComprehensiveTaxResult = {
  meta: RuleMeta;
  officialPriceMan: MoneyMan;
  deductionMan: number;
  taxBaseMan: number;
  taxMan: number;
  taxable: boolean;
  notes: string[];
};

/** 일반 누진(2주택 이하) 세율 — 과세표준 원 기준 */
function generalRateTaxWon(taxBaseWon: number): number {
  const brackets: { limit: number; rate: number; progressive: number }[] = [
    { limit: 300_000_000, rate: 0.005, progressive: 0 },
    { limit: 600_000_000, rate: 0.007, progressive: 1_500_000 },
    { limit: 1_200_000_000, rate: 0.01, progressive: 3_600_000 },
    { limit: 2_500_000_000, rate: 0.013, progressive: 9_600_000 },
    { limit: 5_000_000_000, rate: 0.015, progressive: 26_500_000 },
    { limit: Infinity, rate: 0.027, progressive: 64_000_000 },
  ];
  let prev = 0;
  for (const b of brackets) {
    if (taxBaseWon <= b.limit) {
      return b.progressive + (taxBaseWon - prev) * b.rate;
    }
    prev = b.limit === Infinity ? prev : b.limit;
  }
  return 0;
}

export function calculateComprehensiveRealEstateTax(
  input: ComprehensiveTaxInput,
): ComprehensiveTaxResult {
  const notes: string[] = [
    "세액공제(연령·보유기간)·세부담상한·특례는 반영하지 않습니다.",
    "다주택 중과세율은 v1에서 일반세율로 단순화했습니다.",
  ];
  const officialWon = Math.max(0, input.officialPriceMan) * 10_000;
  const fairWon = officialWon * 0.6;
  const deductionWon = input.singleHomeHousehold
    ? 1_200_000_000
    : 900_000_000;
  const taxBaseWon = Math.max(0, fairWon - deductionWon);
  const taxable = taxBaseWon > 0;
  const taxWon = taxable ? generalRateTaxWon(taxBaseWon) : 0;
  const toMan = (won: number) => Math.round(won) / 10_000;

  if (!taxable) {
    notes.push(
      input.singleHomeHousehold
        ? "1세대1주택 기본공제(12억) 이하로 종부세 과세대상이 아닙니다."
        : "기본공제(9억) 이하로 종부세 과세대상이 아닙니다.",
    );
  }

  return {
    meta: COMPREHENSIVE_TAX_RULE,
    officialPriceMan: input.officialPriceMan,
    deductionMan: toMan(deductionWon),
    taxBaseMan: toMan(taxBaseWon),
    taxMan: toMan(taxWon),
    taxable,
    notes,
  };
}

import type { MoneyMan, RuleMeta } from "@/lib/calculator/rules/types";

/** 종합부동산세(주택분) — 종합부동산세법·시행령 현행. */
export const COMPREHENSIVE_TAX_RULE: RuleMeta = {
  ruleVersion: "comprehensive-ret.v2026.1",
  effectiveFrom: "2026-01-01",
  source:
    "종합부동산세법 제8조(과세표준: (공시가격합계−기본공제)×공정시장가액비율), 같은 법 시행령(공정시장가액비율 60%), 국세청 주택분 세율. 1세대1주택 공제 12억·그 외 개인 9억. 연령·장기보유 세액공제·재산세액 공제·세부담상한·공동명의 특례·3주택 중과세율 미반영 → 예상세액.",
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
  fairMarketRatio: number;
  taxBaseMan: number;
  taxMan: number;
  taxable: boolean;
  /** Applied marginal rate for the current tax base (0 when not taxable). */
  appliedRate: number | null;
  /** Human label for the applied bracket, e.g. "3억원 이하". */
  appliedBracketLabel: string | null;
  notes: string[];
};

/** 공정시장가액비율 — 종합부동산세법 시행령 현행 60%. */
export const COMPREHENSIVE_FAIR_MARKET_RATIO = 0.6;

type RateBracket = {
  limit: number;
  rate: number;
  progressive: number;
  label: string;
};

/** 일반(2주택 이하) 누진 세율표 — UI 참고용(계산식 변경 없음). */
export const COMPREHENSIVE_GENERAL_RATE_BRACKETS: RateBracket[] = [
  { limit: 300_000_000, rate: 0.005, progressive: 0, label: "3억원 이하" },
  {
    limit: 600_000_000,
    rate: 0.007,
    progressive: 1_500_000,
    label: "3억 초과~6억원 이하",
  },
  {
    limit: 1_200_000_000,
    rate: 0.01,
    progressive: 3_600_000,
    label: "6억 초과~12억원 이하",
  },
  {
    limit: 2_500_000_000,
    rate: 0.013,
    progressive: 9_600_000,
    label: "12억 초과~25억원 이하",
  },
  {
    limit: 5_000_000_000,
    rate: 0.015,
    progressive: 26_500_000,
    label: "25억 초과~50억원 이하",
  },
  {
    limit: 9_400_000_000,
    rate: 0.02,
    progressive: 64_000_000,
    label: "50억 초과~94억원 이하",
  },
  {
    limit: Infinity,
    rate: 0.027,
    progressive: 152_000_000,
    label: "94억원 초과",
  },
];

/**
 * 일반(2주택 이하) 누진 세율 — 국세청 주택분.
 * 과세표준 = (공시가격 − 공제) × 60% 이후 적용.
 * Formula unchanged; also returns the applied bracket for UI disclosure.
 */
function generalRateTaxWon(taxBaseWon: number): {
  taxWon: number;
  appliedRate: number;
  appliedBracketLabel: string;
} {
  let prev = 0;
  for (const b of COMPREHENSIVE_GENERAL_RATE_BRACKETS) {
    if (taxBaseWon <= b.limit) {
      return {
        taxWon: b.progressive + (taxBaseWon - prev) * b.rate,
        appliedRate: b.rate,
        appliedBracketLabel: b.label,
      };
    }
    prev = b.limit === Infinity ? prev : b.limit;
  }
  const last =
    COMPREHENSIVE_GENERAL_RATE_BRACKETS[
      COMPREHENSIVE_GENERAL_RATE_BRACKETS.length - 1
    ]!;
  return {
    taxWon: 0,
    appliedRate: last.rate,
    appliedBracketLabel: last.label,
  };
}

export function calculateComprehensiveRealEstateTax(
  input: ComprehensiveTaxInput,
): ComprehensiveTaxResult {
  const notes: string[] = [
    "미반영: 연령·장기보유 세액공제, 재산세액 공제, 세부담상한, 공동명의 특례, 3주택 이상 중과세율 — 확정 납부세액이 아닌 예상세액입니다.",
    "법인·합산배제 등은 v1 범위 밖입니다.",
  ];
  const officialWon = Math.max(0, input.officialPriceMan) * 10_000;
  const deductionWon = input.singleHomeHousehold
    ? 1_200_000_000
    : 900_000_000;
  // 종합부동산세법 제8조: (공시가격 합계 − 기본공제) × 공정시장가액비율
  const fairMarketRatio = COMPREHENSIVE_FAIR_MARKET_RATIO;
  const taxBaseWon = Math.max(0, officialWon - deductionWon) * fairMarketRatio;
  const taxable = taxBaseWon > 0;
  const rated = taxable ? generalRateTaxWon(taxBaseWon) : null;
  const toMan = (won: number) => Math.round(won) / 10_000;

  if (!taxable) {
    notes.push(
      input.singleHomeHousehold
        ? "1세대1주택 기본공제(12억) 이하로 종부세 과세대상이 아닙니다."
        : "기본공제(9억) 이하로 종부세 과세대상이 아닙니다.",
    );
  } else {
    notes.push(
      `과세표준 = (공시가격 − ${input.singleHomeHousehold ? "12억" : "9억"} 공제) × ${(fairMarketRatio * 100).toFixed(0)}%.`,
    );
  }

  return {
    meta: COMPREHENSIVE_TAX_RULE,
    officialPriceMan: input.officialPriceMan,
    deductionMan: toMan(deductionWon),
    fairMarketRatio,
    taxBaseMan: toMan(taxBaseWon),
    taxMan: toMan(rated?.taxWon ?? 0),
    taxable,
    appliedRate: rated?.appliedRate ?? null,
    appliedBracketLabel: rated?.appliedBracketLabel ?? null,
    notes,
  };
}

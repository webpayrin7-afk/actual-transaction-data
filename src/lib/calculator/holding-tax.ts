import {
  calculateComprehensiveRealEstateTax,
  type ComprehensiveTaxResult,
} from "@/lib/calculator/rules/comprehensive-tax";
import {
  calculatePropertyTax,
  type PropertyTaxResult,
} from "@/lib/calculator/rules/property-tax";
import type { MoneyMan } from "@/lib/calculator/rules/types";

export type HoldingTaxInput = {
  /** 공시가격 (만원). 공식 미확보 시 사용자 직접 입력만 허용. */
  officialPriceMan: MoneyMan;
  singleHomeHousehold: boolean;
  includeUrbanShare?: boolean;
  /** 0 = 당해만. >0 이면 가정 상승률로 앞 연도 투영 */
  projectionYears?: number;
  /** 공시가격 연 상승률, 예: 0.03 = 3% */
  officialPriceGrowthRate?: number;
};

export type HoldingTaxYearResult = {
  yearOffset: number;
  officialPriceMan: MoneyMan;
  property: PropertyTaxResult;
  comprehensive: ComprehensiveTaxResult;
  totalMan: number;
};

export type HoldingTaxResult = {
  years: HoldingTaxYearResult[];
  projectionDisclaimer: string | null;
  /** 보유세 v1 공통 고지 */
  estimateDisclaimer: string;
};

export function calculateHoldingTax(input: HoldingTaxInput): HoldingTaxResult {
  const years = Math.max(0, Math.floor(input.projectionYears ?? 0));
  const growth = input.officialPriceGrowthRate ?? 0;
  const out: HoldingTaxYearResult[] = [];

  for (let y = 0; y <= years; y += 1) {
    const officialPriceMan =
      y === 0
        ? input.officialPriceMan
        : input.officialPriceMan * Math.pow(1 + growth, y);
    const property = calculatePropertyTax({
      officialPriceMan,
      singleHomeHousehold: input.singleHomeHousehold,
      includeUrbanShare: input.includeUrbanShare,
    });
    const comprehensive = calculateComprehensiveRealEstateTax({
      officialPriceMan,
      singleHomeHousehold: input.singleHomeHousehold,
    });
    out.push({
      yearOffset: y,
      officialPriceMan,
      property,
      comprehensive,
      totalMan: property.totalMan + comprehensive.taxMan,
    });
  }

  const projectionDisclaimer =
    years > 0
      ? `공시가격 연 ${(growth * 100).toFixed(1)}% 상승 및 현행 제도 유지 가정`
      : null;

  return {
    years: out,
    projectionDisclaimer,
    estimateDisclaimer:
      "보유세는 예상세액입니다. 세부담상한·세액공제·특례세율·감면은 미반영입니다.",
  };
}

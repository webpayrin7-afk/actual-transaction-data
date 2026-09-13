import type { MoneyMan, RuleMeta } from "@/lib/calculator/rules/types";

/** 재산세(주택) — 지방세법. 공정시장가액비율 60%. */
export const PROPERTY_TAX_RULE: RuleMeta = {
  ruleVersion: "property-tax.v2024.1",
  effectiveFrom: "2024-01-01",
  source:
    "지방세법 제111조·주택분 재산세율, 공정시장가액비율(주택 60%). 도시지역분(0.14%) 선택 반영. 세부담 상한·감면 미반영.",
  title: "재산세(주택)",
};

export type PropertyTaxInput = {
  /** 공시가격 (만원) — 공식 공시가 또는 사용자 직접 입력 */
  officialPriceMan: MoneyMan;
  /** 도시지역분 포함 여부 */
  includeUrbanShare?: boolean;
};

export type PropertyTaxResult = {
  meta: RuleMeta;
  officialPriceMan: MoneyMan;
  taxBaseMan: number;
  propertyTaxMan: number;
  urbanShareMan: number;
  localEducationTaxMan: number;
  totalMan: number;
  notes: string[];
};

function progressiveHousingPropertyTaxWon(taxBaseWon: number): number {
  // 과세표준 구간 (원)
  if (taxBaseWon <= 60_000_000) return taxBaseWon * 0.001;
  if (taxBaseWon <= 150_000_000) {
    return 60_000 + (taxBaseWon - 60_000_000) * 0.0015;
  }
  if (taxBaseWon <= 300_000_000) {
    return 195_000 + (taxBaseWon - 150_000_000) * 0.0025;
  }
  return 570_000 + (taxBaseWon - 300_000_000) * 0.004;
}

export function calculatePropertyTax(input: PropertyTaxInput): PropertyTaxResult {
  const notes: string[] = [
    "공시가격은 공식 자료 또는 직접 입력값만 사용합니다. 실거래가 비율 추정은 하지 않습니다.",
    "세부담 상한·감면·주택 공제는 반영하지 않은 개략치입니다.",
  ];
  const officialWon = Math.max(0, input.officialPriceMan) * 10_000;
  const taxBaseWon = officialWon * 0.6;
  const propertyTaxWon = progressiveHousingPropertyTaxWon(taxBaseWon);
  const urbanShareWon =
    input.includeUrbanShare === false ? 0 : taxBaseWon * 0.0014;
  if (input.includeUrbanShare !== false) {
    notes.push("도시지역분(과세표준×0.14%)을 포함했습니다.");
  }
  const localEducationTaxWon = propertyTaxWon * 0.2;

  const toMan = (won: number) => Math.round(won) / 10_000;

  return {
    meta: PROPERTY_TAX_RULE,
    officialPriceMan: input.officialPriceMan,
    taxBaseMan: toMan(taxBaseWon),
    propertyTaxMan: toMan(propertyTaxWon),
    urbanShareMan: toMan(urbanShareWon),
    localEducationTaxMan: toMan(localEducationTaxWon),
    totalMan: toMan(propertyTaxWon + urbanShareWon + localEducationTaxWon),
    notes,
  };
}

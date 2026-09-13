import type { MoneyMan, RuleMeta } from "@/lib/calculator/rules/types";

/** 재산세(주택) — 지방세법·시행령 2026. */
export const PROPERTY_TAX_RULE: RuleMeta = {
  ruleVersion: "property-tax.v2026.1",
  effectiveFrom: "2026-01-01",
  source:
    "지방세법 제110조·제111조(주택분 재산세율), 지방세법 시행령 제109조(2026년 1세대1주택 공정시장가액비율 43·44·45%, 그 외 주택 60%). 도시지역분 0.14% 선택 반영. 세부담상한·1주택 특례세율·감면 미반영 → 예상세액.",
  title: "재산세(주택)",
};

export type PropertyTaxInput = {
  /** 공시가격 (만원) — 공식 공시가 또는 사용자 직접 입력 */
  officialPriceMan: MoneyMan;
  /** 1세대 1주택 여부(공정시장가액비율 특례) */
  singleHomeHousehold?: boolean;
  /** 도시지역분 포함 여부 */
  includeUrbanShare?: boolean;
};

export type PropertyTaxResult = {
  meta: RuleMeta;
  officialPriceMan: MoneyMan;
  fairMarketRatio: number;
  taxBaseMan: number;
  propertyTaxMan: number;
  urbanShareMan: number;
  localEducationTaxMan: number;
  totalMan: number;
  notes: string[];
};

/**
 * 지방세법 시행령 제109조 — 2026년 납세의무 성립분.
 * 1세대1주택: 3억 이하 43%, 3억 초과~6억 이하 44%, 6억 초과 45%.
 * 그 외 주택: 60%.
 */
export function fairMarketRatio2026(
  officialPriceMan: MoneyMan,
  singleHomeHousehold: boolean,
): number {
  if (!singleHomeHousehold) return 0.6;
  const won = Math.max(0, officialPriceMan) * 10_000;
  if (won <= 300_000_000) return 0.43;
  if (won <= 600_000_000) return 0.44;
  return 0.45;
}

function progressiveHousingPropertyTaxWon(taxBaseWon: number): number {
  // 지방세법 주택분 표준세율 (과세표준 원)
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
  const single = input.singleHomeHousehold === true;
  const notes: string[] = [
    "공시가격은 공식 자료 또는 직접 입력값만 사용합니다. 실거래가 비율 추정은 하지 않습니다.",
    "미반영: 세부담상한, 1세대1주택 특례세율(지방세법 제111조의2), 감면·공제 — 확정 고지세액이 아닌 예상세액입니다.",
  ];
  const officialWon = Math.max(0, input.officialPriceMan) * 10_000;
  const fairMarketRatio = fairMarketRatio2026(input.officialPriceMan, single);
  const taxBaseWon = officialWon * fairMarketRatio;
  const propertyTaxWon = progressiveHousingPropertyTaxWon(taxBaseWon);
  const urbanShareWon =
    input.includeUrbanShare === false ? 0 : taxBaseWon * 0.0014;
  if (input.includeUrbanShare !== false) {
    notes.push("도시지역분(과세표준×0.14%)을 포함했습니다.");
  }
  if (single) {
    notes.push(
      `2026년 1세대1주택 공정시장가액비율 ${(fairMarketRatio * 100).toFixed(0)}% 적용.`,
    );
  } else {
    notes.push("일반 주택 공정시장가액비율 60% 적용.");
  }
  const localEducationTaxWon = propertyTaxWon * 0.2;

  const toMan = (won: number) => Math.round(won) / 10_000;

  return {
    meta: PROPERTY_TAX_RULE,
    officialPriceMan: input.officialPriceMan,
    fairMarketRatio,
    taxBaseMan: toMan(taxBaseWon),
    propertyTaxMan: toMan(propertyTaxWon),
    urbanShareMan: toMan(urbanShareWon),
    localEducationTaxMan: toMan(localEducationTaxWon),
    totalMan: toMan(propertyTaxWon + urbanShareWon + localEducationTaxWon),
    notes,
  };
}

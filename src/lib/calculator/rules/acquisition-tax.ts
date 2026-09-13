import type { MoneyMan, RuleMeta } from "@/lib/calculator/rules/types";

/** 취득세(주택·유상취득) — 지방세법 기준 요약 (1주택 일반 vs 중과). */
export const ACQUISITION_TAX_RULE: RuleMeta = {
  ruleVersion: "acquisition-tax.v2024.1",
  effectiveFrom: "2024-01-01",
  source:
    "지방세법 제11조·제111조 및 행정안전부 주택 취득세 안내(1주택 일반·다주택 중과 구분). 농어촌특별세·지방교육세 포함. 실무 감면·특례는 미반영.",
  title: "주택 취득세",
};

export type AcquisitionHomeStatus = "one_home" | "multi_heavy";

export type AcquisitionTaxInput = {
  /** 취득가액 (만원) */
  priceMan: MoneyMan;
  homeStatus: AcquisitionHomeStatus;
};

export type AcquisitionTaxResult = {
  meta: RuleMeta;
  priceMan: MoneyMan;
  /** 본세 (만원, 원 단위 반올림 후 만원 환산) */
  baseTaxMan: number;
  localEducationTaxMan: number;
  ruralSpecialTaxMan: number;
  totalTaxMan: number;
  appliedRateLabel: string;
  notes: string[];
};

function wonFromMan(man: MoneyMan): number {
  return Math.max(0, man) * 10_000;
}

function manFromWon(won: number): number {
  return Math.round(won) / 10_000;
}

/** 1주택 일반 취득세 본세 (원) */
function oneHomeBaseTaxWon(priceWon: number): { taxWon: number; label: string } {
  if (priceWon <= 600_000_000) {
    return { taxWon: priceWon * 0.01, label: "1% (6억 이하)" };
  }
  if (priceWon <= 900_000_000) {
    // 지방세법 누진: 취득가액 × 2/3 × 1% − 300만원
    const taxWon = priceWon * (2 / 3) * 0.01 - 3_000_000;
    return {
      taxWon: Math.max(taxWon, priceWon * 0.01),
      label: "누진 (6억 초과~9억 이하)",
    };
  }
  return { taxWon: priceWon * 0.03, label: "3% (9억 초과)" };
}

/** 다주택 중과(조정대상지역 가정) 본세 — 보수적 8%/12% 단순화 */
function multiHeavyBaseTaxWon(priceWon: number): { taxWon: number; label: string } {
  // 중과 본세는 사례별로 8%~12%. v1은 8% 고정 + 안내.
  return {
    taxWon: priceWon * 0.08,
    label: "중과 8% (조정대상·다주택 가정, 단순화)",
  };
}

/**
 * Estimate acquisition-related taxes for a housing purchase.
 * Does not apply special reductions (생애최초 감면 등).
 */
export function calculateAcquisitionTax(
  input: AcquisitionTaxInput,
): AcquisitionTaxResult {
  const notes: string[] = [
    "생애최초·일시적 2주택 등 감면·특례는 반영하지 않습니다.",
    "실제 고지세액은 지자체·물건 요건에 따라 달라질 수 있습니다.",
  ];
  const priceWon = wonFromMan(input.priceMan);
  const base =
    input.homeStatus === "multi_heavy"
      ? multiHeavyBaseTaxWon(priceWon)
      : oneHomeBaseTaxWon(priceWon);

  const baseTaxWon = Math.max(0, base.taxWon);
  // 지방교육세: 일반 주택 취득세의 10%, 중과는 20% 근사
  const eduRate = input.homeStatus === "multi_heavy" ? 0.2 : 0.1;
  const localEducationTaxWon = baseTaxWon * eduRate;
  // 농어촌특별세: 6억 이하 1주택 등 비과세 구간이 있으나 v1은
  // 1주택·6억 이하 0, 그 외 취득세의 20% 근사
  let ruralSpecialTaxWon = 0;
  if (input.homeStatus === "multi_heavy") {
    ruralSpecialTaxWon = baseTaxWon * 0.2;
    notes.push("다주택 중과 시 농어촌특별세를 취득세의 20%로 근사합니다.");
  } else if (priceWon > 600_000_000) {
    ruralSpecialTaxWon = baseTaxWon * 0.2;
    notes.push("6억 초과 1주택은 농어촌특별세(취득세×20%)를 근사 반영합니다.");
  } else {
    notes.push("6억 이하 1주택은 농어촌특별세 비과세 가정입니다.");
  }

  const totalWon = baseTaxWon + localEducationTaxWon + ruralSpecialTaxWon;

  return {
    meta: ACQUISITION_TAX_RULE,
    priceMan: input.priceMan,
    baseTaxMan: manFromWon(baseTaxWon),
    localEducationTaxMan: manFromWon(localEducationTaxWon),
    ruralSpecialTaxMan: manFromWon(ruralSpecialTaxWon),
    totalTaxMan: manFromWon(totalWon),
    appliedRateLabel: base.label,
    notes,
  };
}

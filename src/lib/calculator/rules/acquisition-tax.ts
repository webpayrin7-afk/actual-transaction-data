import type { MoneyMan, RuleMeta } from "@/lib/calculator/rules/types";

/** 취득세(주택·유상취득) — 지방세법·농어촌특별세법 2026 현행. */
export const ACQUISITION_TAX_RULE: RuleMeta = {
  ruleVersion: "acquisition-tax.v2026.1",
  effectiveFrom: "2026-01-01",
  source:
    "지방세법 제11조제1항제8호(주택 유상취득 세율)·제151조제1항제1호(지방교육세), 농어촌특별세법 제4조·제5조제1항제6호 및 같은 법 시행령(서민주택·국민주택규모 전용 85㎡ 이하 비과세). 생애최초·일시적2주택 감면 등 미반영.",
  title: "주택 취득세",
};

export type AcquisitionHomeStatus = "one_home" | "multi_heavy";

/** 전용면적 입력 — 범위가 85㎡를 걸치면 추정하지 않음. */
export type ExclusiveAreaInput =
  | { mode: "exact"; sqm: number }
  | { mode: "range"; minSqm: number; maxSqm: number }
  | { mode: "unknown" };

export type NationalHousingSizeClass =
  | "at_or_below_85"
  | "above_85"
  | "straddles_85"
  | "unknown";

export type RuralSpecialTaxStatus =
  | "exempt_national_housing"
  | "taxed"
  | "needs_exact_area"
  | "unknown_area";

export type AcquisitionTaxInput = {
  /** 취득가액 (만원) */
  priceMan: MoneyMan;
  homeStatus: AcquisitionHomeStatus;
  /** 전용면적(㎡). 농어촌특별세 국민주택규모 판정용. */
  exclusiveArea?: ExclusiveAreaInput;
};

export type AcquisitionTaxResult = {
  meta: RuleMeta;
  priceMan: MoneyMan;
  /** 적용 산출세율 (소수, 예: 0.03) */
  appliedRate: number;
  /** 본세 (만원, 원 단위 반올림 후 만원 환산) */
  baseTaxMan: number;
  localEducationTaxMan: number;
  ruralSpecialTaxMan: number;
  totalTaxMan: number;
  appliedRateLabel: string;
  nationalHousingSizeClass: NationalHousingSizeClass;
  ruralSpecialTaxStatus: RuralSpecialTaxStatus;
  /** 농특세·면적 판정이 불완전하면 false */
  ruralSpecialTaxResolved: boolean;
  notes: string[];
};

function wonFromMan(man: MoneyMan): number {
  return Math.max(0, man) * 10_000;
}

function manFromWon(won: number): number {
  return Math.round(won) / 10_000;
}

/** 국민주택규모: 주거전용면적 85㎡ 이하(수도권 공동주택 기준). */
export function classifyNationalHousingSize(
  area: ExclusiveAreaInput | undefined,
): NationalHousingSizeClass {
  if (!area || area.mode === "unknown") return "unknown";
  if (area.mode === "exact") {
    if (!Number.isFinite(area.sqm)) return "unknown";
    return area.sqm <= 85 ? "at_or_below_85" : "above_85";
  }
  if (!Number.isFinite(area.minSqm) || !Number.isFinite(area.maxSqm)) {
    return "unknown";
  }
  const min = Math.min(area.minSqm, area.maxSqm);
  const max = Math.max(area.minSqm, area.maxSqm);
  if (max <= 85) return "at_or_below_85";
  if (min > 85) return "above_85";
  return "straddles_85";
}

/**
 * 지방세법 제11조제1항제8호나목 산출세율.
 * (취득당시가액 × 2 / 3억원 − 3) × 1/100
 * 소수점 이하 다섯째자리에서 반올림하여 넷째자리까지.
 */
export function oneHomeProgressiveRate(priceWon: number): number {
  const raw = (priceWon / 300_000_000) * 2 - 3;
  const rate = raw / 100;
  return Math.round(rate * 10_000) / 10_000;
}

/** 1주택 일반 취득세 본세 (원) + 적용세율 */
function oneHomeBaseTaxWon(priceWon: number): {
  taxWon: number;
  rate: number;
  label: string;
} {
  if (priceWon <= 600_000_000) {
    return { taxWon: priceWon * 0.01, rate: 0.01, label: "1% (6억 이하)" };
  }
  if (priceWon <= 900_000_000) {
    const rate = oneHomeProgressiveRate(priceWon);
    return {
      taxWon: priceWon * rate,
      rate,
      label: `누진 ${(rate * 100).toFixed(2)}% (6억 초과~9억 이하)`,
    };
  }
  return { taxWon: priceWon * 0.03, rate: 0.03, label: "3% (9억 초과)" };
}

/** 다주택 중과(조정대상지역 가정) 본세 — v1 단순화 8% */
function multiHeavyBaseTaxWon(priceWon: number): {
  taxWon: number;
  rate: number;
  label: string;
} {
  return {
    taxWon: priceWon * 0.08,
    rate: 0.08,
    label: "중과 8% (조정대상·다주택 가정, 단순화)",
  };
}

/**
 * 지방세법 제151조제1항제1호 — 주택 유상취득(제11조제1항제8호):
 * (과세표준 × 해당 세율 × 50%) × 20% = 취득세 본세 × 10%.
 * 중과(제13조의2) v1: 과세표준 × 0.4% 근사(안내 포함).
 */
function localEducationTaxWon(
  priceWon: number,
  baseTaxWon: number,
  homeStatus: AcquisitionHomeStatus,
): number {
  if (homeStatus === "multi_heavy") {
    return priceWon * 0.004;
  }
  return baseTaxWon * 0.1;
}

/**
 * 농어촌특별세법 제5조제1항제6호:
 * 표준세율 2%로 산출한 취득세액 × 10% → 취득가액 × 0.2%.
 * 서민주택(국민주택규모 전용 85㎡ 이하)은 제4조 비과세.
 */
function ruralSpecialTaxForTaxableHousing(priceWon: number): number {
  return priceWon * 0.02 * 0.1;
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
  const localEduWon = localEducationTaxWon(
    priceWon,
    baseTaxWon,
    input.homeStatus,
  );
  if (input.homeStatus === "multi_heavy") {
    notes.push(
      "다주택 중과 지방교육세는 지방세법 제151조 중과 규정을 0.4%(과세표준)로 단순화했습니다.",
    );
  }

  const sizeClass = classifyNationalHousingSize(input.exclusiveArea);
  let ruralSpecialTaxWon = 0;
  let ruralSpecialTaxStatus: RuralSpecialTaxStatus = "unknown_area";
  let ruralSpecialTaxResolved = false;

  if (sizeClass === "at_or_below_85") {
    ruralSpecialTaxWon = 0;
    ruralSpecialTaxStatus = "exempt_national_housing";
    ruralSpecialTaxResolved = true;
    notes.push(
      "전용 85㎡ 이하(국민주택규모) 서민주택으로 농어촌특별세 비과세입니다.",
    );
  } else if (sizeClass === "above_85") {
    ruralSpecialTaxWon = ruralSpecialTaxForTaxableHousing(priceWon);
    ruralSpecialTaxStatus = "taxed";
    ruralSpecialTaxResolved = true;
    notes.push(
      "전용 85㎡ 초과: 농어촌특별세는 표준세율 2%×10%(취득가액의 0.2%)입니다.",
    );
    if (input.homeStatus === "multi_heavy") {
      notes.push(
        "다주택 중과 시 농특세 배율(지방세법 제15조 등)은 v1에서 미반영 — 일반 취득분(0.2%)만 반영합니다.",
      );
    }
  } else if (sizeClass === "straddles_85") {
    ruralSpecialTaxWon = 0;
    ruralSpecialTaxStatus = "needs_exact_area";
    ruralSpecialTaxResolved = false;
    notes.push(
      "전용면적 범위가 85㎡를 걸칩니다. 농어촌특별세 판정을 위해 정확한 전용면적 확인이 필요합니다(추정하지 않음).",
    );
  } else {
    ruralSpecialTaxWon = 0;
    ruralSpecialTaxStatus = "unknown_area";
    ruralSpecialTaxResolved = false;
    notes.push(
      "전용면적 정보가 없어 농어촌특별세를 확정하지 않았습니다(추정하지 않음).",
    );
  }

  const totalWon = baseTaxWon + localEduWon + ruralSpecialTaxWon;

  return {
    meta: ACQUISITION_TAX_RULE,
    priceMan: input.priceMan,
    appliedRate: base.rate,
    baseTaxMan: manFromWon(baseTaxWon),
    localEducationTaxMan: manFromWon(localEduWon),
    ruralSpecialTaxMan: manFromWon(ruralSpecialTaxWon),
    totalTaxMan: manFromWon(totalWon),
    appliedRateLabel: base.label,
    nationalHousingSizeClass: sizeClass,
    ruralSpecialTaxStatus,
    ruralSpecialTaxResolved,
    notes,
  };
}

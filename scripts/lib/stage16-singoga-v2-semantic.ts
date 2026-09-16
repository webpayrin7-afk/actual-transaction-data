/**
 * Stage16 SINGOGA_V2 semantic constants (frozen).
 * Does not change production runtime output.
 */
export const SINGOGA_V2_SEMANTIC =
  "해당 거래가 계약된 시점에, 그 계약일 이전의 최고 실거래가격을 엄격하게 돌파했는가";

export const CURRENT_ALL_TIME_HIGH_SEMANTIC =
  "현재 전체 history 기준 해당 areaKey 최고가격과 동일한가 (legacy all-time equality)";

export const SINGOGA_V2_POLICY = {
  version: "singoga_v2",
  groupRule: "similar_exclusive_area_v1",
  exactArea: "areaKey = Math.round(sqm*100)/100",
  priceBasis: "deal_amount total",
  strictBreak: "currentPrice > priorMax",
  priorDate: "deal_date < current deal_date",
  sameDay: "same-date peers share prior snapshot",
  noPrior: "priorMax NULL → singoga FALSE (NO_PRIOR_BASELINE)",
  groupExists: "primary = groupPriorMax break",
  groupMissing: "primary = exactPriorMax break (fallback)",
  exactOnly:
    "group exists && exact break && !group break → secondary 개별면적 신고가",
} as const;

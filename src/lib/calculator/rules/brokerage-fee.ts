import type { MoneyMan, RuleMeta } from "@/lib/calculator/rules/types";

/** 주택 매매 중개보수 상한 — 공인중개사법 시행규칙. */
export const BROKERAGE_FEE_RULE: RuleMeta = {
  ruleVersion: "brokerage-fee.v2021.10",
  effectiveFrom: "2021-10-19",
  source:
    "공인중개사법 시행규칙 별표 1(중개보수 요율·한도). 상한이며 당사자 협의로 낮출 수 있음. 부가가치세는 사업자 유형에 따라 별도일 수 있어 v1에서 자동 합산하지 않음.",
  title: "중개보수 상한(매매)",
};

/** UI 선택용 요율(%p). 0.05 = 0.05%. 법정 상한 이하만 사용. */
export const BROKERAGE_RATE_PCT_OPTIONS: readonly number[] = [
  0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7,
];

export type BrokerageFeeResult = {
  meta: RuleMeta;
  priceMan: MoneyMan;
  /** 적용 요율(%p). 예: 0.7 = 0.7% */
  ratePct: number;
  /** 법정 상한 요율(%p) */
  legalCapRatePct: number;
  feeMan: number;
  /** 법정 상한 절대액(저가 구간)에 걸린 경우 */
  capped: boolean;
  /** 사용자가 상한 미만 요율을 선택한 경우 */
  userSelected: boolean;
  notes: string[];
};

type Bracket = {
  maxManExclusive: number | null;
  rate: number;
  /** absolute max fee in 만원 (optional) */
  maxFeeMan?: number;
};

/** 매매 상한 요율 */
const SALE_BRACKETS: Bracket[] = [
  { maxManExclusive: 5_000, rate: 0.006, maxFeeMan: 25 },
  { maxManExclusive: 20_000, rate: 0.005 },
  { maxManExclusive: 90_000, rate: 0.004 },
  { maxManExclusive: 120_000, rate: 0.005 },
  { maxManExclusive: 150_000, rate: 0.006 },
  { maxManExclusive: null, rate: 0.007 },
];

function resolveLegalCap(priceMan: MoneyMan): {
  rate: number;
  maxFeeMan?: number;
} {
  const price = Math.max(0, priceMan);
  for (const b of SALE_BRACKETS) {
    if (b.maxManExclusive == null || price < b.maxManExclusive) {
      return { rate: b.rate, maxFeeMan: b.maxFeeMan };
    }
  }
  return { rate: 0.007 };
}

/** 선택 가능 요율(%p) — 법정 상한 이하만. */
export function brokerageRatePctOptionsForPrice(
  priceMan: MoneyMan,
): number[] {
  const { rate } = resolveLegalCap(priceMan);
  const capPct = Math.round(rate * 10000) / 100;
  return BROKERAGE_RATE_PCT_OPTIONS.filter((p) => p <= capPct + 1e-9);
}

/**
 * 중개보수 계산.
 * @param selectedRatePct 사용자가 고른 요율(%p). 생략·null이면 법정 상한.
 *   상한을 초과하면 상한으로 clamp.
 */
export function calculateBrokerageFeeCap(
  priceMan: MoneyMan,
  selectedRatePct?: number | null,
): BrokerageFeeResult {
  const price = Math.max(0, priceMan);
  const legal = resolveLegalCap(price);
  const legalCapRatePct = Math.round(legal.rate * 10000) / 100;

  let ratePct = legalCapRatePct;
  let userSelected = false;
  if (
    selectedRatePct != null &&
    Number.isFinite(selectedRatePct) &&
    selectedRatePct > 0
  ) {
    ratePct = Math.min(selectedRatePct, legalCapRatePct);
    userSelected = Math.abs(ratePct - legalCapRatePct) > 1e-9;
  }

  let feeMan = price * (ratePct / 100);
  let capped = false;
  if (legal.maxFeeMan != null && feeMan > legal.maxFeeMan) {
    feeMan = legal.maxFeeMan;
    capped = true;
  }

  const notes: string[] = [
    userSelected
      ? `적용 요율 ${ratePct.toFixed(2)}% (직접 선택, 법정 상한 ${legalCapRatePct.toFixed(2)}%).`
      : `적용 요율 ${ratePct.toFixed(2)}% · 법정 상한.`,
    "부가가치세는 사업자 유형 등에 따라 별도 발생할 수 있어 합산하지 않습니다.",
    "매도·매수 각자 부담이 일반적이며, 여기 결과는 매수인 1인 부담 기준입니다.",
  ];

  return {
    meta: BROKERAGE_FEE_RULE,
    priceMan: price,
    ratePct,
    legalCapRatePct,
    feeMan: Math.round(feeMan * 100) / 100,
    capped,
    userSelected,
    notes,
  };
}

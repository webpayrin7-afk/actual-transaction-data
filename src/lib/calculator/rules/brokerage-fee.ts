import type { MoneyMan, RuleMeta } from "@/lib/calculator/rules/types";

/** 주택 매매 중개보수 상한 — 공인중개사법 시행규칙. */
export const BROKERAGE_FEE_RULE: RuleMeta = {
  ruleVersion: "brokerage-fee.v2021.10",
  effectiveFrom: "2021-10-19",
  source:
    "공인중개사법 시행규칙 별표 1(중개보수 요율·한도). 상한이며 당사자 협의로 낮출 수 있음.",
  title: "중개보수 상한(매매)",
};

export type BrokerageFeeResult = {
  meta: RuleMeta;
  priceMan: MoneyMan;
  ratePct: number;
  feeMan: number;
  capped: boolean;
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

export function calculateBrokerageFeeCap(priceMan: MoneyMan): BrokerageFeeResult {
  const price = Math.max(0, priceMan);
  let rate = 0.007;
  let maxFeeMan: number | undefined;
  for (const b of SALE_BRACKETS) {
    if (b.maxManExclusive == null || price < b.maxManExclusive) {
      rate = b.rate;
      maxFeeMan = b.maxFeeMan;
      break;
    }
  }
  let feeMan = price * rate;
  let capped = false;
  if (maxFeeMan != null && feeMan > maxFeeMan) {
    feeMan = maxFeeMan;
    capped = true;
  }
  return {
    meta: BROKERAGE_FEE_RULE,
    priceMan: price,
    ratePct: rate * 100,
    feeMan: Math.round(feeMan * 100) / 100,
    capped,
    notes: [
      "표기 금액은 법정 상한입니다. 실제 중개보수는 협의로 더 낮을 수 있습니다.",
      "매도·매수 각자 부담이 일반적이며, 여기 결과는 매수인 1인 부담 상한 기준입니다.",
    ],
  };
}

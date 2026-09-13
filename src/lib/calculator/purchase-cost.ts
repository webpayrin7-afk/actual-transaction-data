import {
  calculateAcquisitionTax,
  type AcquisitionHomeStatus,
  type AcquisitionTaxResult,
  type ExclusiveAreaInput,
} from "@/lib/calculator/rules/acquisition-tax";
import {
  calculateBrokerageFeeCap,
  type BrokerageFeeResult,
} from "@/lib/calculator/rules/brokerage-fee";
import type { MoneyMan } from "@/lib/calculator/rules/types";

export type PurchaseCostInput = {
  priceMan: MoneyMan;
  homeStatus: AcquisitionHomeStatus;
  exclusiveArea?: ExclusiveAreaInput;
  /** 중개보수 요율(%p). 생략 시 법정 상한. 상한 초과분은 clamp. */
  brokerageRatePct?: number | null;
};

export type PurchaseCostResult = {
  priceMan: MoneyMan;
  acquisition: AcquisitionTaxResult;
  brokerage: BrokerageFeeResult;
  /** 예상 총 매수비용 = 매수가 + 취득세 합 + 중개보수 */
  totalCostMan: number;
  /** 매수가 외 부대비용 */
  extraCostMan: number;
};

export function calculatePurchaseCost(
  input: PurchaseCostInput,
): PurchaseCostResult {
  const acquisition = calculateAcquisitionTax({
    priceMan: input.priceMan,
    homeStatus: input.homeStatus,
    exclusiveArea: input.exclusiveArea,
  });
  const brokerage = calculateBrokerageFeeCap(
    input.priceMan,
    input.brokerageRatePct,
  );
  const extraCostMan = acquisition.totalTaxMan + brokerage.feeMan;
  return {
    priceMan: input.priceMan,
    acquisition,
    brokerage,
    extraCostMan,
    totalCostMan: input.priceMan + extraCostMan,
  };
}

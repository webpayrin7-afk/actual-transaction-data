export type { RuleMeta, MoneyMan } from "@/lib/calculator/rules/types";
export {
  calculateAcquisitionTax,
  ACQUISITION_TAX_RULE,
  classifyNationalHousingSize,
  oneHomeProgressiveRate,
  type AcquisitionHomeStatus,
  type ExclusiveAreaInput,
  type NationalHousingSizeClass,
  type RuralSpecialTaxStatus,
} from "@/lib/calculator/rules/acquisition-tax";
export {
  calculateBrokerageFeeCap,
  BROKERAGE_FEE_RULE,
  BROKERAGE_RATE_PCT_OPTIONS,
  brokerageRatePctOptionsForPrice,
} from "@/lib/calculator/rules/brokerage-fee";
export {
  calculatePropertyTax,
  PROPERTY_TAX_RULE,
  fairMarketRatio2026,
} from "@/lib/calculator/rules/property-tax";
export {
  calculateComprehensiveRealEstateTax,
  COMPREHENSIVE_TAX_RULE,
  COMPREHENSIVE_FAIR_MARKET_RATIO,
  COMPREHENSIVE_GENERAL_RATE_BRACKETS,
} from "@/lib/calculator/rules/comprehensive-tax";
export {
  calculatePurchaseCost,
  type PurchaseCostInput,
  type PurchaseCostResult,
} from "@/lib/calculator/purchase-cost";
export {
  calculateHoldingTax,
  type HoldingTaxInput,
  type HoldingTaxResult,
} from "@/lib/calculator/holding-tax";
export {
  calculateLoanEstimate,
  LOAN_ESTIMATE_RULE,
  type LoanEstimateInput,
  type LoanEstimateResult,
} from "@/lib/calculator/loan-estimate";
export {
  formatManWon,
  formatManInput,
  formatEokMan,
  parseEokInputToMan,
} from "@/lib/calculator/format";
export {
  getComplexPublicPrices,
  type ComplexPublicPriceQuery,
  type ComplexPublicPriceResult,
  type PublicPriceLookupStatus,
  type PublicPriceMatchType,
} from "@/lib/calculator/public-price";

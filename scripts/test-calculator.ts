/**
 * Complex calculator v1 unit checks (rules only, no DB).
 *
 *   npx tsx scripts/test-calculator.ts
 */
import assert from "node:assert/strict";
import {
  calculateAcquisitionTax,
  calculateBrokerageFeeCap,
  calculateComprehensiveRealEstateTax,
  calculateHoldingTax,
  calculateLoanEstimate,
  calculatePropertyTax,
  calculatePurchaseCost,
  classifyNationalHousingSize,
  COMPREHENSIVE_FAIR_MARKET_RATIO,
  fairMarketRatio2026,
  formatEokMan,
  oneHomeProgressiveRate,
  parseEokInputToMan,
  brokerageRatePctOptionsForPrice,
} from "../src/lib/calculator";

{
  const low = calculateAcquisitionTax({
    priceMan: 50_000,
    homeStatus: "one_home",
    exclusiveArea: { mode: "exact", sqm: 84 },
  });
  assert.equal(low.appliedRateLabel.includes("1%"), true);
  assert.equal(Math.round(low.baseTaxMan), 500);
  assert.equal(Math.round(low.localEducationTaxMan), 50);
  assert.equal(Math.round(low.ruralSpecialTaxMan), 0);
  assert.equal(Math.round(low.totalTaxMan), 550);
  assert.ok(low.meta.ruleVersion.length > 0);
  assert.ok(low.meta.effectiveFrom.length > 0);
  assert.ok(low.meta.source.length > 0);
}

{
  const at6 = calculateAcquisitionTax({
    priceMan: 60_000,
    homeStatus: "one_home",
    exclusiveArea: { mode: "exact", sqm: 84 },
  });
  assert.equal(Math.round(at6.baseTaxMan), 600);
  assert.equal(at6.appliedRate, 0.01);

  const justOver6 = calculateAcquisitionTax({
    priceMan: 60_001,
    homeStatus: "one_home",
    exclusiveArea: { mode: "exact", sqm: 84 },
  });
  assert.ok(justOver6.appliedRateLabel.includes("누진"));
  assert.ok(Math.abs(justOver6.appliedRate - 0.01) < 0.00015);

  const mid = calculateAcquisitionTax({
    priceMan: 75_000,
    homeStatus: "one_home",
    exclusiveArea: { mode: "exact", sqm: 84 },
  });
  assert.ok(mid.appliedRateLabel.includes("누진"));
  assert.equal(mid.appliedRate, 0.02);
  assert.equal(Math.round(mid.baseTaxMan), 1_500);
  assert.equal(Math.round(mid.localEducationTaxMan), 150);
  assert.equal(Math.round(mid.ruralSpecialTaxMan), 0);
  assert.equal(Math.round(mid.totalTaxMan), 1_650);

  const at9 = calculateAcquisitionTax({
    priceMan: 90_000,
    homeStatus: "one_home",
    exclusiveArea: { mode: "exact", sqm: 84 },
  });
  assert.equal(at9.appliedRate, 0.03);
  assert.equal(Math.round(at9.baseTaxMan), 2_700);

  const justOver9 = calculateAcquisitionTax({
    priceMan: 90_001,
    homeStatus: "one_home",
    exclusiveArea: { mode: "exact", sqm: 84 },
  });
  assert.ok(justOver9.appliedRateLabel.includes("3%"));
  assert.equal(justOver9.appliedRate, 0.03);
  assert.ok(justOver9.totalTaxMan > mid.totalTaxMan);

  assert.equal(oneHomeProgressiveRate(600_000_000), 0.01);
  assert.equal(oneHomeProgressiveRate(750_000_000), 0.02);
  assert.equal(oneHomeProgressiveRate(900_000_000), 0.03);
}

{
  const heavy = calculateAcquisitionTax({
    priceMan: 100_000,
    homeStatus: "multi_heavy",
    exclusiveArea: { mode: "exact", sqm: 84 },
  });
  const normal = calculateAcquisitionTax({
    priceMan: 100_000,
    homeStatus: "one_home",
    exclusiveArea: { mode: "exact", sqm: 84 },
  });
  assert.ok(heavy.totalTaxMan > normal.totalTaxMan);
}

{
  for (const sqm of [84.99, 85.0]) {
    const r = calculateAcquisitionTax({
      priceMan: 100_000,
      homeStatus: "one_home",
      exclusiveArea: { mode: "exact", sqm },
    });
    assert.equal(Math.round(r.ruralSpecialTaxMan), 0);
    assert.equal(r.ruralSpecialTaxStatus, "exempt_national_housing");
  }
  for (const sqm of [85.01, 114]) {
    const r = calculateAcquisitionTax({
      priceMan: 100_000,
      homeStatus: "one_home",
      exclusiveArea: { mode: "exact", sqm },
    });
    assert.equal(Math.round(r.ruralSpecialTaxMan), 200);
    assert.equal(r.ruralSpecialTaxStatus, "taxed");
  }
  assert.equal(
    classifyNationalHousingSize({ mode: "range", minSqm: 84, maxSqm: 86 }),
    "straddles_85",
  );
  const straddle = calculateAcquisitionTax({
    priceMan: 100_000,
    homeStatus: "one_home",
    exclusiveArea: { mode: "range", minSqm: 84, maxSqm: 86 },
  });
  assert.equal(straddle.ruralSpecialTaxResolved, false);
  assert.equal(straddle.ruralSpecialTaxStatus, "needs_exact_area");
  assert.equal(Math.round(straddle.ruralSpecialTaxMan), 0);
}

{
  const fee = calculateBrokerageFeeCap(30_000);
  assert.ok(fee.feeMan > 0);
  assert.ok(fee.ratePct > 0);
  assert.ok(fee.meta.ruleVersion.startsWith("brokerage-fee"));
  assert.equal(fee.userSelected, false);
  assert.equal(fee.ratePct, fee.legalCapRatePct);

  assert.equal(calculateBrokerageFeeCap(4_000).ratePct, 0.6);
  assert.equal(calculateBrokerageFeeCap(10_000).ratePct, 0.5);
  assert.equal(calculateBrokerageFeeCap(50_000).ratePct, 0.4);
  assert.equal(calculateBrokerageFeeCap(100_000).ratePct, 0.5);
  assert.equal(calculateBrokerageFeeCap(130_000).ratePct, 0.6);
  assert.equal(calculateBrokerageFeeCap(200_000).ratePct, 0.7);

  const r04 = calculateBrokerageFeeCap(341_000, 0.4);
  assert.equal(Math.round(r04.feeMan), 1_364);
  assert.equal(r04.userSelected, true);
  const r07 = calculateBrokerageFeeCap(341_000, 0.7);
  assert.equal(Math.round(r07.feeMan), 2_387);
  assert.equal(r07.userSelected, false);

  const over = calculateBrokerageFeeCap(341_000, 0.9);
  assert.equal(over.ratePct, 0.7);
  const opts = brokerageRatePctOptionsForPrice(341_000);
  assert.ok(opts.includes(0.4));
  assert.ok(opts.includes(0.7));
  assert.equal(opts.every((p) => p <= 0.7), true);
}

{
  const purchase = calculatePurchaseCost({
    priceMan: 100_000,
    homeStatus: "one_home",
    exclusiveArea: { mode: "exact", sqm: 84 },
  });
  assert.equal(
    Math.round(purchase.totalCostMan),
    Math.round(
      purchase.priceMan +
        purchase.acquisition.totalTaxMan +
        purchase.brokerage.feeMan,
    ),
  );
}

{
  assert.equal(fairMarketRatio2026(30_000, true), 0.43);
  assert.equal(fairMarketRatio2026(30_001, true), 0.44);
  assert.equal(fairMarketRatio2026(60_000, true), 0.44);
  assert.equal(fairMarketRatio2026(60_001, true), 0.45);
  assert.equal(fairMarketRatio2026(80_000, false), 0.6);

  const p43 = calculatePropertyTax({
    officialPriceMan: 30_000,
    singleHomeHousehold: true,
    includeUrbanShare: true,
  });
  assert.equal(p43.fairMarketRatio, 0.43);
  assert.ok(p43.totalMan > 0);
  assert.ok(p43.notes.some((n) => n.includes("미반영") || n.includes("예상")));

  const holding = calculateHoldingTax({
    officialPriceMan: 80_000,
    singleHomeHousehold: true,
    includeUrbanShare: true,
    projectionYears: 2,
    officialPriceGrowthRate: 0.03,
  });
  assert.equal(holding.years.length, 3);
  assert.ok(holding.projectionDisclaimer?.includes("3.0%"));
  assert.ok(holding.estimateDisclaimer.includes("예상"));
  assert.ok(
    holding.years[2]!.officialPriceMan > holding.years[0]!.officialPriceMan,
  );
  assert.equal(holding.years[0]!.property.fairMarketRatio, 0.45);
}

{
  assert.equal(COMPREHENSIVE_FAIR_MARKET_RATIO, 0.6);
  const below = calculateComprehensiveRealEstateTax({
    officialPriceMan: 100_000,
    singleHomeHousehold: true,
  });
  assert.equal(below.taxable, false);
  assert.equal(below.taxMan, 0);

  const above = calculateComprehensiveRealEstateTax({
    officialPriceMan: 200_000,
    singleHomeHousehold: true,
  });
  assert.equal(above.taxable, true);
  assert.equal(above.deductionMan, 120_000);
  assert.equal(Math.round(above.taxBaseMan), 48_000);
  assert.ok(above.notes.some((n) => n.includes("미반영") || n.includes("예상")));

  const holding = calculateHoldingTax({
    officialPriceMan: 50_000,
    singleHomeHousehold: true,
  });
  assert.equal(holding.years[0]!.comprehensive.taxMan, 0);
  assert.equal(holding.years[0]!.comprehensive.taxable, false);
}

{
  const loan = calculateLoanEstimate({
    priceMan: 100_000,
    cashMan: 40_000,
    annualIncomeMan: 8_000,
    existingMonthlyMan: 0,
    years: 30,
    baseRatePct: 4,
    metro: "capital",
    regulated: "regulated",
    homes: "0",
    firstHome: true,
    disposeCondition: false,
    repayMethod: "equal_payment",
  });
  assert.equal(loan.breakdown.blocked, false);
  assert.ok(loan.estimatedLoanMan > 0);
  assert.ok(loan.estimatedLoanMan <= loan.maxLoanMan);
  assert.ok(loan.estimatedLoanMan <= loan.fundingGapMan);
  assert.ok(loan.requiredCashMan >= 0);
  assert.ok(loan.monthlyPaymentMan > 0);
  assert.ok(loan.limitingLabels.length >= 1);
  assert.ok(loan.disclaimer.includes("보장"));
}

{
  const blocked = calculateLoanEstimate({
    priceMan: 100_000,
    cashMan: 20_000,
    annualIncomeMan: 5_000,
    existingMonthlyMan: 0,
    years: 30,
    baseRatePct: 4,
    metro: "capital",
    regulated: "regulated",
    homes: "2plus",
    firstHome: false,
    disposeCondition: false,
    repayMethod: "equal_payment",
  });
  assert.equal(blocked.breakdown.blocked, true);
  assert.equal(blocked.estimatedLoanMan, 0);
}

{
  // Phase 1.2 golden: 34.1억 · 전용 84.80~84.97㎡ · 1주택 일반취득
  const audit = calculateAcquisitionTax({
    priceMan: 341_000,
    homeStatus: "one_home",
    exclusiveArea: { mode: "range", minSqm: 84.8, maxSqm: 84.97 },
  });
  assert.equal(Math.round(audit.baseTaxMan), 10_230);
  assert.equal(Math.round(audit.localEducationTaxMan), 1_023);
  assert.equal(Math.round(audit.ruralSpecialTaxMan), 0);
  assert.equal(Math.round(audit.totalTaxMan), 11_253);
  assert.equal(audit.ruralSpecialTaxStatus, "exempt_national_housing");
  assert.ok(audit.appliedRateLabel.includes("3%"));

  const purchase04 = calculatePurchaseCost({
    priceMan: 341_000,
    homeStatus: "one_home",
    exclusiveArea: { mode: "range", minSqm: 84.8, maxSqm: 84.97 },
    brokerageRatePct: 0.4,
  });
  assert.equal(Math.round(purchase04.acquisition.totalTaxMan), 11_253);
  assert.equal(Math.round(purchase04.brokerage.feeMan), 1_364);
  assert.equal(
    Math.round(purchase04.totalCostMan),
    Math.round(341_000 + 11_253 + 1_364),
  );

  const purchase07 = calculatePurchaseCost({
    priceMan: 341_000,
    homeStatus: "one_home",
    exclusiveArea: { mode: "range", minSqm: 84.8, maxSqm: 84.97 },
    brokerageRatePct: 0.7,
  });
  assert.equal(Math.round(purchase07.brokerage.feeMan), 2_387);
  assert.ok(purchase07.totalCostMan > purchase04.totalCostMan);
}

{
  assert.equal(parseEokInputToMan("34.1"), 341_000);
  assert.equal(parseEokInputToMan("34.1억"), 341_000);
  assert.equal(parseEokInputToMan("34억1000"), 341_000);
  assert.equal(parseEokInputToMan("34억1000만"), 341_000);
  assert.equal(parseEokInputToMan("341000만원"), 341_000);
  assert.equal(parseEokInputToMan("34억 1,000만원"), 341_000);
  assert.ok(formatEokMan(341_000).includes("34억"));
}

console.log("test-calculator: ok");

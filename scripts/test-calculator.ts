/**
 * Complex calculator v1 unit checks (rules only, no DB).
 *
 *   npx tsx scripts/test-calculator.ts
 */
import assert from "node:assert/strict";
import {
  calculateAcquisitionTax,
  calculateBrokerageFeeCap,
  calculateHoldingTax,
  calculateLoanEstimate,
  calculatePropertyTax,
  calculatePurchaseCost,
  formatEokMan,
  parseEokInputToMan,
} from "../src/lib/calculator";

{
  const low = calculateAcquisitionTax({
    priceMan: 50_000,
    homeStatus: "one_home",
  });
  assert.equal(low.appliedRateLabel.includes("1%"), true);
  assert.ok(low.totalTaxMan > 0);
  assert.ok(low.meta.ruleVersion.length > 0);
  assert.ok(low.meta.effectiveFrom.length > 0);
  assert.ok(low.meta.source.length > 0);
}

{
  const mid = calculateAcquisitionTax({
    priceMan: 75_000,
    homeStatus: "one_home",
  });
  assert.ok(mid.appliedRateLabel.includes("누진"));
  const high = calculateAcquisitionTax({
    priceMan: 120_000,
    homeStatus: "one_home",
  });
  assert.ok(high.appliedRateLabel.includes("3%"));
  assert.ok(high.totalTaxMan > mid.totalTaxMan);
}

{
  const heavy = calculateAcquisitionTax({
    priceMan: 100_000,
    homeStatus: "multi_heavy",
  });
  const normal = calculateAcquisitionTax({
    priceMan: 100_000,
    homeStatus: "one_home",
  });
  assert.ok(heavy.totalTaxMan > normal.totalTaxMan);
}

{
  const fee = calculateBrokerageFeeCap(30_000);
  assert.ok(fee.feeMan > 0);
  assert.ok(fee.ratePct > 0);
  assert.ok(fee.meta.ruleVersion.startsWith("brokerage-fee"));
}

{
  const purchase = calculatePurchaseCost({
    priceMan: 100_000,
    homeStatus: "one_home",
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
  const property = calculatePropertyTax({
    officialPriceMan: 80_000,
    includeUrbanShare: true,
  });
  assert.ok(property.totalMan > 0);

  const holding = calculateHoldingTax({
    officialPriceMan: 80_000,
    singleHomeHousehold: true,
    projectionYears: 2,
    officialPriceGrowthRate: 0.03,
  });
  assert.equal(holding.years.length, 3);
  assert.ok(holding.projectionDisclaimer?.includes("3.0%"));
  assert.ok(
    holding.years[2]!.officialPriceMan > holding.years[0]!.officialPriceMan,
  );
}

{
  // Below 종부세 공제 — tax should be 0 for 1 home
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
  assert.equal(parseEokInputToMan("34.1"), 341_000);
  assert.ok(formatEokMan(341_000).includes("34억"));
}

// No DB imports in calculator modules (static sanity via require graph is
// covered by unit-only script — writes remain 0 by design).
console.log("test-calculator: ok");

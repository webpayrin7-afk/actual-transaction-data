/**
 * LTV·DSR·DTI 한도 계산 regression.
 * 숫자 공식은 바꾸지 않고, min 제약과 blocked 경로만 고정한다.
 *
 *   npx tsx scripts/test-loan-limit.ts
 */
import assert from "node:assert/strict";
import {
  calculateLoanLimit,
  pickLimitingConstraints,
  type LoanCalcInput,
} from "../src/lib/loan/calc";
import { loanPageModeFromSearchParams } from "../src/lib/loan/mode";

function baseInput(partial: Partial<LoanCalcInput> = {}): LoanCalcInput {
  return {
    metro: "capital",
    regulated: "regulated",
    homes: "0",
    firstHome: true,
    disposeCondition: false,
    collateralMan: 100_000,
    annualIncomeMan: 8_000,
    existingMonthlyMan: 0,
    otherAnnualInterestMan: 0,
    years: 30,
    baseRatePct: 4.0,
    ...partial,
  };
}

{
  const r = calculateLoanLimit(baseInput());
  assert.equal(r.blocked, false);
  assert.ok(r.finalLimitMan > 0);
  assert.ok(r.finalLimitMan <= r.ltvLimitMan);
  assert.ok(r.finalLimitMan <= r.dsrLimitMan);
  if (r.dtiApplied) assert.ok(r.finalLimitMan <= r.dtiLimitMan);
  if (r.absoluteCapMan != null) assert.ok(r.finalLimitMan <= r.absoluteCapMan);
  assert.ok(r.limitingConstraints.length >= 1);
  const recomputed = pickLimitingConstraints(
    r.ltvLimitMan,
    r.dsrLimitMan,
    r.dtiLimitMan,
    r.absoluteCapMan,
    r.dtiApplied,
    r.finalLimitMan,
  );
  assert.deepEqual(r.limitingConstraints, recomputed);
}

{
  const r = calculateLoanLimit(
    baseInput({ homes: "2plus", metro: "capital", regulated: "regulated" }),
  );
  assert.equal(r.blocked, true);
  assert.equal(r.finalLimitMan, 0);
  assert.deepEqual(r.limitingConstraints, []);
}

{
  const r0 = calculateLoanLimit(baseInput({ baseRatePct: 0 }));
  const r4 = calculateLoanLimit(baseInput({ baseRatePct: 4 }));
  assert.equal(r0.blocked, false);
  assert.ok(r0.dsrLimitMan >= r4.dsrLimitMan);
}

assert.equal(
  loanPageModeFromSearchParams(new URLSearchParams()),
  "limit",
);
assert.equal(
  loanPageModeFromSearchParams(new URLSearchParams("mode=limit")),
  "limit",
);
assert.equal(
  loanPageModeFromSearchParams(new URLSearchParams("mode=repayment")),
  "repayment",
);
assert.equal(
  loanPageModeFromSearchParams(new URLSearchParams("rate=4.2")),
  "repayment",
);
assert.equal(
  loanPageModeFromSearchParams(new URLSearchParams("mode=limit&rate=4.2")),
  "limit",
);
assert.equal(
  loanPageModeFromSearchParams(new URLSearchParams("mode=rates")),
  "rates",
);
assert.equal(
  loanPageModeFromSearchParams(new URLSearchParams("mode=rates&rate=4.2")),
  "rates",
);

console.log("test-loan-limit: PASS");

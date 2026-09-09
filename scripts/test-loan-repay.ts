/**
 * 주택담보대출 상환·금리 비교 계산 테스트.
 * DB / MOLIT / 외부 API를 쓰지 않는다.
 *
 *   npx tsx scripts/test-loan-repay.ts
 */
import assert from "node:assert/strict";
import {
  RATE_COMPARE_DELTA_PCT,
  compareRateScenarios,
  monthsFromYears,
  parseManInput,
  parseRateInput,
  roundWon,
  scheduledEqualPaymentWon,
  summarizeRepayment,
} from "../src/lib/loan/repay";

function nearlyEqual(a: number, b: number, message: string) {
  assert.equal(a, b, `${message}: ${a} !== ${b}`);
}

// --- 원리금균등: 0% ---
{
  const s = summarizeRepayment(120_000_000, 0, 1, "equal_payment");
  nearlyEqual(s.months, 12, "0% 1년 개월수");
  assert.ok(s.monthlyPaymentWon != null);
  nearlyEqual(s.monthlyPaymentWon, 10_000_000, "0% 월상환");
  nearlyEqual(s.firstMonthWon, 10_000_000, "0% 첫달");
  nearlyEqual(s.lastMonthWon, 10_000_000, "0% 마지막달");
  nearlyEqual(s.totalInterestWon, 0, "0% 총이자");
  nearlyEqual(s.totalPaymentWon, 120_000_000, "0% 총상환");
}

{
  // 원금이 개월수로 나누어떨어지지 않을 때 마지막 달 정산
  const s = summarizeRepayment(100_000_000, 0, 1, "equal_payment");
  assert.ok(s.monthlyPaymentWon != null);
  nearlyEqual(s.monthlyPaymentWon, roundWon(100_000_000 / 12), "0% 월 스케줄");
  nearlyEqual(s.totalInterestWon, 0, "0% 잔액정산 총이자");
  nearlyEqual(s.totalPaymentWon, 100_000_000, "0% 잔액정산 총상환");
}

// --- 원리금균등: 3.5 / 4.0 / 4.5%, 30년, 3억 ---
const PRINCIPAL = 300_000_000;
const YEARS_30 = 30;

const eq35 = summarizeRepayment(PRINCIPAL, 3.5, YEARS_30, "equal_payment");
const eq40 = summarizeRepayment(PRINCIPAL, 4.0, YEARS_30, "equal_payment");
const eq45 = summarizeRepayment(PRINCIPAL, 4.5, YEARS_30, "equal_payment");

assert.equal(eq40.months, 360);
assert.ok(eq40.monthlyPaymentWon != null);
assert.equal(
  eq40.monthlyPaymentWon,
  scheduledEqualPaymentWon(PRINCIPAL, 4.0, 360),
);
assert.ok(eq35.totalInterestWon < eq40.totalInterestWon);
assert.ok(eq40.totalInterestWon < eq45.totalInterestWon);
assert.ok((eq40.monthlyPaymentWon ?? 0) < (eq45.monthlyPaymentWon ?? 0));
assert.equal(eq40.totalPaymentWon, PRINCIPAL + eq40.totalInterestWon);
assert.ok(
  Math.abs((eq40.monthlyPaymentWon ?? 0) - eq40.firstMonthWon) <= 1,
  "원리금균등 첫 달은 스케줄 월납입과 같거나 1원 이내",
);

// 1년 · 4%
{
  const s = summarizeRepayment(PRINCIPAL, 4.0, 1, "equal_payment");
  assert.equal(s.months, 12);
  assert.ok(s.monthlyPaymentWon && s.monthlyPaymentWon > PRINCIPAL / 12);
  assert.ok(s.totalInterestWon > 0);
  assert.equal(s.totalPaymentWon, PRINCIPAL + s.totalInterestWon);
}

// 큰 금액 10억 · 4% · 30년
{
  const s = summarizeRepayment(1_000_000_000, 4.0, 30, "equal_payment");
  assert.ok(s.monthlyPaymentWon && s.monthlyPaymentWon > 0);
  assert.equal(s.totalPaymentWon, 1_000_000_000 + s.totalInterestWon);
  assert.ok(s.totalInterestWon > 0);
}

// --- 원금균등 ---
{
  const s = summarizeRepayment(PRINCIPAL, 4.0, 30, "equal_principal");
  assert.equal(s.monthlyPaymentWon, null);
  assert.ok(s.firstMonthWon > s.lastMonthWon, "원금균등 첫 달 > 마지막 달");
  assert.equal(s.totalPaymentWon, PRINCIPAL + s.totalInterestWon);
  const principalMonthly = roundWon(PRINCIPAL / 360);
  assert.ok(s.lastMonthWon >= principalMonthly, "마지막 달은 잔여 원금+이자");
  assert.ok(s.firstYearPaymentWon > s.lastMonthWon * 12 * 0.5);
}

{
  const z = summarizeRepayment(PRINCIPAL, 0, 30, "equal_principal");
  nearlyEqual(z.totalInterestWon, 0, "원금균등 0% 총이자");
  nearlyEqual(z.totalPaymentWon, PRINCIPAL, "원금균등 0% 총상환");
  assert.ok(z.firstMonthWon > 0 && z.lastMonthWon > 0);
}

// --- 금리 비교 델타 ---
{
  const cmp = compareRateScenarios(PRINCIPAL, 30, "equal_payment", 4.0);
  assert.equal(cmp.deltaPct, RATE_COMPARE_DELTA_PCT);
  assert.equal(cmp.scenarios.length, 3);
  assert.deepEqual(
    cmp.scenarios.map((s) => s.ratePct),
    [3.5, 4.0, 4.5],
  );
  assert.ok(cmp.vsHigher);
  assert.ok(cmp.vsLower);
  assert.ok((cmp.vsHigher.monthlyDeltaWon ?? 0) > 0);
  assert.equal(
    cmp.vsHigher.annualDeltaWon,
    (cmp.vsHigher.monthlyDeltaWon ?? 0) * 12,
  );
  assert.ok(cmp.vsHigher.totalInterestDeltaWon > 0);
  assert.ok((cmp.vsLower.monthlyDeltaWon ?? 0) < 0);
  assert.equal(
    cmp.vsHigher.monthlyDeltaWon,
    (cmp.scenarios[2].summary.monthlyPaymentWon ?? 0) -
      (cmp.scenarios[1].summary.monthlyPaymentWon ?? 0),
  );
}

{
  const cmp = compareRateScenarios(PRINCIPAL, 30, "equal_principal", 4.0);
  assert.equal(cmp.vsHigher?.monthlyDeltaWon, null);
  assert.ok((cmp.vsHigher?.firstMonthDeltaWon ?? 0) > 0);
  assert.ok((cmp.vsHigher?.totalInterestDeltaWon ?? 0) > 0);
  assert.ok((cmp.vsLower?.firstMonthDeltaWon ?? 0) < 0);
}

{
  const cmp = compareRateScenarios(PRINCIPAL, 30, "equal_payment", 0);
  assert.equal(cmp.scenarios.length, 2);
  assert.deepEqual(
    cmp.scenarios.map((s) => s.kind),
    ["base", "higher"],
  );
  assert.equal(cmp.scenarios[1].ratePct, 0.5);
  assert.equal(cmp.vsLower, null);
  assert.ok(cmp.vsHigher);
}

assert.equal(monthsFromYears(30), 360);
assert.equal(parseManInput("30,000"), 30_000);
assert.equal(parseManInput("10000000"), 1_000_000); // cap 100억(만원)
assert.equal(parseRateInput("0"), 0);
assert.equal(parseRateInput("4.0"), 4);
assert.equal(parseRateInput("20"), 20);
assert.equal(parseRateInput("20.1"), null);
assert.equal(parseRateInput("-1"), null);

console.log("test-loan-repay: PASS");

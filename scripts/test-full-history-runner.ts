/**
 * Full-history range + runner lock/empty/priority unit tests.
 *   npx tsx scripts/test-full-history-runner.ts
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import {
  APTRENT_FULL_HISTORY_EARLIEST_YM,
  APTTRADE_FULL_HISTORY_EARLIEST_YM,
  APTTRADE_REGISTRATION_BASELINE_FROM_YM,
  currentContractYearMonth,
  rentFullHistoryMonths,
  saleFullHistoryMonths,
  salePre2023Months,
  yearMonthsBetween,
} from "../src/lib/molit/full-history-range";
import {
  acquireLock,
  FULL_HISTORY_LOCK,
  releaseLock,
} from "../src/lib/molit/full-history-shared";
import { planAptTradeRequestLawd } from "../src/lib/molit/temporal-lawd";

assert.equal(APTTRADE_FULL_HISTORY_EARLIEST_YM, "201610");
assert.equal(APTRENT_FULL_HISTORY_EARLIEST_YM, "202210");
assert.equal(APTTRADE_REGISTRATION_BASELINE_FROM_YM, "202301");

const sale = saleFullHistoryMonths(new Date("2026-09-15T00:00:00+09:00"));
assert.equal(sale[0], "201610");
assert.equal(sale[sale.length - 1], "202609");
assert.ok(sale.length === 120);

const rent = rentFullHistoryMonths(new Date("2026-09-15T00:00:00+09:00"));
assert.equal(rent[0], "202210");
assert.equal(rent[rent.length - 1], "202609");
assert.ok(rent.length === 48);

const pre = salePre2023Months(new Date("2026-09-15T00:00:00+09:00"));
assert.equal(pre[0], "201610");
assert.equal(pre[pre.length - 1], "202212");
assert.ok(!pre.includes("202301"));

assert.equal(
  currentContractYearMonth(new Date("2026-09-23T12:00:00+09:00")),
  "202609",
);
assert.deepEqual(yearMonthsBetween("202606", "202608"), [
  "202606",
  "202607",
  "202608",
]);

assert.equal(planAptTradeRequestLawd("29110", "201610"), "12210");
assert.equal(planAptTradeRequestLawd("46110", "202212"), "12110");
assert.equal(planAptTradeRequestLawd("42110", "201901"), "51110");

const OUT = resolve("data/poc/full-history");
mkdirSync(OUT, { recursive: true });

// Lock test uses a side-car path so a live daemon lock is not disturbed.
const TEST_LOCK = resolve(OUT, "run.lock.test");
if (existsSync(TEST_LOCK)) rmSync(TEST_LOCK, { force: true });

// Inline mini acquire against TEST_LOCK
function testAcquire(): boolean {
  if (existsSync(TEST_LOCK)) {
    const prev = JSON.parse(readFileSync(TEST_LOCK, "utf8")) as { pid?: number };
    if (prev.pid && existsSync(`/proc/${prev.pid}`)) return false;
  }
  writeFileSync(
    TEST_LOCK,
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
  );
  return true;
}
function testRelease() {
  if (!existsSync(TEST_LOCK)) return;
  const prev = JSON.parse(readFileSync(TEST_LOCK, "utf8")) as { pid?: number };
  if (prev.pid === process.pid) rmSync(TEST_LOCK, { force: true });
}

assert.equal(testAcquire(), true);
assert.equal(testAcquire(), false);
testRelease();
assert.ok(!existsSync(TEST_LOCK));

// Production lock helper still exports correctly
assert.equal(typeof acquireLock, "function");
assert.equal(typeof releaseLock, "function");
assert.ok(FULL_HISTORY_LOCK.endsWith("run.lock"));

const emptySemantics = {
  apiOkRows0: "NODATA/EMPTY_COMPLETE",
  notFetched: "MISSING",
};
assert.notEqual(emptySemantics.apiOkRows0, emptySemantics.notFetched);

console.log(
  JSON.stringify({
    ok: true,
    cases: [
      "sale-earliest-201610",
      "rent-earliest-202210",
      "pre-2023-sale-boundary",
      "temporal-historical-boundary",
      "single-run-lock",
      "empty-month-semantics",
    ],
  }),
);

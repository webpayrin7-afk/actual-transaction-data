/**
 * Minimal QA for Phase 2.5 — 잠실엘스 33평 selected-pyeong fee.
 * No screenshots. No DB writes.
 */
import { findKaptAreaFeeFixture } from "../src/lib/complex-detail/kapt-area-fee-fixture";
import {
  computeSameYearSummerPerM2,
  estimateSelectedPyeongMgmtFee,
  formatWonRangeAsManwon,
  reconcileLatestComponents,
} from "../src/lib/complex-detail/selected-pyeong-mgmt-fee";

const fixture = findKaptAreaFeeFixture({ aptName: "잠실엘스" });
if (!fixture) {
  console.error("FAIL: fixture not found for 잠실엘스");
  process.exit(1);
}

const estimate = estimateSelectedPyeongMgmtFee({
  fixture,
  exclusiveAreaMin: 84.8,
  exclusiveAreaMax: 84.97,
});
if (!estimate) {
  console.error("FAIL: estimate null");
  process.exit(1);
}

const winter = estimate.winter;
const summer = estimate.summer;
const trailing = estimate.trailingAverage;
const common = estimate.components.common;
const individual = estimate.components.individual;
const reserve = estimate.components.reserve;

if (!winter || !summer || !trailing || !common || !individual || !reserve) {
  console.error("FAIL: missing period/component");
  process.exit(1);
}

const reconcile = reconcileLatestComponents(estimate);
const summerRate = computeSameYearSummerPerM2(fixture, "202607");
const other = findKaptAreaFeeFixture({ aptName: "래미안대치팰리스" });

const out = {
  fixture: {
    kaptCode: fixture.kaptCode,
    areaBasis: fixture.areaBasis,
    months: fixture.months.map((m) => m.month),
  },
  latest: formatWonRangeAsManwon(
    estimate.latest.wonMin,
    estimate.latest.wonMax,
  ),
  winter: formatWonRangeAsManwon(winter.wonMin, winter.wonMax),
  summer: formatWonRangeAsManwon(summer.wonMin, summer.wonMax),
  summerHint: summer.hint,
  summerMonths: summer.monthsUsed,
  summerPerM2: summerRate,
  average: formatWonRangeAsManwon(trailing.wonMin, trailing.wonMax),
  components: {
    common: formatWonRangeAsManwon(common.wonMin, common.wonMax),
    individual: formatWonRangeAsManwon(individual.wonMin, individual.wonMax),
    reserve: formatWonRangeAsManwon(reserve.wonMin, reserve.wonMax),
  },
  reconcile,
  nonPilotFixture: other,
};

console.log(JSON.stringify(out, null, 2));

const checks = [
  ["latest", out.latest === "34만원"],
  ["winter", out.winter === "47만원"],
  ["summer", out.summer === "32만원"],
  ["average", out.average === "36만원"],
  ["summerHint", out.summerHint === "2개월 평균"],
  [
    "summerMonths",
    JSON.stringify(out.summerMonths) === JSON.stringify(["202606", "202607"]),
  ],
  ["reconcile", reconcile.ok === true],
  ["nonPilot", other === null],
  [
    "summerRate",
    Math.abs((summerRate?.avgTotalPerM2 ?? 0) - 3787.615) < 0.001,
  ],
] as const;

const failed = checks.filter(([, ok]) => !ok);
if (failed.length === 0) {
  console.log("QA PASS");
  process.exit(0);
}
console.error(
  "QA FAIL",
  failed.map(([name]) => name),
  out,
);
process.exit(1);

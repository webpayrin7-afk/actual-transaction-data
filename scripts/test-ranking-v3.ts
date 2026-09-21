import assert from "node:assert/strict";
import { evaluateHardIdentityV3 } from "../src/lib/region-ranking/eligibility-v3";
import { extractFeaturesV3 } from "../src/lib/region-ranking/features-v3";
import { loadPrivateConfigV3 } from "../src/lib/region-ranking/private-config-v3";
import {
  DECADE_COHORTS_V3,
  METHODOLOGY_FINGERPRINT_V3,
  RANKING_V3_VERSION,
  decadeCohortForLabel,
  decadeKeyFromRankingBand,
} from "../src/lib/region-ranking/ranking-v3";
import { availablePercentile, scoreCohortV3, type FeatureSnapshotRowV3 } from "../src/lib/region-ranking/score-v3";
import { windowsFromAsOf } from "../src/lib/region-ranking/snapshot";
import { readFileSync } from "node:fs";

assert.equal(RANKING_V3_VERSION, "seoul-ranking-v3");
assert.ok(METHODOLOGY_FINGERPRINT_V3.includes("no-activity-hard-exclude"));
assert.ok(METHODOLOGY_FINGERPRINT_V3.includes("interest-inactive"));
assert.equal(decadeCohortForLabel(33)?.key, "30");
assert.equal(decadeKeyFromRankingBand("84"), "30");
assert.equal(decadeKeyFromRankingBand("ALL"), "ALL");
assert.equal(DECADE_COHORTS_V3.length, 10);

assert.equal(
  evaluateHardIdentityV3({
    complexId: "cx_aaaaaaaaaaaaaaaa",
    lawdCd: "11710",
    bjdongCd: "10100",
    aptNameNorm: "잠실엘스",
    identityStatus: null,
    ambiguousName: false,
  }).ok,
  true,
);
assert.equal(
  evaluateHardIdentityV3({
    complexId: "cx_aaaaaaaaaaaaaaaa",
    lawdCd: "11710",
    bjdongCd: "10100",
    aptNameNorm: "잠실엘스",
    identityStatus: null,
    ambiguousName: true,
  }).ok,
  false,
);

const windows = windowsFromAsOf("2026-09-17");
const cohort = DECADE_COHORTS_V3.find((row) => row.key === "30")!;
const features = extractFeaturesV3({
  deals: [
    { dealDate: "2026-08-01", exclusiveArea: 84.8, dealAmount: 200000, marketPyeongLabel: 33 },
    { dealDate: "2025-01-01", exclusiveArea: 84.8, dealAmount: 180000, marketPyeongLabel: 33 },
  ],
  cohort,
  windows,
  profile: { householdCount: 5000, source: "test", sourceKey: null, sourceAsOf: null, confidence: "HIGH" },
  priceLookbackMonths: 60,
});
assert.equal(features.tradeCount, 1);
assert.equal(features.priceAvailability, "AVAILABLE");
assert.ok(features.medianPricePerMarketPyeong != null);

const noRecent = extractFeaturesV3({
  deals: [{ dealDate: "2023-01-01", exclusiveArea: 84.8, dealAmount: 150000, marketPyeongLabel: 33 }],
  cohort,
  windows,
  profile: { householdCount: null, source: null, sourceKey: null, sourceAsOf: null, confidence: "MISSING" },
  priceLookbackMonths: 60,
});
assert.equal(noRecent.tradeCount, 0);
assert.equal(noRecent.priceAvailability, "STALE_BUT_USABLE");
assert.equal(noRecent.householdAvailability, "MISSING");

assert.equal(availablePercentile(null, [1, 2, 3]), null);
assert.equal(availablePercentile(2, [1, 2, 3]), 0.5);

const loaded = loadPrivateConfigV3(JSON.parse(readFileSync("/tmp/seoul-v3-p1.json", "utf8")));
assert.equal(loaded.ok, true);
if (!loaded.ok) throw new Error("config");
assert.equal(loaded.config.weights.interest, 0);

function row(id: string, price: number | null, trades: number, hh: number | null): FeatureSnapshotRowV3 {
  return {
    complexId: id,
    lawdCd: "11710",
    bjdongCd: "10100",
    areaBand: "30",
    areaBandVersion: "SUPPLY_PYEONG_DECADE_V1",
    period: "12M",
    transactionAsOf: "2026-09-17",
    sourceWindowStart: "2025-09-17",
    sourceWindowEnd: "2026-09-17",
    recentWindowStart: "2026-06-17",
    recentWindowEnd: "2026-09-17",
    previousWindowStart: "2026-03-17",
    previousWindowEnd: "2026-06-17",
    medianPricePerMarketPyeong: price,
    priceAvailability: price == null ? "MISSING" : "AVAILABLE",
    medianDealAmount: price == null ? null : price * 33,
    tradeCount: trades,
    householdCount: hh,
    householdAvailability: hh == null ? "MISSING" : "AVAILABLE",
    turnover: hh && hh > 0 ? trades / hh : null,
    turnoverAvailability: hh == null ? "MISSING" : "AVAILABLE",
    activeMonthCount: trades > 0 ? 2 : 0,
    latestDealDate: trades > 0 ? "2026-08-01" : null,
    recent3mTradeCount: trades > 0 ? 1 : 0,
    previous3mTradeCount: 0,
    featureVersion: "region-feature-v3",
    profileSource: null,
    profileConfidence: hh == null ? "MISSING" : "HIGH",
    identityStatus: null,
    decadeCompetitiveness: null,
    decadeCompetitivenessAvailability: "MISSING",
    decadeCount: 1,
  };
}

const scored = scoreCohortV3({
  featureRunId: "test",
  rows: [
    row("cx_aaaaaaaaaaaaaaaa", 10000, 0, 1000),
    row("cx_bbbbbbbbbbbbbbbb", 11000, 5, 2000),
    row("cx_cccccccccccccccc", null, 0, 3000),
    row("cx_dddddddddddddddd", 9000, 2, null),
  ],
  regionScope: "gu",
  regionCode: "11710",
  config: loaded.config,
  privateConfigFingerprint: loaded.fingerprint,
  rankingVersion: RANKING_V3_VERSION,
});
assert.equal(scored.ok, true);
if (!scored.ok) throw new Error("score");
assert.equal(scored.baseEligible, 4);
assert.equal(scored.rows.filter((item) => item.rank != null).length, 4);
assert.equal(scored.rows.every((item) => item.eligible), true);
const noPrice = scored.rows.find((item) => item.complexId === "cx_cccccccccccccccc")!;
assert.equal(noPrice.publicDisplayMetrics.price_availability, "MISSING");
assert.ok(noPrice.rank != null);

const zeroInterest = loadPrivateConfigV3({
  ...JSON.parse(readFileSync("/tmp/seoul-v3-p1.json", "utf8")),
  weights: {
    price: 0.34,
    liquidity: 0.18,
    turnover: 0.1,
    household_scale: 0.14,
    stability: 0.12,
    momentum: 0.1,
    interest: 0.02,
  },
});
assert.equal(zeroInterest.ok, false);

console.log("ranking-v3 tests ok");

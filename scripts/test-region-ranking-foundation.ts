import assert from "node:assert/strict";
import {
  AREA_BAND_VERSION,
  REJECTED_84_ALTERNATE,
  activeAreaBand,
  inAreaBand,
} from "../src/lib/region-ranking/area-band";
import { evaluateEligibility, topTierGateReady } from "../src/lib/region-ranking/eligibility";
import { readFileSync } from "node:fs";
import { extractFeatures } from "../src/lib/region-ranking/features";
import { parsePocCohort, resolveProfileOverlay } from "../src/lib/region-ranking/profile-overlay";
import { inWindow, snapshotIdentity, windowsFromAsOf } from "../src/lib/region-ranking/snapshot";
import { featureRunId } from "../src/lib/region-ranking/run-identity";

const band = activeAreaBand("84");
assert.equal(AREA_BAND_VERSION, "REGIONAL_RANKING_AREA_BAND_V1");
assert.equal(inAreaBand(81.8, band), true);
assert.equal(inAreaBand(81.8, REJECTED_84_ALTERNATE), false);
assert.equal(inAreaBand(84.9, band), true);
assert.equal(inAreaBand(79.9, band), false);
assert.equal(inAreaBand(90.1, band), false);

const windows = windowsFromAsOf("2026-09-17");
assert.equal(windows.base12m.startExclusive, "2025-09-17");
assert.equal(windows.base12m.endInclusive, "2026-09-17");
assert.equal(windows.recent3m.startExclusive, "2026-06-17");
assert.equal(windows.previous3m.endInclusive, "2026-06-17");
assert.equal(inWindow("2026-06-17", windows.recent3m), false);
assert.equal(inWindow("2026-06-17", windows.previous3m), true);
assert.equal(inWindow("2025-09-17", windows.base12m), false);

const features = extractFeatures({
  band,
  windows,
  profile: {
    householdCount: 100,
    source: "kapt_basis_v5",
    sourceKey: "A00000000",
    sourceAsOf: "2026-09-01",
    confidence: "HIGH",
  },
  deals: [
    { dealDate: "2026-09-01", exclusiveArea: 84.5, dealAmount: 1000 },
    { dealDate: "2026-08-01", exclusiveArea: 81.8, dealAmount: 800 },
    { dealDate: "2026-04-01", exclusiveArea: 84.5, dealAmount: 600 },
    { dealDate: "2026-09-01", exclusiveArea: 70, dealAmount: 9999 },
    { dealDate: "2024-01-01", exclusiveArea: 84.5, dealAmount: 1 },
  ],
});
assert.equal(features.tradeCount, 3);
assert.equal(features.householdCount, 100);
assert.equal(features.turnover, 0.03);
assert.equal(features.activeMonthCount, 3);
assert.equal(features.recent3mTradeCount, 2);
assert.equal(features.previous3mTradeCount, 1);
assert.equal("buildingCount" in features, false);

const missing = extractFeatures({
  band,
  windows,
  profile: {
    householdCount: null,
    source: null,
    sourceKey: null,
    sourceAsOf: null,
    confidence: "MISSING",
  },
  deals: [{ dealDate: "2026-09-01", exclusiveArea: 84, dealAmount: 10 }],
});
assert.equal(missing.turnover, null);
const gated = evaluateEligibility({
  features: missing,
  transactionAsOf: windows.transactionAsOf,
  identityStatus: "IDENTITY-READY",
  config: { requireHouseholdProfile: true },
});
assert.equal(gated.exclusionReason, "PROFILE_HOUSEHOLD_MISSING");
assert.equal(gated.topTierEvaluated, false);
const floorPass = evaluateEligibility({
  features,
  transactionAsOf: windows.transactionAsOf,
  identityStatus: null,
  config: { requireHouseholdProfile: true, identityConfidenceFloor: "MEDIUM" },
});
assert.equal(floorPass.eligibleInput, true);
const floorBlock = evaluateEligibility({
  features: {
    ...features,
    profile: { ...features.profile, confidence: "LOW" },
  },
  transactionAsOf: windows.transactionAsOf,
  identityStatus: null,
  config: { requireHouseholdProfile: true, identityConfidenceFloor: "MEDIUM" },
});
assert.equal(floorBlock.exclusionReason, "IDENTITY_BELOW_FLOOR");
assert.equal(topTierGateReady(null), false);
assert.equal(topTierGateReady({}), false);

const absent = evaluateEligibility({
  features,
  transactionAsOf: windows.transactionAsOf,
  identityStatus: "IDENTITY-READY",
  config: null,
});
assert.equal(absent.exclusionReason, "PRIVATE_CONFIG_ABSENT");

const id = snapshotIdentity({
  featureRunId: featureRunId({
    transactionAsOf: windows.transactionAsOf,
    sourceWindowStart: windows.base12m.startExclusive,
    sourceWindowEnd: windows.base12m.endInclusive,
    recentWindowStart: windows.recent3m.startExclusive,
    recentWindowEnd: windows.recent3m.endInclusive,
    previousWindowStart: windows.previous3m.startExclusive,
    previousWindowEnd: windows.previous3m.endInclusive,
    areaBand: "84",
    areaBandVersion: AREA_BAND_VERSION,
    featureVersion: "region-feature-v1",
    cohortInputId: "cohort",
  }),
  windows,
});
assert.equal(id.featureVersion, "region-feature-v1");
assert.equal(id.sourceWindowStart, windows.base12m.startExclusive);
assert.equal(id.sourceWindowEnd, windows.base12m.endInclusive);
assert.equal(id.transactionAsOf, "2026-09-17");
assert.equal("rankingVersion" in id, false);

const poc = {
  complexId: "cx_ed52bf895d064c11",
  householdCount: 6864,
  profileConfidence: "HIGH" as const,
  profileSource: "CORE_PROFILE_AUDIT_20260919",
  profileAsOf: "2026-09-19",
  cohortOrigin: "ORIGINAL_POC" as const,
};
const matched = resolveProfileOverlay(poc, {
  householdCount: 6864,
  source: "COMPOSITE",
  sourceKey: "A13824006",
  sourceAsOf: "2026-01-01",
});
assert.equal(matched.status, "PRODUCTION_MATCH");
if (matched.status === "PRODUCTION_MATCH") {
  assert.equal(matched.profile.householdCount, 6864);
  assert.equal(matched.profile.source, "COMPOSITE");
  assert.equal(matched.profile.confidence, "HIGH");
}
const overlay = resolveProfileOverlay(poc, null);
assert.equal(overlay.status, "POC_OVERLAY");
if (overlay.status === "POC_OVERLAY") {
  assert.equal(overlay.profile.householdCount, 6864);
  assert.equal(overlay.profile.source, "CORE_PROFILE_AUDIT_20260919");
}
const conflict = resolveProfileOverlay(poc, {
  householdCount: 86,
  source: "COMPOSITE",
  sourceKey: null,
  sourceAsOf: null,
});
assert.equal(conflict.status, "PROFILE_CONFLICT");
assert.equal("profile" in conflict, false);

const cohort = parsePocCohort(
  JSON.parse(readFileSync("data/poc/region-ranking/songpa-original-poc-25.json", "utf8")),
);
assert.equal(cohort.length, 25);
assert.equal(new Set(cohort.map((row) => row.complexId)).size, 25);
assert.equal(cohort.find((row) => row.complexId === "cx_30d7eea6da810b52")?.householdCount, 9510);
assert.equal(cohort.find((row) => row.complexId === "cx_b4db01945df2a55b")?.householdCount, 3930);

console.log(JSON.stringify({ ok: true, area_band: AREA_BAND_VERSION }));

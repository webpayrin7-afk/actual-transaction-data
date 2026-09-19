/**
 * Presentation-only ranking UI tests. No scoring, no DB writes.
 */
import {
  confidenceCopy,
  coverageCopy,
  formatRankingAsOf,
  placeHeadline,
  rankingBandForArea,
  rankingBandForExclusiveRange,
  rankingComplexHref,
  regionRankingCode,
  regionRankingHref,
  rowPublicMetrics,
  unavailableBoardCopy,
  type ComplexRankPlace,
  type RegionRankingRow,
} from "../src/lib/region-ranking/public";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

assert(rankingBandForExclusiveRange(84.8, 84.97) === "84", "84.xx → 84 band");
assert(rankingBandForExclusiveRange(59.96, 59.96) === "59", "59.xx → 59 band");
assert(rankingBandForExclusiveRange(119.93, 119.93) === "114", "119 → 114 band");
assert(rankingBandForExclusiveRange(49, 49) === null, "49 is outside bands");
assert(rankingBandForExclusiveRange(101, 101) === null, "101 is outside bands");
assert(
  rankingBandForExclusiveRange(59.96, 84.97) === null,
  "span of two bands is not a ranking band",
);
assert(
  rankingBandForArea({ exclusiveArea: 84.88 }) === "84",
  "single exclusive 84.88",
);
assert(
  rankingBandForArea({
    exclusiveArea: 84.8,
    exclusiveAreaMin: 84.8,
    exclusiveAreaMax: 84.97,
  }) === "84",
  "market group 84 window",
);
assert(rankingBandForArea(null) === null, "null area");

assert(regionRankingCode(["11710"]) === "11710", "송파 lawd");
assert(regionRankingCode(["11650"]) === "11650", "서초 lawd");
assert(regionRankingCode(["11200"]) === "11200", "성동 lawd");
assert(regionRankingCode(["bad"]) === null, "reject non-lawd");

assert(
  coverageCopy({
    expected_bands: ["59", "84"],
    valid_bands: ["59", "84"],
    expected_band_count: 2,
    valid_band_count: 2,
    coverage_completeness: 1,
    coverage_status: "COMPLETE_PRODUCT_COVERAGE",
    single_product_band: false,
  }) === "59㎡ · 84㎡ 기준",
  "coverage uses band labels, not raw enum",
);
assert(
  coverageCopy({
    expected_bands: ["84"],
    valid_bands: ["84"],
    expected_band_count: 1,
    valid_band_count: 1,
    coverage_completeness: 1,
    coverage_status: "COMPLETE_PRODUCT_COVERAGE",
    single_product_band: true,
  }) === "한 면적대 단지",
  "single product band copy",
);
const coverageText = coverageCopy({
  expected_bands: ["59", "84", "114"],
  valid_bands: ["84"],
  expected_band_count: 3,
  valid_band_count: 1,
  coverage_completeness: 1 / 3,
  coverage_status: "PARTIAL_PRODUCT_COVERAGE",
  single_product_band: false,
});
assert(coverageText === "84㎡ 기준", `partial coverage copy: ${coverageText}`);
assert(
  coverageCopy({
    expected_bands: "114,59,84",
    valid_bands: "114,59,84",
    expected_band_count: 3,
    valid_band_count: 3,
    coverage_completeness: 1,
    coverage_status: "COMPLETE_PRODUCT_COVERAGE",
    single_product_band: false,
  }) === "59㎡ · 84㎡ · 114㎡ 기준",
  "coverage accepts published comma-separated bands",
);
assert(confidenceCopy("HIGH") === "자료 충분", "confidence bucket");
assert(confidenceCopy("COMPLETE_PRODUCT_COVERAGE") === null, "no raw enum as confidence");

const allRow: RegionRankingRow = {
  rank: 3,
  complex_id: "cx_4c63d9a100973c60",
  apt_name: "잠실엘스",
  dong: "잠실동",
  confidence: "HIGH",
  coverage: {
    expected_bands: ["59", "84", "114"],
    valid_bands: ["59", "84"],
    expected_band_count: 3,
    valid_band_count: 2,
    coverage_completeness: 2 / 3,
    coverage_status: "PARTIAL_PRODUCT_COVERAGE",
    single_product_band: false,
  },
  public_metrics: {
    median_price_per_sqm: 3200,
    median_deal_amount: 280000,
    trade_count: 40,
    latest_deal_date: "2026-09-12",
  },
};
const allMetrics = rowPublicMetrics("ALL", allRow);
assert(allMetrics.price === null, "ALL must not invent a blended price");
assert(allMetrics.perSqm === null, "ALL must not invent 평당가");
assert(allMetrics.volume === null, "ALL does not use band volume as a fake overall");
assert(
  allMetrics.allHint?.includes("59㎡ · 84㎡ 기준") === true,
  `ALL hint ${allMetrics.allHint}`,
);
assert(!String(allMetrics.allHint).includes("COMPLETE"), "no raw coverage enum");
assert(!String(allMetrics.allHint).includes("PARTIAL"), "no raw coverage enum");

const bandMetrics = rowPublicMetrics("84", allRow);
assert(bandMetrics.price != null, "84 shows median price");
assert(bandMetrics.volume === "40건", "84 shows volume");

const gu: ComplexRankPlace = {
  status: "ranked",
  rank: 3,
  total: 57,
  confidence: null,
  coverage: null,
  transactionAsOf: "2026-09-17",
  rankingVersion: "seoul-ranking-v2",
  smallCohort: false,
};
const dong: ComplexRankPlace = {
  status: "ranked",
  rank: 3,
  total: 6,
  confidence: null,
  coverage: null,
  transactionAsOf: "2026-09-17",
  rankingVersion: "seoul-ranking-v2",
  smallCohort: true,
};
const guLine = placeHeadline({ regionName: "송파구", place: gu });
assert(guLine?.title === "송파구 3위", `gu title ${guLine?.title}`);
assert(guLine?.meta === "57개 단지 중", `gu meta ${guLine?.meta}`);
const dongLine = placeHeadline({ regionName: "잠실동", place: dong });
assert(dongLine?.title === "잠실동 3위", `dong title ${dongLine?.title}`);
assert(
  dongLine?.meta === "잠실동 비교 6개 단지 기준",
  `dong meta ${dongLine?.meta}`,
);
assert(!JSON.stringify(dongLine).includes("smallCohort"), "no raw smallCohort");

const unavailable = {
  status: "unavailable" as const,
  rank: null,
  total: null,
  confidence: null,
  coverage: null,
  transactionAsOf: null,
  rankingVersion: null,
  smallCohort: false,
};
assert(placeHeadline({ regionName: "서초구", place: unavailable }) === null, "unavailable place");
assert(
  unavailableBoardCopy("ALL").title.includes("준비 중"),
  "unavailable copy is product state",
);

assert(formatRankingAsOf("2026-09-17") === "2026.09.17 기준", "as-of date");
assert(formatRankingAsOf(null) === null, "no hardcoded as-of");
assert(
  rankingComplexHref({
    aptName: "잠실엘스",
    regionSlug: "seoul-songpa",
    gu: "송파구",
  })?.includes("/apt/") === true,
  "canonical apt href",
);
assert(
  rankingComplexHref({ aptName: "  ", regionSlug: "seoul-songpa" }) === null,
  "no name-only empty lookup",
);
assert(
  regionRankingHref("seoul-songpa") === "/region/seoul-songpa#region-ranking",
  "region CTA",
);

console.log("ok: region-ranking-ui");

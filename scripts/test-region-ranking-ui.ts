/**
 * Presentation-only ranking UI tests. No scoring, no DB writes.
 */
import {
  INSUFFICIENT_SAMPLE_COPY,
  PRICE_COMPARE_TABS,
  PRICE_COMPARE_UNSUPPORTED_COPY,
  PRICE_LEVEL_TIP,
  RANKING_TABS,
  RANKING_TYPES,
  RANK_PREPARING_COPY,
  RANK_SMALL_REGION_COPY,
  TREND_PERIOD_TABS,
  TREND_TIP,
  barWidthPct,
  confidenceCopy,
  coverageCopy,
  dongSmallCohortHelper,
  formatRankingAsOf,
  formatReferenceMonthLabel,
  formatSignedPct,
  formatWonPerPyeong,
  formatWonPerSqm,
  placeHeadline,
  priceCompareStatusCopy,
  priceLevelScale,
  rankingBandForArea,
  rankingBandForExclusiveRange,
  rankingComplexHref,
  regionOverviewCtaLabel,
  regionRankingCode,
  regionRankingHref,
  rowPublicMetrics,
  trendAbsScale,
  trendBarLayout,
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

assert(
  RANKING_TYPES.join(",") === "COMPOSITE,TRADE_VOLUME,PRICE_PER_SQM",
  "V2 ranking types",
);
assert(
  RANKING_TABS.map((tab) => tab.label).join("|") === "종합|거래량|㎡당 가격",
  "region overview tabs",
);
assert(
  !RANKING_TABS.some((tab) => tab.id === "59" || tab.id === "84" || tab.id === "114" || tab.id === "ALL"),
  "area-band tabs removed from region overview",
);
assert(RANKING_TABS[0].id === "COMPOSITE", "default tab is 종합");
assert(!RANKING_TABS.some((tab) => tab.hint.includes("평균")), "price tab never says 평균");
assert(!RANKING_TABS[0].hint.includes("weight"), "no composite weights");

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
const compositeMetrics = rowPublicMetrics("COMPOSITE", allRow);
assert(compositeMetrics.primary === null, "COMPOSITE must not invent a blended price");
assert(compositeMetrics.hint?.includes("59㎡ · 84㎡ 기준") === true, `COMPOSITE hint ${compositeMetrics.hint}`);
assert(!String(compositeMetrics.hint).includes("COMPLETE"), "no raw coverage enum");
assert(!String(compositeMetrics.hint).includes("score"), "no composite score");

const volumeRow: RegionRankingRow = {
  rank: 1,
  complex_id: "cx_4c63d9a100973c60",
  apt_name: "잠실엘스",
  dong: "잠실동",
  trade_count_3m: 31,
  latest_deal_date: "2026-09-12",
};
const volumeMetrics = rowPublicMetrics("TRADE_VOLUME", volumeRow);
assert(volumeMetrics.primary === "31건", `volume primary ${volumeMetrics.primary}`);
assert(volumeMetrics.secondary === "2026.09.12", `volume latest ${volumeMetrics.secondary}`);

const priceRow: RegionRankingRow = {
  rank: 1,
  complex_id: "cx_dummy",
  apt_name: "주공아파트5단지",
  dong: "잠실동",
  median_price_per_sqm_3m: 5303,
  trade_count_3m: 28,
};
const priceMetrics = rowPublicMetrics("PRICE_PER_SQM", priceRow);
assert(priceMetrics.primary === "5,303만원/㎡", `price primary ${priceMetrics.primary}`);
assert(priceMetrics.secondary === "거래 28건", `price secondary ${priceMetrics.secondary}`);
assert(!String(priceMetrics.primary).includes("평균"), "no 평균");

const guPlace: ComplexRankPlace = {
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
const guLine = placeHeadline({ regionName: "송파구", place: guPlace });
assert(guLine?.title === "송파구 3위", `gu title ${guLine?.title}`);
assert(guLine?.meta === "57개 단지 중", `gu meta ${guLine?.meta}`);
const dongLine = placeHeadline({ regionName: "잠실동", place: dong });
assert(dongLine?.title === "잠실동 3위", `dong title ${dongLine?.title}`);
assert(dongLine?.meta == null, "dong row does not repeat cohort copy");
assert(!JSON.stringify(dongLine).includes("smallCohort"), "no raw smallCohort");
const helper = dongSmallCohortHelper({
  dongName: "잠실동",
  places: [dong, dong],
});
assert(
  helper === "잠실동 순위 · 비교 가능한 6개 단지 기준",
  `helper ${helper}`,
);
assert(
  (helper?.match(/비교 가능한/g)?.length ?? 0) === 1,
  "helper appears once",
);
assert(
  dongSmallCohortHelper({ dongName: "잠실동", places: [guPlace] }) === null,
  "no helper when smallCohort is false",
);

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
  unavailableBoardCopy("COMPOSITE").title === RANK_PREPARING_COPY,
  "unavailable copy preserves preparing status",
);
assert(RANK_SMALL_REGION_COPY.includes("비교 가능한 아파트"), "small-region copy is product language");
assert(RANK_PREPARING_COPY !== RANK_SMALL_REGION_COPY, "preparing and small-region stay distinct");

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
  regionRankingHref("seoul-songpa") === "/region/seoul-songpa?tab=stats",
  "region CTA stays on 지역현황 tab",
);
assert(
  regionOverviewCtaLabel("송파구") === "송파구 지역현황 보기",
  "CTA renamed to 지역현황",
);

assert(PRICE_COMPARE_TABS.map((tab) => tab.label).join("|") === "가격 수준|변동률", "price compare tabs");
assert(TREND_PERIOD_TABS.map((tab) => tab.label).join("|") === "3개월|6개월|1년|3년", "trend periods");
assert(TREND_PERIOD_TABS[0].id === "3M", "default trend period");
assert(PRICE_LEVEL_TIP.includes("중위가격"), "price tip uses median");
assert(!PRICE_LEVEL_TIP.includes("평균"), "price tip never says 평균");
assert(TREND_TIP.includes("거래 구성에 따라 변동될 수 있습니다"), "trend tip mentions composition");
assert(!TREND_TIP.includes("시세 변동률"), "do not assert 시세 변동률");

assert(formatWonPerSqm(5303) === "5,303만원/㎡", "만원/㎡");
assert(formatWonPerPyeong(12949.7) === "1억 2,950만/평", `els pyeong ${formatWonPerPyeong(12949.7)}`);
assert(formatWonPerPyeong(12719.2) === "1억 2,719만/평", "dong pyeong");
assert(formatWonPerPyeong(7200) === "7,200만/평", "gu pyeong");
assert(formatWonPerPyeong(3537.7) === "3,538만/평", "seoul pyeong");
assert(formatReferenceMonthLabel("2026-09") === "2026년 9월 기준", "reference month from API");
assert(formatReferenceMonthLabel(null) === null, "no hardcoded month");
assert(formatSignedPct(1.82) === "+1.82%", `3M complex ${formatSignedPct(1.82)}`);
assert(formatSignedPct(3.83) === "+3.83%", "3M dong");
assert(formatSignedPct(-18.33) === "-18.33%", "3M gu");
assert(formatSignedPct(-2.99) === "-2.99%", "3M seoul");
assert(formatSignedPct(0) === "0%", "true zero stays signed only as 0%");

const elsPrice = [
  { status: "ok", value: 12949.7 },
  { status: "ok", value: 12719.2 },
  { status: "ok", value: 7200 },
  { status: "ok", value: 3537.7 },
];
assert(priceLevelScale(elsPrice) === 12949.7, "scale uses available max, no score transform");
assert(barWidthPct(12949.7, 12949.7) === 100, "complex bar full");
assert(Math.round(barWidthPct(7200, 12949.7)) === 56, "gu bar proportional");
assert(barWidthPct(null, 12949.7) === 0, "missing value has no bar");

const els3m = [
  { status: "ok" as const, changePercent: 1.82 },
  { status: "ok" as const, changePercent: 3.83 },
  { status: "ok" as const, changePercent: -18.33 },
  { status: "ok" as const, changePercent: -2.99 },
];
assert(trendAbsScale(els3m, 18.33) === 18.33, "trend scale from API maxAbs");
assert(trendBarLayout(-18.33, 18.33).side === "left", "negative left");
assert(trendBarLayout(-18.33, 18.33).pct === 100, "max abs fills left");
assert(trendBarLayout(1.82, 18.33).side === "right", "positive right");
assert(trendBarLayout(0, 18.33).side === "none", "true zero has no bar");
assert(trendBarLayout(null, 18.33).side === "none", "insufficient not drawn as 0");

const mixed = [
  { status: "ok" as const, changePercent: 1.82 },
  { status: "INSUFFICIENT_SAMPLE" as const, changePercent: null },
];
assert(trendAbsScale(mixed, null) === 1.82, "insufficient rows excluded from scale");
assert(INSUFFICIENT_SAMPLE_COPY === "표본 부족", "sample copy");
assert(
  priceCompareStatusCopy("PRICE_COMPARE_UNSUPPORTED_AREA").title === PRICE_COMPARE_UNSUPPORTED_COPY,
  "unsupported area is a product state",
);
assert(
  priceCompareStatusCopy("unavailable").title === RANK_PREPARING_COPY,
  "unavailable stays preparing, not inferred as small cohort",
);

console.log("ok: region-ranking-ui");

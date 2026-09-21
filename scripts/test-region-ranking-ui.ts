/**
 * Presentation-only ranking UI tests. No scoring, no DB writes.
 */
import {
  COMPLEX_EXACT_TIP,
  INSUFFICIENT_SAMPLE_COPY,
  PRICE_COMPARE_TABS,
  PRICE_COMPARE_UNAVAILABLE_ROW_COPY,
  PRICE_COMPARE_UNSUPPORTED_COPY,
  PRICE_LEVEL_TIP,
  PRICE_POSITION_V21_VERSION,
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
  parseComplexPricePosition,
  placeHeadline,
  priceCompareRowCopy,
  priceCompareStatusCopy,
  priceLevelScale,
  rankingBandForArea,
  rankingSelectedHeading,
  selectedPyeongCompareLines,
  rankingBandForExclusiveRange,
  rankingComplexHref,
  regionOverviewCtaLabel,
  regionRankingCode,
  regionRankingHref,
  rowPublicMetrics,
  trendAbsScale,
  trendBarLayout,
  trendEndpointFallbackNote,
  trendHorizonFallbackNotes,
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
const regionTabIds = RANKING_TABS.map((tab) => String(tab.id));
assert(
  !["59", "84", "114", "ALL"].some((id) => regionTabIds.includes(id)),
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
assert(
  RANK_PREPARING_COPY.includes("준비 중") && RANK_SMALL_REGION_COPY.includes("비교 가능한 아파트"),
  "preparing and small-region stay distinct",
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
  regionRankingHref("seoul-songpa") === "/region/seoul-songpa?tab=stats",
  "region CTA stays on 지역현황 tab",
);
assert(
  regionOverviewCtaLabel("송파구") === "송파구 지역현황 보기",
  "CTA renamed to 지역현황",
);

assert(PRICE_COMPARE_TABS.map((tab) => tab.label).join("|") === "가격 수준|변동률", "price compare tabs");
assert(TREND_PERIOD_TABS.map((tab) => tab.label).join("|") === "6개월|1년|2년|5년", "trend periods");
assert(TREND_PERIOD_TABS.map((tab) => tab.id).join("|") === "6M|1Y|2Y|5Y", "v2.1 horizons only");
assert(TREND_PERIOD_TABS[0].id === "6M", "default trend period");
const trendIds = TREND_PERIOD_TABS.map((tab) => String(tab.id));
assert(!["3M", "3Y"].some((id) => trendIds.includes(id)), "no 3M/3Y");
assert(
  PRICE_LEVEL_TIP === "선택한 평형대의 단지별 실거래 가격을 기준으로 지역 가격 수준을 비교합니다.",
  "price tip is published v2.1 copy",
);
assert(
  TREND_TIP === "동일한 단지의 현재와 과거 실거래 가격을 비교해 지역 가격 변화를 계산합니다.",
  "trend tip is published v2.1 copy",
);
assert(COMPLEX_EXACT_TIP.includes("선택한 평형만"), "complex is exact selected 평");
assert(COMPLEX_EXACT_TIP.includes("같은 평형대"), "region stays decade cohort");
assert(!PRICE_LEVEL_TIP.includes("평균"), "price tip never says 평균");
assert(!TREND_TIP.includes("시세 변동률"), "do not assert 시세 변동률");

assert(formatWonPerSqm(5303) === "5,303만원/㎡", "만원/㎡");
assert(formatWonPerPyeong(10075.8) === "1억 76만원/평", `els v2.1 ${formatWonPerPyeong(10075.8)}`);
assert(formatWonPerPyeong(10142) === "1억 142만원/평", "dong display");
assert(formatWonPerPyeong(6741.6) === "6,742만원/평", "gu display");
assert(formatWonPerPyeong(3575) === "3,575만원/평", "seoul display");
assert(formatReferenceMonthLabel("2026-09") === "2026년 9월 기준", "reference month from API");
assert(formatReferenceMonthLabel(null) === null, "no hardcoded month");
assert(formatSignedPct(3.42) === "+3.42%", "33평 6M complex");
assert(formatSignedPct(0.91) === "+0.91%", "33평 1Y complex");
assert(formatSignedPct(23.15) === "+23.15%", "33평 2Y complex");
assert(formatSignedPct(32.21) === "+32.21%", "33평 5Y complex");
assert(formatSignedPct(0) === "0%", "true zero stays signed only as 0%");

const els25 = selectedPyeongCompareLines({
  selectedPyeongLabel: "25평",
  supplyPyeongCohort: "20평대",
  referenceMonth: "2026-09",
});
assert(els25.line1 === "이 단지 25평 · 20평대 비교", `25평 copy ${els25.line1}`);
const els33 = selectedPyeongCompareLines({
  selectedPyeongLabel: "84㎡",
  selectedMarketPyeongLabel: 33,
  supplyPyeongCohort: "30평대",
  referenceMonth: "2026-09",
});
assert(els33.line1 === "이 단지 33평 · 30평대 비교", `33평 copy ${els33.line1}`);
assert(!String(els33.line1).includes("84"), "no exclusive ㎡ as selected 평");
assert(els33.line2 === "2026년 9월 기준", "month stays on API");
const els45 = selectedPyeongCompareLines({
  selectedPyeongLabel: "45평",
  supplyPyeongCohort: "40평대",
  referenceMonth: "2026-09",
});
assert(els45.line1 === "이 단지 45평 · 40평대 비교", `45평 copy ${els45.line1}`);
assert(!String(els45.line1).includes("45평대"), "never 45평대 비교");
assert(
  selectedPyeongCompareLines({
    selectedPyeongLabel: "45평",
    supplyPyeongCohort: null,
    referenceMonth: "2026-09",
  }).line1 !== "이 단지 45평 · 40평대 비교",
  "client does not invent decade cohort",
);
assert(rankingSelectedHeading({ pyeongLabel: "33평", rankingBand: "84" }) === "33평", "rank heading uses supply label");
assert(rankingSelectedHeading({ pyeongLabel: null, rankingBand: "84" }) === "84㎡", "rank heading falls back to ranking band, not invented 평");

const v1Rejected = parseComplexPricePosition(
  {
    status: "ok",
    priceLevel: [
      { scope: "COMPLEX", label: "이 단지", medianPricePerPyeong: 12949.7, status: "ok" },
    ],
    trends: { "3M": [{ scope: "COMPLEX", changePercent: 1.82, status: "ok" }] },
  },
  "cx_4c63d9a100973c60",
);
assert(v1Rejected.version == null, "V1 has no public version");
assert(v1Rejected.status === "unavailable", "V1 is not a fallback");
assert(v1Rejected.priceLevel.length === 0, "V1 prices stay hidden");

const v2Rejected = parseComplexPricePosition(
  {
    status: "ok",
    version: "price-position-v2",
    complexId: "cx_4c63d9a100973c60",
    supplyPyeongCohort: "30평대",
    referenceMonth: "2026-09",
    priceLevel: [
      { scope: "COMPLEX", label: "이 단지", meanPricePerSupplyPyeong: 10075.8, status: "ok" },
    ],
    trends: {
      "3M": [{ scope: "COMPLEX", changePercent: -1.34, status: "ok" }],
      "6M": [{ scope: "COMPLEX", changePercent: 2.12, status: "ok" }],
      "3Y": [{ scope: "COMPLEX", changePercent: 38.88, status: "ok" }],
    },
  },
  "cx_4c63d9a100973c60",
);
assert(v2Rejected.version == null, "V2 is not public");
assert(v2Rejected.status === "unavailable", "V2 is not a fallback");
assert(v2Rejected.priceLevel.length === 0, "V2 prices stay hidden");
assert(v2Rejected.trends["6M"].length === 0, "V2 trends stay hidden");

const v21Body = parseComplexPricePosition(
  {
    status: "ok",
    version: PRICE_POSITION_V21_VERSION,
    complexId: "cx_4c63d9a100973c60",
    aptName: "잠실엘스",
    supplyPyeongCohort: "30평대",
    selectedMarketPyeongLabel: 33,
    complexScopeBasis: "exact_market_pyeong_label",
    referenceMonth: "2026-09",
    areaBasis: "SUPPLY_PYEONG_LABEL",
    methodologyCopy: {
      price: PRICE_LEVEL_TIP,
      trend: TREND_TIP,
    },
    priceLevel: [
      { scope: "COMPLEX", label: "이 단지", meanPricePerSupplyPyeong: 10075.8, status: "ok" },
      { scope: "DONG", label: "잠실동", meanPricePerSupplyPyeong: 10142, status: "ok" },
      { scope: "GU", label: "송파구", meanPricePerSupplyPyeong: 6741.6, status: "ok" },
      { scope: "SEOUL", label: "서울", meanPricePerSupplyPyeong: 3575, status: "ok" },
    ],
    trends: {
      "6M": [{ scope: "COMPLEX", changePercent: 3.42, status: "ok" }],
      "1Y": [{ scope: "COMPLEX", changePercent: 0.91, status: "ok" }],
      "2Y": [
        {
          scope: "COMPLEX",
          changePercent: 23.15,
          currentMonth: "2026-09",
          baselineMonth: "2024-09",
          actualCurrentMonth: "2026-09",
          actualBaselineMonth: "2024-08",
          status: "ok",
        },
      ],
      "5Y": [{ scope: "COMPLEX", changePercent: 32.21, status: "ok" }],
      "3M": [{ scope: "COMPLEX", changePercent: -1.34, status: "ok" }],
      "3Y": [{ scope: "COMPLEX", changePercent: 38.88, status: "ok" }],
    },
  },
  "cx_4c63d9a100973c60",
);
assert(v21Body.version === "price-position-v2.1", "V2.1 pointer only");
assert(v21Body.selectedMarketPyeongLabel === 33, "exact 33평 from API");
assert(v21Body.supplyPyeongCohort === "30평대", "region cohort from API");
assert(v21Body.complexScopeBasis === "exact_market_pyeong_label", "complex is exact label");
assert(v21Body.priceLevel[0]?.meanPricePerSupplyPyeong === 10075.8, "Els 33평 API price");
assert(v21Body.trends["6M"][0]?.changePercent === 3.42, "Els 6M API");
assert(v21Body.trends["1Y"][0]?.changePercent === 0.91, "Els 1Y API");
assert(v21Body.trends["2Y"][0]?.changePercent === 23.15, "Els 2Y API");
assert(v21Body.trends["5Y"][0]?.changePercent === 32.21, "Els 5Y API");
assert(!("3M" in v21Body.trends), "parsed trends drop 3M");
assert(!("3Y" in v21Body.trends), "parsed trends drop 3Y");
assert(v21Body.methodologyCopy.price === PRICE_LEVEL_TIP, "API methodology price copy");
assert(v21Body.methodologyCopy.trend === TREND_TIP, "API methodology trend copy");

const s1Note = trendEndpointFallbackNote(v21Body.trends["2Y"][0]!);
assert(s1Note === "비교월 2024.09 → 2024.08", `S1 note ${s1Note}`);
assert(!String(s1Note).includes("오류"), "S1 is metadata, not an error");
assert(trendHorizonFallbackNotes(v21Body.trends["2Y"]).join("|") === "비교월 2024.09 → 2024.08", "horizon S1 notes");
assert(trendHorizonFallbackNotes(v21Body.trends["6M"]).length === 0, "exact month has no fallback note");

const elsPrice = [
  { status: "ok", value: 10075.8 },
  { status: "ok", value: 10142 },
  { status: "ok", value: 6741.6 },
  { status: "ok", value: 3575 },
];
assert(priceLevelScale(elsPrice) === 10142, "scale uses available max, no score transform");
assert(barWidthPct(10142, 10142) === 100, "dong bar full when max");
assert(Math.round(barWidthPct(6741.6, 10142)) === 66, "gu bar proportional");
assert(barWidthPct(null, 10142) === 0, "missing value has no bar");

const els6m = [
  { status: "ok" as const, changePercent: 3.42 },
  { status: "ok" as const, changePercent: 2.75 },
  { status: "ok" as const, changePercent: 1.76 },
];
assert(trendAbsScale(els6m) === 3.42, "trend scale from available max abs, not API COMPLEX-only max");
assert(trendBarLayout(-1.34, 3.42).side === "left", "negative left");
assert(trendBarLayout(3.42, 3.42).pct === 100, "max abs fills");
assert(trendBarLayout(0, 3.42).side === "none", "true zero has no bar");
assert(trendBarLayout(null, 3.42).side === "none", "insufficient not drawn as 0");

const mixed = [
  { status: "ok" as const, changePercent: 3.42 },
  { status: "INSUFFICIENT_SAMPLE" as const, changePercent: null },
  { status: "unavailable" as const, changePercent: null },
];
assert(trendAbsScale(mixed) === 3.42, "sparse/unavailable rows excluded from scale");
assert(INSUFFICIENT_SAMPLE_COPY === "표본 부족", "sample copy");
assert(priceCompareRowCopy("INSUFFICIENT_SAMPLE") === "표본 부족", "row sparse copy");
assert(priceCompareRowCopy("unavailable") === PRICE_COMPARE_UNAVAILABLE_ROW_COPY, "row unavailable copy");
assert(
  priceCompareStatusCopy("PRICE_COMPARE_UNSUPPORTED_AREA").title === PRICE_COMPARE_UNSUPPORTED_COPY,
  "unsupported area is a product state",
);
assert(
  priceCompareStatusCopy("unavailable").title === RANK_PREPARING_COPY,
  "unavailable stays preparing, not inferred as small cohort",
);

const sparseKept = parseComplexPricePosition(
  {
    status: "ok",
    version: PRICE_POSITION_V21_VERSION,
    supplyPyeongCohort: "30평대",
    selectedMarketPyeongLabel: 33,
    priceLevel: [
      { scope: "COMPLEX", label: "이 단지", meanPricePerSupplyPyeong: 10075.8, status: "ok" },
      { scope: "DONG", label: "잠실동", meanPricePerSupplyPyeong: null, status: "INSUFFICIENT_SAMPLE" },
      { scope: "GU", label: "송파구", meanPricePerSupplyPyeong: 6741.6, status: "ok" },
      { scope: "SEOUL", label: "서울", meanPricePerSupplyPyeong: null, status: "unavailable" },
    ],
    trends: { "6M": [], "1Y": [], "2Y": [], "5Y": [] },
  },
  "cx_4c63d9a100973c60",
);
assert(sparseKept.status === "ok", "one sparse region does not fail the card");
assert(sparseKept.priceLevel.length === 4, "all region rows stay visible");
assert(sparseKept.priceLevel[1]?.status === "INSUFFICIENT_SAMPLE", "dong sparse status");
assert(sparseKept.priceLevel[3]?.status === "unavailable", "seoul unavailable status");

console.log("ok: region-ranking-ui");

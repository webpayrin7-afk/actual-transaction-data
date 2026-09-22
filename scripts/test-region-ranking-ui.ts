/**
 * Presentation-only ranking UI tests. No scoring, no DB writes.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  RANKING_V3_VERSION,
  decadeCohortForLabel,
} from "../src/lib/region-ranking/ranking-v3";
import {
  COMPLEX_EXACT_TIP,
  INSUFFICIENT_SAMPLE_COPY,
  PRICE_COMPARE_TABS,
  PRICE_COMPARE_UNAVAILABLE_ROW_COPY,
  PRICE_COMPARE_UNSUPPORTED_COPY,
  PRICE_LEVEL_TIP,
  PRICE_POSITION_V21_VERSION,
  PRICE_POSITION_V23_VERSION,
  PRICE_POSITION_V231_VERSION,
  TREND_SAMPLE_FORBIDDEN_COPY,
  TREND_SAMPLE_LIMITED_COPY,
  TREND_SAMPLE_SEVERELY_LIMITED_COPY,
  TREND_SAMPLE_TIP,
  TREND_SAMPLE_TIP_TITLE,
  PARTIAL_HISTORY_COPY,
  PARTIAL_HISTORY_TIP,
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
  monthsInYearMonthWindow,
  parseComplexPricePosition,
  parseMarketPyeongLabelParam,
  partialHistoryHelperCopy,
  DECADE_RANK_UNAVAILABLE_COPY,
  PRICE_COMPARE_TIP,
  PRICE_COMPARE_TIP_TITLE,
  PRICE_COMPARE_TITLE,
  ZIPLAB_RANK_TIP,
  ZIPLAB_RANK_TIP_TITLE,
  ZIPLAB_RANK_TITLE,
  placeHeadline,
  placeRankDisplay,
  priceCompareMetaLine,
  priceCompareScopeLabel,
  rankingDecadeRowLabel,
  priceCompareRowCopy,
  priceCompareStatusCopy,
  priceLevelScale,
  rankingBandForArea,
  rankingSelectedHeading,
  selectedMarketPyeongInteger,
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
  trendSampleStatusLabel,
  isTrendHorizonUnavailable,
  unavailableBoardCopy,
  type ComplexRankPlace,
  type RegionRankingRow,
} from "../src/lib/region-ranking/public";
import { SAMPLE_CONFIDENCE_VERSION } from "../src/lib/region-ranking/sample-confidence-v2";

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
assert(guLine?.meta == null, `gu meta hidden ${guLine?.meta}`);
const dongLine = placeHeadline({ regionName: "잠실동", place: dong });
assert(dongLine?.title === "잠실동 3위", `dong title ${dongLine?.title}`);
assert(dongLine?.meta == null, `dong meta hidden ${dongLine?.meta}`);
assert(!JSON.stringify(dongLine).includes("smallCohort"), "no raw smallCohort");
assert(!JSON.stringify(guLine).includes("단지 중"), "no population count on gu");
assert(!JSON.stringify(dongLine).includes("비교 가능"), "no 비교 가능 on dong");
assert(!JSON.stringify(dongLine).includes("순위 산정"), "no 순위 산정 on dong");
const stacked = placeRankDisplay({ regionName: "송파구", place: guPlace });
assert(stacked?.region === "송파구" && stacked.rank === 3, `stacked ${JSON.stringify(stacked)}`);
assert(DECADE_RANK_UNAVAILABLE_COPY === "해당 평형대 순위 없음", "unavailable decade copy");
const helper = dongSmallCohortHelper({
  dongName: "잠실동",
  places: [dong, dong],
});
assert(
  helper === "잠실동 순위 · 비교 가능한 6개 단지 기준",
  `helper ${helper}`,
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
assert(placeRankDisplay({ regionName: "서초구", place: unavailable }) === null, "stacked unavailable");
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
  regionOverviewCtaLabel("송파구") === "송파구 지역 순위 보기",
  "CTA renamed to 지역 순위 보기",
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
assert(formatWonPerPyeong(10075.7576) === "10,076만원/평", `els 33평 ${formatWonPerPyeong(10075.7576)}`);
assert(formatWonPerPyeong(10075.8) === "10,076만원/평", `els rounded ${formatWonPerPyeong(10075.8)}`);
assert(formatWonPerPyeong(9706) === "9,706만원/평", "만원/평 no eok");
assert(formatWonPerPyeong(5766) === "5,766만원/평", "gu 만원/평");
assert(formatWonPerPyeong(2809) === "2,809만원/평", "seoul 만원/평");
assert(!String(formatWonPerPyeong(10075.7576)).includes("억"), "compare UI never uses 억");
assert(formatReferenceMonthLabel("2026-08") === "2026년 8월 기준", "reference month from API");
assert(formatReferenceMonthLabel(null) === null, "no hardcoded month");
assert(formatSignedPct(3.42) === "+3.42%", "33평 6M complex");
assert(formatSignedPct(0.91) === "+0.91%", "33평 1Y complex");
assert(formatSignedPct(23.15) === "+23.15%", "33평 2Y complex");
assert(formatSignedPct(32.21) === "+32.21%", "33평 5Y complex");
assert(formatSignedPct(0) === "0%", "true zero stays signed only as 0%");

assert(selectedMarketPyeongInteger({ marketLabel: 33 }) === 33, "selector marketLabel 33");
assert(selectedMarketPyeongInteger({ marketLabel: 25 }) === 25, "selector marketLabel 25");
assert(selectedMarketPyeongInteger({ marketLabel: 45 }) === 45, "selector marketLabel 45");
assert(
  selectedMarketPyeongInteger({ selectedPyeongLabel: "33평" }) === 33,
  "selector confirmed 33평 label",
);
assert(
  selectedMarketPyeongInteger({ marketLabel: 33, selectedPyeongLabel: "34평" }) === 33,
  "marketLabel wins over a rematched 34평",
);
assert(selectedMarketPyeongInteger({ selectedPyeongLabel: "84㎡" }) === null, "no 84㎡→평");
assert(selectedMarketPyeongInteger({}) === null, "no invented pyeong");
assert(parseMarketPyeongLabelParam("33") === 33, "API param 33");
assert(parseMarketPyeongLabelParam("34.2") === 34, "API param rounds");
assert(parseMarketPyeongLabelParam("0") === null, "reject zero label");

const els25 = selectedPyeongCompareLines({
  selectedPyeongLabel: "25평",
  supplyPyeongCohort: "20평대",
  referenceMonth: "2026-08",
});
assert(els25.line1 === "25평 · 20평대 비교 · 2026.08 기준", `25평 copy ${els25.line1}`);
const els33 = selectedPyeongCompareLines({
  selectedPyeongLabel: "33평",
  selectedMarketPyeongLabel: 34,
  supplyPyeongCohort: "30평대",
  referenceMonth: "2026-08",
});
assert(els33.line1 === "33평 · 30평대 비교 · 2026.08 기준", `33평 copy ${els33.line1}`);
assert(!String(els33.line1).includes("34평"), "selector 33평 wins over rematched 34평");
assert(els33.line2 == null, "compact subtitle is one line");
const els45 = selectedPyeongCompareLines({
  selectedPyeongLabel: "45평",
  supplyPyeongCohort: "40평대",
  referenceMonth: "2026-08",
});
assert(els45.line1 === "45평 · 40평대 비교 · 2026.08 기준", `45평 copy ${els45.line1}`);
assert(!String(els45.line1).includes("45평대"), "never 45평대 비교");
assert(
  selectedPyeongCompareLines({
    selectedPyeongLabel: "45평",
    supplyPyeongCohort: null,
    referenceMonth: "2026-09",
  }).line1 === "45평 · 2026.09 기준",
  "client does not invent decade cohort",
);
assert(rankingSelectedHeading({ pyeongLabel: "33평" }) === null, "no 33평 heading without API decade");
assert(rankingSelectedHeading({ pyeongLabel: null }) === null, "no 84㎡ fallback");
assert(
  rankingSelectedHeading({ pyeongLabel: "33평", rankingCohortLabel: "30평대" }) === "30평대 순위",
  "drop selected 평 from decade rank heading",
);
assert(
  !String(rankingSelectedHeading({ pyeongLabel: "33평", rankingCohortLabel: "30평대" })).includes("33평"),
  "33평 is not in the decade heading",
);
assert(
  rankingSelectedHeading({ pyeongLabel: "24평", rankingCohortLabel: "20평대" }) === "20평대 순위",
  "20평대 heading",
);
assert(
  rankingSelectedHeading({ pyeongLabel: "43평", rankingCohortLabel: "40평대" }) === "40평대 순위",
  "40평대 heading",
);
assert(
  rankingSelectedHeading({ pyeongLabel: "102평", rankingCohortLabel: "100평+" }) === "100평+ 순위",
  "100평+ heading stays API semantic",
);
assert(rankingDecadeRowLabel("30평대") === "30평대", "row label drops 순위");
assert(rankingDecadeRowLabel("30평대 순위") === "30평대", "row label strips suffix");
assert(rankingDecadeRowLabel(null) === null, "no invented decade row");
assert(
  priceCompareMetaLine({ supplyPyeongCohort: "30평대", referenceMonth: "2026-09" }) ===
    "30평대 기준 · 2026.09 기준",
  "price meta uses cohort + month only",
);
assert(
  !String(
    priceCompareMetaLine({ supplyPyeongCohort: "30평대", referenceMonth: "2026-09" }),
  ).includes("33평"),
  "price meta does not repeat selected 평",
);
assert(
  priceCompareMetaLine({ supplyPyeongCohort: "20평대", referenceMonth: "2026-09" }) ===
    "20평대 기준 · 2026.09 기준",
  "20평대 meta",
);
assert(
  priceCompareMetaLine({ supplyPyeongCohort: "40평대", referenceMonth: "2026-09" }) ===
    "40평대 기준 · 2026.09 기준",
  "40평대 meta",
);
assert(ZIPLAB_RANK_TITLE === "집랩 순위", "ranking subtitle");
assert(PRICE_COMPARE_TITLE === "가격 비교", "price subtitle");
assert(ZIPLAB_RANK_TIP_TITLE === "집랩 순위란?", "rank tip title");
assert(PRICE_COMPARE_TIP_TITLE === "가격 비교란?", "price tip title");
assert(ZIPLAB_RANK_TIP.includes("거래 가격"), "rank tip signals price");
assert(ZIPLAB_RANK_TIP.includes("평형대"), "rank tip names decade cohort");
assert(!ZIPLAB_RANK_TIP.includes("인기"), "no popularity signal");
assert(!ZIPLAB_RANK_TIP.includes("조회수"), "no views signal");
assert(!ZIPLAB_RANK_TIP.includes("관심도"), "no interest signal");
assert(!ZIPLAB_RANK_TIP.includes("fingerprint"), "no internal fingerprint");
assert(!ZIPLAB_RANK_TIP.includes("가장 정확한"), "no overclaim");
assert(!ZIPLAB_RANK_TIP.includes("투자가치"), "no investment claim");
assert(
  priceCompareScopeLabel({ scope: "COMPLEX", label: "이 단지", aptName: "잠실엘스" }) === "잠실엘스",
  "COMPLEX uses apt name",
);
assert(
  priceCompareScopeLabel({ scope: "COMPLEX", label: "이 단지", aptName: "헬리오시티" }) === "헬리오시티",
  "COMPLEX uses current apt name, not a hardcoded 단지",
);
assert(
  priceCompareScopeLabel({ scope: "DONG", label: "잠실동", aptName: "잠실엘스" }) === "잠실동",
  "dong keeps region label",
);
assert(
  priceCompareScopeLabel({ scope: "COMPLEX", label: "이 단지", aptName: null }) === "—",
  "no invented 이 단지 when name is missing",
);
assert(PRICE_COMPARE_TIP.includes("선택한 평형"), "price tip uses selected 평 for complex");
assert(PRICE_COMPARE_TIP.includes("같은 평형대"), "price tip uses decade for region");
assert(PRICE_COMPARE_TIP.includes("변동률 중앙값"), "price tip names regional median semantics");
assert(!PRICE_COMPARE_TIP.includes("canonical"), "no internal canonical term");
assert(!PRICE_COMPARE_TIP.includes("공급면적"), "price tip does not lead with supply jargon");

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

const v21Rejected = parseComplexPricePosition(
  {
    status: "ok",
    version: PRICE_POSITION_V21_VERSION,
    complexId: "cx_4c63d9a100973c60",
    supplyPyeongCohort: "30평대",
    selectedMarketPyeongLabel: 33,
    referenceMonth: "2026-09",
    priceLevel: [
      { scope: "COMPLEX", label: "이 단지", meanPricePerSupplyPyeong: 10075.8, status: "ok" },
    ],
    trends: {
      "1Y": [
        { scope: "DONG", label: "잠실동", changePercent: 0.91, status: "ok" },
        { scope: "GU", label: "송파구", changePercent: 15.42, status: "ok" },
        { scope: "SEOUL", label: "서울", changePercent: 15.26, status: "ok" },
      ],
    },
  },
  "cx_4c63d9a100973c60",
);
assert(v21Rejected.version == null, "V2.1 is not public");
assert(v21Rejected.status === "unavailable", "V2.1 is not a fallback");
assert(v21Rejected.priceLevel.length === 0, "V2.1 prices stay hidden");
assert(v21Rejected.trends["1Y"].length === 0, "V2.1 stale 1Y stays hidden");

const v22Rejected = parseComplexPricePosition(
  {
    status: "ok",
    version: "price-position-v2.2",
    trends: { "1Y": [{ scope: "DONG", changePercent: 0.91, status: "ok" }] },
  },
  "cx_4c63d9a100973c60",
);
assert(v22Rejected.status === "unavailable", "V2.2 is not a fallback");

const v23Rejected = parseComplexPricePosition(
  {
    status: "ok",
    version: PRICE_POSITION_V23_VERSION,
    trends: {
      "1Y": [{ scope: "DONG", changePercent: 5.03, status: "ok", sampleStatus: "THIN" }],
    },
  },
  "cx_4c63d9a100973c60",
);
assert(v23Rejected.status === "unavailable", "V2.3 is not a fallback");
assert(v23Rejected.trends["1Y"].length === 0, "V2.3 sample grades stay hidden");

const v231Body = parseComplexPricePosition(
  {
    status: "ok",
    version: PRICE_POSITION_V231_VERSION,
    complexId: "cx_4c63d9a100973c60",
    aptName: "잠실엘스",
    supplyPyeongCohort: "30평대",
    selectedMarketPyeongLabel: 33,
    complexScopeBasis: "exact_market_pyeong_label",
    referenceMonth: "2026-09",
    areaBasis: "SUPPLY_PYEONG_LABEL",
    sampleConfidenceVersion: SAMPLE_CONFIDENCE_VERSION,
    methodologyCopy: {
      price: PRICE_LEVEL_TIP,
      trend: TREND_TIP,
    },
    priceLevel: [
      { scope: "COMPLEX", label: "이 단지", meanPricePerSupplyPyeong: 10075.7576, status: "ok" },
      { scope: "DONG", label: "잠실동", meanPricePerSupplyPyeong: 10142, status: "ok" },
      { scope: "GU", label: "송파구", meanPricePerSupplyPyeong: 6741.6, status: "ok" },
      { scope: "SEOUL", label: "서울", meanPricePerSupplyPyeong: 3575, status: "ok" },
    ],
    trends: {
      "6M": [
        { scope: "COMPLEX", changePercent: 3.42, status: "ok" },
        {
          scope: "DONG",
          changePercent: 1.2,
          status: "ok",
          sampleStatus: "SAMPLE_LIMITED",
          windowStatus: "FULL_WINDOW",
          currentWindow: "2026-04..2026-09",
          baselineWindow: "2025-10..2026-03",
        },
      ],
      "1Y": [
        { scope: "COMPLEX", label: "이 단지", changePercent: 0.91, status: "ok" },
        {
          scope: "DONG",
          label: "잠실동",
          changePercent: 5.03,
          status: "ok",
          sampleStatus: "SAMPLE_ADEQUATE",
          windowStatus: "FULL_WINDOW",
          matchedComplexCount: 8,
          matchedCoverageRatio: 0.6154,
        },
        {
          scope: "GU",
          label: "송파구",
          changePercent: 20.84,
          status: "ok",
          sampleStatus: "SAMPLE_ADEQUATE",
          windowStatus: "FULL_WINDOW",
          matchedComplexCount: 76,
        },
        {
          scope: "SEOUL",
          label: "서울",
          changePercent: 12.4,
          status: "ok",
          sampleStatus: "SAMPLE_ADEQUATE",
          windowStatus: "FULL_WINDOW",
          matchedComplexCount: 1622,
        },
      ],
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
      "5Y": [
        {
          scope: "DONG",
          changePercent: 45.71,
          status: "ok",
          sampleStatus: "SAMPLE_LIMITED",
          windowStatus: "PARTIAL_HISTORY_WINDOW",
          currentWindow: "2026-07..2026-09",
          baselineWindow: "2021-07..2021-09",
        },
        {
          scope: "GU",
          changePercent: 27.17,
          status: "ok",
          sampleStatus: "SAMPLE_LIMITED",
          windowStatus: "PARTIAL_HISTORY_WINDOW",
          currentWindow: "2026-07..2026-09",
          baselineWindow: "2021-07..2021-09",
        },
        {
          scope: "SEOUL",
          changePercent: 7.83,
          status: "ok",
          sampleStatus: "SAMPLE_ADEQUATE",
          windowStatus: "PARTIAL_HISTORY_WINDOW",
          currentWindow: "2026-07..2026-09",
          baselineWindow: "2021-07..2021-09",
        },
        {
          scope: "COMPLEX",
          changePercent: null,
          status: "unavailable",
          sampleStatus: "HORIZON_UNAVAILABLE",
        },
      ],
      "3M": [{ scope: "COMPLEX", changePercent: -1.34, status: "ok" }],
      "3Y": [{ scope: "COMPLEX", changePercent: 38.88, status: "ok" }],
    },
  },
  "cx_4c63d9a100973c60",
);
assert(v231Body.version === "price-position-v2.3.1", "V2.3.1 pointer only");
assert(v231Body.selectedMarketPyeongLabel === 33, "exact 33평 from API");
assert(v231Body.supplyPyeongCohort === "30평대", "region cohort from API");
assert(v231Body.complexScopeBasis === "exact_market_pyeong_label", "complex is exact label");
assert(v231Body.priceLevel[0]?.meanPricePerSupplyPyeong === 10075.7576, "Els 33평 API price");
assert(v231Body.referenceMonth === "2026-09", "reference month from API");
assert(v231Body.trends["1Y"][0]?.changePercent === 0.91, "Els 1Y complex");
assert(v231Body.trends["1Y"][1]?.changePercent === 5.03, "Els 1Y dong V2.3.1");
assert(v231Body.trends["1Y"][2]?.changePercent === 20.84, "Els 1Y gu V2.3.1");
assert(v231Body.trends["1Y"][3]?.changePercent === 12.4, "Els 1Y seoul V2.3.1");
assert(v231Body.trends["1Y"][1]?.sampleStatus === "SAMPLE_ADEQUATE", "dong 1Y ADEQUATE");
assert(v231Body.trends["1Y"][2]?.sampleStatus === "SAMPLE_ADEQUATE", "gu 1Y ADEQUATE");
assert(v231Body.trends["1Y"][3]?.sampleStatus === "SAMPLE_ADEQUATE", "seoul 1Y ADEQUATE");
assert(v231Body.trends["5Y"][0]?.changePercent === 45.71, "Els 5Y dong");
assert(v231Body.trends["5Y"][0]?.sampleStatus === "SAMPLE_LIMITED", "dong 5Y LIMITED");
assert(v231Body.trends["5Y"][0]?.windowStatus === "PARTIAL_HISTORY_WINDOW", "dong 5Y partial");
assert(v231Body.trends["5Y"][1]?.changePercent === 27.17, "Els 5Y gu");
assert(v231Body.trends["5Y"][2]?.changePercent === 7.83, "Els 5Y seoul");
assert(v231Body.trends["5Y"][2]?.sampleStatus === "SAMPLE_ADEQUATE", "seoul 5Y ADEQUATE");
assert(!("3M" in v231Body.trends), "parsed trends drop 3M");
assert(!("3Y" in v231Body.trends), "parsed trends drop 3Y");
assert(v231Body.methodologyCopy.price === PRICE_LEVEL_TIP, "API methodology price copy");
assert(v231Body.methodologyCopy.trend === TREND_TIP, "API methodology trend copy");

assert(
  trendSampleStatusLabel({ scope: "COMPLEX", sampleStatus: "SAMPLE_LIMITED" }) == null,
  "complex has no sample badge",
);
assert(
  trendSampleStatusLabel({ scope: "DONG", sampleStatus: "SAMPLE_ADEQUATE" }) == null,
  "ADEQUATE is silent",
);
assert(
  trendSampleStatusLabel({ scope: "DONG", sampleStatus: "SAMPLE_LIMITED" }) ===
    TREND_SAMPLE_LIMITED_COPY,
  "LIMITED copy",
);
assert(
  trendSampleStatusLabel({ scope: "GU", sampleStatus: "SAMPLE_SEVERELY_LIMITED" }) ===
    TREND_SAMPLE_SEVERELY_LIMITED_COPY,
  "SEVERELY_LIMITED copy",
);
assert(
  trendSampleStatusLabel({ scope: "SEOUL", sampleStatus: "HORIZON_UNAVAILABLE" }) == null,
  "HORIZON_UNAVAILABLE has no sample badge",
);
assert(TREND_SAMPLE_LIMITED_COPY === "표본 제한", "limited label");
assert(TREND_SAMPLE_SEVERELY_LIMITED_COPY === "참고용", "severely limited label");
assert(!TREND_SAMPLE_FORBIDDEN_COPY.some((copy) => TREND_SAMPLE_TIP.includes(copy)), "tip avoids forbidden copy");
assert(TREND_SAMPLE_TIP_TITLE === "표본 안내", "sample tip title");
assert(TREND_SAMPLE_TIP.includes("같은 지역·평형대"), "sample tip explains regional matched set");
assert(!TREND_SAMPLE_TIP.includes("8/13"), "sample tip has no counts");
assert(!TREND_SAMPLE_TIP.includes("%"), "sample tip has no coverage %");
assert(monthsInYearMonthWindow("2026-07..2026-09") === 3, "partial 5Y window is 3 months");
assert(monthsInYearMonthWindow("2026-04..2026-09") === 6, "full 6M window is 6 months");
assert(PARTIAL_HISTORY_COPY === "일부 기간 기준", "unified partial copy");
assert(
  partialHistoryHelperCopy({ horizonLabel: "5년", cells: v231Body.trends["5Y"] }) ===
    "5년 · 일부 기간 기준",
  "5Y partial helper once per horizon",
);
assert(PARTIAL_HISTORY_TIP.includes("확보된 기간"), "partial tip explains window");
assert(
  partialHistoryHelperCopy({ horizonLabel: "6개월", cells: v231Body.trends["6M"] }) == null,
  "FULL_WINDOW has no helper",
);
assert(
  partialHistoryHelperCopy({ horizonLabel: "1년", cells: v231Body.trends["1Y"] }) == null,
  "1Y full window has no helper",
);
assert(
  isTrendHorizonUnavailable({
    status: "unavailable",
    changePercent: null,
    sampleStatus: "HORIZON_UNAVAILABLE",
  }),
  "HORIZON_UNAVAILABLE renders empty",
);
assert(
  !isTrendHorizonUnavailable({
    status: "ok",
    changePercent: 7.83,
    sampleStatus: "SAMPLE_ADEQUATE",
  }),
  "available trend keeps its value",
);

const s1Note = trendEndpointFallbackNote(v231Body.trends["2Y"][0]!);
assert(s1Note === "비교월 2024.09 → 2024.08", `S1 note ${s1Note}`);
assert(!String(s1Note).includes("오류"), "S1 is metadata, not an error");
assert(trendHorizonFallbackNotes(v231Body.trends["2Y"]).join("|") === "비교월 2024.09 → 2024.08", "horizon S1 notes");
assert(trendHorizonFallbackNotes(v231Body.trends["6M"]).length === 0, "exact month has no fallback note");

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
    version: PRICE_POSITION_V231_VERSION,
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

assert(RANKING_V3_VERSION === "seoul-ranking-v3", "v3 version pointer");
assert(decadeCohortForLabel(33)?.key === "30", "33 → 30 decade");
assert(decadeCohortForLabel(33)?.label === "30평대", "33 → 30평대");
assert(decadeCohortForLabel(24)?.label === "20평대", "24 → 20평대");
assert(decadeCohortForLabel(43)?.label === "40평대", "43 → 40평대");
assert(decadeCohortForLabel(55)?.label === "50평대", "55 → 50평대");
assert(decadeCohortForLabel(102)?.label === "100평+", "102 → 100평+");
assert(decadeCohortForLabel(9) == null, "below 10 is unavailable decade");

const rankSection = readFileSync(
  resolve(import.meta.dirname, "../src/components/apt/ComplexRegionRankSection.tsx"),
  "utf8",
);
assert(!rankSection.includes("rankingBandForArea"), "selected ranking no longer remaps exclusive bands");
assert(!rankSection.includes('areaBand: "84"'), "no hardcoded 84");
assert(!rankSection.includes("59/84/114"), "no legacy band comment in card");
assert(rankSection.includes("지역 내 비교"), "top section title");
assert(rankSection.includes("ZIPLAB_RANK_TITLE"), "집랩 순위 subtitle");
assert(
  rankSection.includes("detail-subsection-title"),
  "집랩 순위 uses the detail subsection title",
);
assert(rankSection.includes('label="종합 순위"'), "overall is a rank row");
assert(rankSection.includes(" 순위"), "decade row appends 순위");
assert(!rankSection.includes('label="종합"'), "no bare 종합 row label");
assert(!rankSection.includes("rankingSelectedHeading"), "no decade subsection heading");
assert(rankSection.includes("rankingDecadeRowLabel"), "decade row from API");
assert(rankSection.includes("formatRankingAsOf"), "ranking date stays on 집랩 순위");
assert(
  /<h2[\s\S]*?>\s*지역 내 비교\s*<\/h2>/.test(rankSection),
  "top heading has no merged as-of date",
);
assert(rankSection.includes("complex-region-rank-v3"), "v3 query key");
assert(!rankSection.includes("개 단지 중"), "card has no population copy");
assert(!rankSection.includes("비교 가능"), "card has no 비교 가능");
assert(!rankSection.includes("순위 산정"), "card has no 순위 산정");
assert(rankSection.includes("DECADE_RANK_UNAVAILABLE_COPY"), "uses shared unavailable copy");
assert(rankSection.includes("placeRankDisplay"), "stacked rank display");
assert(!rankSection.includes("선택 평형 순위"), "no invented selected heading");
assert(!rankSection.includes("selectedPyeongCompareLines"), "rank card does not repeat 33평 · 30평대 비교");
assert(
  rankSection.includes("lab-button lab-button-primary detail-cta") &&
    rankSection.includes("→"),
  "region rank CTA is primary (matches trade-history CTA)",
);
assert(rankSection.includes("detail-compact-value"), "ranks use compact-value");
assert(
  rankSection.includes('data-event="complex_region_rank_cta"') &&
    /complex_region_rank_cta[\s\S]*?lab-button-primary/.test(rankSection),
  "region rank CTA link uses primary button",
);

const priceCompare = readFileSync(
  resolve(import.meta.dirname, "../src/components/apt/ComplexRegionPriceCompare.tsx"),
  "utf8",
);
assert(priceCompare.includes("PRICE_COMPARE_TITLE"), "가격 비교 subtitle");
assert(
  priceCompare.includes("detail-subsection-title"),
  "가격 비교 uses the detail subsection title",
);
assert(priceCompare.includes("PRICE_COMPARE_TIP"), "가격 비교 tooltip");
assert(priceCompare.includes("priceCompareMetaLine"), "cohort + month on title line");
assert(!priceCompare.includes("selectedPyeongCompareLines"), "no selected-평 subtitle");
assert(!priceCompare.includes("selectedPyeongLabel"), "no selected 평 prop");
assert(!priceCompare.includes("평당가"), "no standalone 평당가");
assert(!priceCompare.includes("지역 가격 비교"), "subtitle drops 지역");
assert(priceCompare.includes("priceCompareScopeLabel"), "COMPLEX row uses apt name");
assert(!/이 단지/.test(priceCompare), "price compare UI does not hardcode 이 단지");
assert(priceCompare.includes("PRICE_COMPARE_TABS"), "keeps 가격 수준 / 변동률");
assert(priceCompare.includes("detail-chart-gap"), "tab and chart share one gap token");
assert(priceCompare.includes("price-compare-bar-play"), "price bars animate on enter");
assert(priceCompare.includes("IntersectionObserver"), "chart plays when the section enters view");
const globalsCss = readFileSync(
  resolve(import.meta.dirname, "../src/app/globals.css"),
  "utf8",
);
assert(globalsCss.includes("price-compare-bar-grow"), "bar grow keyframes exist");
assert(globalsCss.includes("prefers-reduced-motion"), "reduced motion is respected");
assert(priceCompare.includes("TREND_PERIOD_TABS"), "keeps 6M/1Y/2Y/5Y");
assert(!priceCompare.includes('"3Y"'), "no 3Y period");
assert(priceCompare.includes("complex-region-price-position-v231"), "v2.3.1 query key");
assert(priceCompare.includes("trendSampleStatusLabel"), "trend sample status only");
assert(priceCompare.includes("partialHistoryHelperCopy"), "partial history helper");
assert(priceCompare.includes("PARTIAL_HISTORY_TIP"), "partial tip separate from sample tip");
assert(priceCompare.includes("isTrendHorizonUnavailable"), "unavailable horizons stay empty");
assert(priceCompare.includes("TREND_SAMPLE_TIP"), "sample tooltip is separate");
assert(!priceCompare.includes("matchedComplexCount"), "UI does not render matched counts");
assert(!priceCompare.includes("matchedCoverageRatio"), "UI does not render coverage %");
assert(!priceCompare.includes("8/13"), "no raw fraction");
assert(!priceCompare.includes("표본 적음"), "forbidden thin copy absent");
assert(!priceCompare.includes("표본 매우 적음"), "forbidden very thin copy absent");
assert(!priceCompare.includes("비교 표본 제한"), "forbidden coverage copy absent");
assert(
  priceCompare.lastIndexOf("{PRICE_COMPARE_TITLE}") <
    priceCompare.lastIndexOf("PRICE_COMPARE_TABS.map") &&
    priceCompare.lastIndexOf("{PRICE_COMPARE_TITLE}") > 0,
  "title/meta sit above tabs",
);
assert(priceCompare.includes("PRICE_UNIT"), "만원/평 unit token in header");
assert(priceCompare.includes("detail-data-value-emphasis"), "price values use data-value-emphasis");
assert(priceCompare.includes("space-y-1.5"), "price level stacks label/value then bar");
assert(priceCompare.includes("detail-change-up"), "trend deltas use change-up");
assert(priceCompare.includes("detail-change-down"), "trend deltas use change-down");
assert(!priceCompare.includes("function PriceFigure"), "unit no longer inline per row");
assert(
  !priceCompare.slice(
    priceCompare.indexOf("function PriceLevelBars"),
    priceCompare.indexOf("function TrendScale"),
  ).includes("trendSampleStatusLabel"),
  "price level has no sample-status UI",
);
assert(
  !priceCompare.slice(
    priceCompare.indexOf("function PriceLevelBars"),
    priceCompare.indexOf("function TrendScale"),
  ).includes("partialHistoryHelperCopy"),
  "price level has no history helper",
);

const priceRoute = readFileSync(
  resolve(import.meta.dirname, "../src/app/api/complex-region-price-position/route.ts"),
  "utf8",
);
assert(priceRoute.includes("market_pyeong_label"), "price API keeps selected label");
assert(priceRoute.includes("decadeCohortForLabel"), "price API stores decade from selected 평");
const priceRead = readFileSync(
  resolve(import.meta.dirname, "../src/lib/region-ranking/price-position-read.ts"),
  "utf8",
);
assert(priceRead.includes("PRICE_POSITION_V231_VERSION"), "read pointer is V2.3.1");
assert(priceRead.includes("pricePositionV231SnapshotId"), "reads V2.3.1 snapshot");
assert(!priceRead.includes("pricePositionV21SnapshotId"), "does not read V2.1 snapshot");
assert(!priceRead.includes("pricePositionV23SnapshotId()"), "does not read V2.3 snapshot as public");
assert(priceRead.includes("PRICE_POSITION_PUBLIC_VERSION = PRICE_POSITION_V231_VERSION"), "public pointer is V2.3.1");

const sampleConfidence = readFileSync(
  resolve(import.meta.dirname, "../src/lib/region-ranking/sample-confidence-v2.ts"),
  "utf8",
);
assert(sampleConfidence.includes('SAMPLE_CONFIDENCE_VERSION = "sample-confidence-v2"'), "confidence v2 version");
assert(sampleConfidence.includes("표본 제한"), "limited copy");
assert(sampleConfidence.includes("참고용"), "severely limited copy");
assert(!sampleConfidence.includes("표본 적음"), "no legacy thin copy");
assert(!sampleConfidence.includes("표본 매우 적음"), "no legacy very thin copy");

const infoTip = readFileSync(
  resolve(import.meta.dirname, "../src/components/ui/InfoTip.tsx"),
  "utf8",
);
assert(infoTip.includes("createPortal"), "tip panel escapes apt-detail transform clip");
assert(infoTip.includes("document.body"), "tip panel mounts on body");
assert(infoTip.includes("-inset-y-2.5"), "tip hit target expands without pushing the glyph");
assert(infoTip.includes("ml-[0.25em]"), "tip sits one space from its label");
assert(infoTip.includes("onClick"), "tip opens on tap/click");

const rankRoute = readFileSync(
  resolve(import.meta.dirname, "../src/app/api/complex-region-rank/route.ts"),
  "utf8",
);
assert(rankRoute.includes("market_pyeong_label"), "API accepts selected market label");
assert(rankRoute.includes("regionPyeongDecade"), "API exposes decade label");
assert(!rankRoute.includes('"59"'), "API does not accept legacy 59 for selected");
assert(!rankRoute.includes('"84"'), "API does not accept legacy 84 for selected");
assert(!rankRoute.includes('"114"'), "API does not accept legacy 114 for selected");

console.log("ok: region-ranking-ui");

/**
 * Complex Detail v1 server-side data contract (Phase 7.1).
 * UI (Phase 7.2) should consume this shape — all enrichment fields nullable.
 */

export type ComplexDetailIdentity = {
  complexId: string;
  aptName: string;
  aptNameNorm: string;
  sido: string | null;
  sigungu: string | null;
  legalDongName: string | null;
  jibun: string | null;
  roadAddress: string | null;
};

export type ComplexDetailBasic = {
  householdCount: number | null;
  buildingCount: number | null;
  approvalDate: string | null;
  heatingType: string | null;
  managementType: string | null;
  parkingTotal: number | null;
  parkingPerHousehold: number | null;
};

export type ComplexDetailBuilding = {
  maxFloor: number | null;
  structureType: string | null;
  mainPurpose: string | null;
  farRatio: number | null;
  bcrRatio: number | null;
  landAreaSqm: number | null;
  totalAreaSqm: number | null;
};

export type ComplexDetailUnitGroup = {
  groupKey: string | null;
  label: string | null;
  exclusiveAreaMin: number | null;
  exclusiveAreaMax: number | null;
};

export type ComplexDetailMarketPoint = {
  dealDate: string;
  amount: number;
  exclusiveArea: number;
  floor: number | null;
};

export type ComplexDetailMarketSeriesPoint = {
  yearMonth: string;
  tradeAvg: number | null;
  tradeCount: number;
  jeonseAvg: number | null;
  jeonseCount: number;
};

export type ComplexDetailMarket = {
  latestSale: ComplexDetailMarketPoint | null;
  latestJeonse: ComplexDetailMarketPoint | null;
  jeonseRatio: number | null;
  saleJeonseGap: number | null;
  periodHigh: ComplexDetailMarketPoint | null;
  diffFromHigh: number | null;
  tradeCount: number;
  jeonseCount: number;
  chartSeries: ComplexDetailMarketSeriesPoint[];
};

export type ComplexDetailMgmtMetrics = {
  periodYyyymm: string | null;
  commonFee: number | null;
  individualFee: number | null;
  longTermRepairReserve: number | null;
  totalFee: number | null;
  perAreaTotalFee: number | null;
  amountBasis: string | null;
  avg12mTotalFee: number | null;
  monthlySeries: Array<{
    periodYyyymm: string;
    commonFee: number | null;
    individualFee: number | null;
    longTermRepairReserve: number | null;
    totalFee: number | null;
  }>;
};

export type ComplexDetailViewModel = {
  identity: ComplexDetailIdentity;
  basic: ComplexDetailBasic | null;
  building: ComplexDetailBuilding | null;
  unit: ComplexDetailUnitGroup | null;
  market: ComplexDetailMarket | null;
  management: ComplexDetailMgmtMetrics | null;
};

/** Enrichment domains for apt_complex_enrichment_state (lazy rows). */
export const COMPLEX_DETAIL_ENRICHMENT_DOMAINS = [
  "BASIC_INFO",
  "BUILDING_INFO",
  "MANAGEMENT_FEE",
] as const;

export type ComplexDetailEnrichmentDomain =
  (typeof COMPLEX_DETAIL_ENRICHMENT_DOMAINS)[number];

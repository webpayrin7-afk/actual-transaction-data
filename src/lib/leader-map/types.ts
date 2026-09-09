export type LeaderSampleQuality = "GOOD" | "LOW";

export type LeaderDeal = {
  dealDate: string;
  dealAmount: number;
  exclusiveArea: number;
  floor: number;
};

export type LeaderChange = {
  direction: "up" | "down" | "same";
  amount: number;
  pct: number | null;
};

export type LeaderComplex = {
  complexKey: string;
  lawdCd: string;
  gu: string;
  dong: string;
  aptName: string;
  aptNameNorm: string;
  regionSlug: string;
  href: string;
  tradeCount12m: number;
  medianPpsqm: number;
  medianPyeongPrice: number;
  normalized84Price: number;
  latestDeal: LeaderDeal;
  previousDeal: LeaderDeal | null;
  latestChange: LeaderChange | null;
  sampleQuality: LeaderSampleQuality;
};

export type GuLeaderRow = {
  lawdCd: string;
  name: string;
  slug: string;
  leader: LeaderComplex | null;
};

export type DongLeaderRow = {
  dong: string;
  leader: LeaderComplex | null;
};

export type LeaderMapResponse = {
  metro: "seoul";
  source: "db" | "empty";
  asOfDate: string | null;
  window: { from: string; to: string; months: number };
  computedAt: string;
  eligibleComplexCount: number;
  gus: GuLeaderRow[];
  dongsByGu: Record<string, DongLeaderRow[]>;
  top5: LeaderComplex[];
  warning?: string;
};

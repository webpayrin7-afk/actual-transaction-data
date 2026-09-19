/**
 * One ranking run reads one transaction snapshot.
 * Price, counts, turnover, stability, and momentum all use these windows.
 */

export const FEATURE_VERSION = "region-feature-v1";

export type HalfOpenWindow = {
  /** Exclusive lower bound (deal_date > start). */
  startExclusive: string;
  /** Inclusive upper bound (deal_date <= end). */
  endInclusive: string;
};

export type RankingWindows = {
  transactionAsOf: string;
  base12m: HalfOpenWindow;
  recent3m: HalfOpenWindow;
  previous3m: HalfOpenWindow;
};

function shiftMonths(isoDate: string, months: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) throw new Error(`bad date ${isoDate}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const dt = new Date(Date.UTC(year, month - 1, day));
  dt.setUTCMonth(dt.getUTCMonth() + months);
  return dt.toISOString().slice(0, 10);
}

export function windowsFromAsOf(transactionAsOf: string): RankingWindows {
  const asOf = transactionAsOf.slice(0, 10);
  return {
    transactionAsOf: asOf,
    base12m: { startExclusive: shiftMonths(asOf, -12), endInclusive: asOf },
    recent3m: { startExclusive: shiftMonths(asOf, -3), endInclusive: asOf },
    previous3m: {
      startExclusive: shiftMonths(asOf, -6),
      endInclusive: shiftMonths(asOf, -3),
    },
  };
}

export function inWindow(dealDate: string, window: HalfOpenWindow): boolean {
  const day = dealDate.slice(0, 10);
  return day > window.startExclusive && day <= window.endInclusive;
}

export type SnapshotIdentity = {
  featureRunId: string;
  transactionAsOf: string;
  sourceWindowStart: string;
  sourceWindowEnd: string;
  featureVersion: string;
};

/** Feature identity only. Ranking config is not part of this object. */
export function snapshotIdentity(params: {
  featureRunId: string;
  windows: RankingWindows;
}): SnapshotIdentity {
  return {
    featureRunId: params.featureRunId,
    transactionAsOf: params.windows.transactionAsOf,
    sourceWindowStart: params.windows.base12m.startExclusive,
    sourceWindowEnd: params.windows.base12m.endInclusive,
    featureVersion: FEATURE_VERSION,
  };
}

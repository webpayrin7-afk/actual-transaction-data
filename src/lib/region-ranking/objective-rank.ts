/**
 * Objective region-overview rankings.
 * No private score, no area-band weighting, no household gate.
 */

export const PRICE_PER_SQM_MIN_TRADES = 3;

export type ObjectiveComplex = {
  complexId: string;
  tradeCount3m: number;
  latestDealDate: string | null;
  medianPricePerSqm3m: number | null;
};

export type RankedObjective = ObjectiveComplex & {
  rank: number;
  regionTotal: number;
};

function compareId(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Even counts use the mean of the two central values. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Recent 3-month sale count. Zero-trade complexes are omitted. */
export function rankTradeVolume(rows: readonly ObjectiveComplex[]): RankedObjective[] {
  const eligible = rows.filter((row) => row.tradeCount3m > 0 && row.latestDealDate != null);
  const sorted = [...eligible].sort((a, b) => {
    if (b.tradeCount3m !== a.tradeCount3m) return b.tradeCount3m - a.tradeCount3m;
    const latest = (b.latestDealDate ?? "").localeCompare(a.latestDealDate ?? "");
    if (latest !== 0) return latest;
    return compareId(a.complexId, b.complexId);
  });
  return sorted.map((row, index) => ({ ...row, rank: index + 1, regionTotal: sorted.length }));
}

/**
 * Median sale price per exclusive square meter.
 * Complexes with fewer than the public minimum trades are omitted, not imputed.
 */
export function rankPricePerSqm(rows: readonly ObjectiveComplex[]): RankedObjective[] {
  const eligible = rows.filter(
    (row) =>
      row.tradeCount3m >= PRICE_PER_SQM_MIN_TRADES &&
      row.medianPricePerSqm3m != null &&
      Number.isFinite(row.medianPricePerSqm3m),
  );
  const sorted = [...eligible].sort((a, b) => {
    const price = b.medianPricePerSqm3m! - a.medianPricePerSqm3m!;
    if (price !== 0) return price;
    if (b.tradeCount3m !== a.tradeCount3m) return b.tradeCount3m - a.tradeCount3m;
    return compareId(a.complexId, b.complexId);
  });
  return sorted.map((row, index) => ({ ...row, rank: index + 1, regionTotal: sorted.length }));
}

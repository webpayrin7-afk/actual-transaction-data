import { typeRecordHigh } from "@/lib/region/market-insight";

export type SingogaTradeLike = {
  id: string;
  dealType: string;
  dealDate: string;
  dealAmount: number;
  exclusiveArea: number;
};

export type MarketGroupLike = {
  groupKey: string;
  exclusiveAreaMin: number;
  exclusiveAreaMax: number;
  groupConfidenceHigh: boolean;
};

function areaInGroup(area: number, g: MarketGroupLike): boolean {
  return (
    area >= g.exclusiveAreaMin - 0.005 && area <= g.exclusiveAreaMax + 0.005
  );
}

export function matchMarketGroup(
  exclusiveArea: number,
  groups: MarketGroupLike[],
): MarketGroupLike | null {
  const hits = groups.filter((g) => areaInGroup(exclusiveArea, g));
  if (hits.length !== 1) return null;
  return hits[0]!;
}

/**
 * Legacy apt-detail singoga: all-time max equality within exact exclusive areaKey.
 * Ties all count as singoga.
 */
export function markSingogaExclusiveAllTimeMax(
  trades: SingogaTradeLike[],
): Map<string, boolean> {
  const out = new Map<string, boolean>();
  const maxByArea = new Map<string, number>();
  const areaKey = (sqm: number) => String(Math.round(sqm * 100) / 100);
  for (const tx of trades) {
    if (tx.dealType !== "trade") {
      out.set(tx.id, false);
      continue;
    }
    const key = areaKey(tx.exclusiveArea);
    maxByArea.set(key, Math.max(maxByArea.get(key) ?? 0, tx.dealAmount));
  }
  for (const tx of trades) {
    if (tx.dealType !== "trade") {
      out.set(tx.id, false);
      continue;
    }
    out.set(
      tx.id,
      tx.dealAmount === (maxByArea.get(areaKey(tx.exclusiveArea)) ?? -1),
    );
  }
  return out;
}

/**
 * A/B market-group singoga:
 * same complex + market group + exceed prior contract-date max.
 * Ties = false. Cancelled trades must already be absent from input.
 */
export function markSingogaMarketGroupPriorExceed(
  trades: SingogaTradeLike[],
  groups: MarketGroupLike[],
): Map<string, boolean> {
  const out = new Map<string, boolean>();
  const eligibleGroups = groups.filter((g) => g.groupConfidenceHigh);
  const sorted = [...trades].sort((a, b) => {
    if (a.dealDate !== b.dealDate) return a.dealDate < b.dealDate ? -1 : 1;
    return a.id.localeCompare(b.id);
  });

  const priorMax = new Map<string, number>();
  let i = 0;
  while (i < sorted.length) {
    const day = sorted[i]!.dealDate;
    const batch: SingogaTradeLike[] = [];
    while (i < sorted.length && sorted[i]!.dealDate === day) {
      batch.push(sorted[i]!);
      i += 1;
    }

    const dayPeak = new Map<string, number>();
    for (const tx of batch) {
      if (tx.dealType !== "trade") {
        out.set(tx.id, false);
        continue;
      }
      const g = matchMarketGroup(tx.exclusiveArea, eligibleGroups);
      if (!g) {
        out.set(tx.id, false);
        continue;
      }
      const prior = priorMax.get(g.groupKey) ?? 0;
      out.set(tx.id, typeRecordHigh(tx.dealAmount, prior).isSingoga);
      dayPeak.set(
        g.groupKey,
        Math.max(dayPeak.get(g.groupKey) ?? 0, tx.dealAmount),
      );
    }
    for (const [gk, peak] of dayPeak) {
      priorMax.set(gk, Math.max(priorMax.get(gk) ?? 0, peak));
    }
  }
  return out;
}

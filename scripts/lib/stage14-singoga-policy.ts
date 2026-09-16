/**
 * Stage14 exact vs group singoga policy helpers (pure, read-only).
 * Does not modify production singoga runtime.
 */
import { areaKey, areaKeyStr } from "./stage9-grouping-contract";

export type PilotTrade = {
  id: string;
  dealDate: string; // YYYY-MM-DD
  exclusiveArea: number;
  dealAmount: number;
};

export type PilotGroup = {
  groupKey: string;
  memberAreaKeys: number[];
  source: string;
};

export type BaselineMode = "GROUP" | "EXACT_FALLBACK" | "NO_PRIOR_BASELINE";

export type PilotTxResult = {
  complexId: string;
  contractDate: string;
  areaKey: number;
  price: number;
  groupKey: string | null;
  exactPriorMax: number | null;
  groupPriorMax: number | null;
  isExactSingoga: boolean;
  isGroupSingoga: boolean | null;
  exactOnlySingoga: boolean;
  primarySingoga: boolean;
  baselineMode: BaselineMode;
};

export function isEligiblePilotGroupSource(source: string): boolean {
  return (
    source === "similar_exclusive_area_v1" ||
    source === "transactions-similar-area"
  );
}

/** Strict break: current > prior. Null prior → false. */
export function isStrictSingoga(
  price: number,
  priorMax: number | null,
): boolean {
  return priorMax != null && price > priorMax;
}

/**
 * Sweep all-history trades chronologically.
 * Same-day trades share the prior snapshot (do not include each other).
 * Report window: dealDate >= windowStart (inclusive).
 */
export function computePilotResults(params: {
  complexId: string;
  trades: PilotTrade[];
  groups: PilotGroup[];
  windowStart: string; // YYYY-MM-DD
}): {
  results: PilotTxResult[];
  invariantViolations: {
    groupPriorLtExact: number;
    groupTrueExactFalse: number;
    samples: Array<Record<string, unknown>>;
  };
} {
  const areaToGroup = new Map<string, string>();
  for (const g of params.groups) {
    for (const a of g.memberAreaKeys) {
      const k = areaKeyStr(a);
      // First eligible group wins; overlaps should not exist under V1.
      if (!areaToGroup.has(k)) areaToGroup.set(k, g.groupKey);
    }
  }

  const sorted = [...params.trades].sort((a, b) => {
    if (a.dealDate !== b.dealDate) return a.dealDate < b.dealDate ? -1 : 1;
    return a.id.localeCompare(b.id);
  });

  const runningExact = new Map<string, number>();
  const runningGroup = new Map<string, number>();
  const results: PilotTxResult[] = [];
  const invariantViolations = {
    groupPriorLtExact: 0,
    groupTrueExactFalse: 0,
    samples: [] as Array<Record<string, unknown>>,
  };

  let i = 0;
  while (i < sorted.length) {
    const day = sorted[i]!.dealDate;
    const batch: PilotTrade[] = [];
    while (i < sorted.length && sorted[i]!.dealDate === day) {
      batch.push(sorted[i]!);
      i += 1;
    }

    // Evaluate against prior snapshot (before this day).
    for (const tx of batch) {
      if (tx.dealDate < params.windowStart) continue;
      const ak = areaKey(tx.exclusiveArea);
      const aks = areaKeyStr(ak);
      const gk = areaToGroup.get(aks) ?? null;
      const exactPrior = runningExact.has(aks)
        ? runningExact.get(aks)!
        : null;
      const groupPrior =
        gk != null
          ? runningGroup.has(gk)
            ? runningGroup.get(gk)!
            : null
          : null;

      const isExactSingoga = isStrictSingoga(tx.dealAmount, exactPrior);
      const isGroupSingoga =
        gk != null ? isStrictSingoga(tx.dealAmount, groupPrior) : null;
      const exactOnlySingoga =
        gk != null && isExactSingoga && isGroupSingoga === false;
      const primarySingoga =
        gk != null ? (isGroupSingoga ?? false) : isExactSingoga;

      let baselineMode: BaselineMode;
      if (gk != null) {
        baselineMode =
          groupPrior == null && exactPrior == null
            ? "NO_PRIOR_BASELINE"
            : "GROUP";
      } else {
        baselineMode =
          exactPrior == null ? "NO_PRIOR_BASELINE" : "EXACT_FALLBACK";
      }

      if (
        gk != null &&
        exactPrior != null &&
        groupPrior != null &&
        groupPrior < exactPrior
      ) {
        invariantViolations.groupPriorLtExact += 1;
        if (invariantViolations.samples.length < 5) {
          invariantViolations.samples.push({
            kind: "groupPriorLtExact",
            date: tx.dealDate,
            areaKey: ak,
            groupKey: gk,
            exactPrior,
            groupPrior,
          });
        }
      }
      // group⇒exact only required when exact prior exists.
      // First trade on a member area can be group-singoga with exactPrior=null.
      if (
        isGroupSingoga === true &&
        isExactSingoga === false &&
        exactPrior != null
      ) {
        invariantViolations.groupTrueExactFalse += 1;
        if (invariantViolations.samples.length < 8) {
          invariantViolations.samples.push({
            kind: "groupTrueExactFalse",
            date: tx.dealDate,
            areaKey: ak,
            price: tx.dealAmount,
            exactPrior,
            groupPrior,
            groupKey: gk,
          });
        }
      }

      results.push({
        complexId: params.complexId,
        contractDate: tx.dealDate,
        areaKey: ak,
        price: tx.dealAmount,
        groupKey: gk,
        exactPriorMax: exactPrior,
        groupPriorMax: groupPrior,
        isExactSingoga,
        isGroupSingoga,
        exactOnlySingoga,
        primarySingoga,
        baselineMode,
      });
    }

    // After the day: update running maxes (same-day peers now become history).
    for (const tx of batch) {
      const ak = areaKey(tx.exclusiveArea);
      const aks = areaKeyStr(ak);
      runningExact.set(
        aks,
        Math.max(runningExact.get(aks) ?? 0, tx.dealAmount),
      );
      const gk = areaToGroup.get(aks);
      if (gk) {
        runningGroup.set(
          gk,
          Math.max(runningGroup.get(gk) ?? 0, tx.dealAmount),
        );
      }
    }
  }

  return { results, invariantViolations };
}

export function summarizeResults(results: PilotTxResult[]) {
  const grouped = results.filter((r) => r.groupKey != null);
  const nonGrouped = results.filter((r) => r.groupKey == null);
  const exact = results.filter((r) => r.isExactSingoga).length;
  const group = results.filter((r) => r.isGroupSingoga === true).length;
  const exactOnly = results.filter((r) => r.exactOnlySingoga).length;
  const fallbackExact = nonGrouped.filter((r) => r.isExactSingoga).length;
  const primary = results.filter((r) => r.primarySingoga).length;

  const gExact = grouped.filter((r) => r.isExactSingoga).length;
  const gGroup = grouped.filter((r) => r.isGroupSingoga === true).length;
  const gExactOnly = grouped.filter((r) => r.exactOnlySingoga).length;
  const noiseReductionCount = gExact - gGroup; // among grouped: exact - group primary
  const noiseReductionRate =
    gExact > 0 ? Math.round((gExactOnly / gExact) * 10000) / 10000 : null;

  return {
    reportTransactions: results.length,
    groupedTransactions: grouped.length,
    nonGroupedTransactions: nonGrouped.length,
    exactSingoga: exact,
    groupSingoga: group,
    exactOnlySingoga: exactOnly,
    exactFallbackSingoga: fallbackExact,
    primarySingoga: primary,
    noiseReductionCount: exact - primary,
    groupedSubset: {
      transactions: grouped.length,
      exactSingoga: gExact,
      groupSingoga: gGroup,
      exactOnlySingoga: gExactOnly,
      noiseReductionCount,
      noiseReductionRate,
    },
  };
}

export function pickExamples(
  results: PilotTxResult[],
  maxPerClass = 1,
): {
  groupSingoga: PilotTxResult[];
  exactOnlySingoga: PilotTxResult[];
  exactFallbackSingoga: PilotTxResult[];
} {
  const take = (pred: (r: PilotTxResult) => boolean) => {
    const hits = results
      .filter(pred)
      .sort((a, b) => b.price - a.price || b.contractDate.localeCompare(a.contractDate));
    return hits.slice(0, maxPerClass);
  };
  return {
    groupSingoga: take((r) => r.isGroupSingoga === true),
    exactOnlySingoga: take((r) => r.exactOnlySingoga),
    exactFallbackSingoga: take(
      (r) => r.groupKey == null && r.isExactSingoga,
    ),
  };
}

/** Compact example for report. */
export function exampleShape(r: PilotTxResult) {
  return {
    date: r.contractDate,
    area: r.areaKey,
    price: r.price,
    exactPriorMax: r.exactPriorMax,
    groupPriorMax: r.groupPriorMax,
    groupKey: r.groupKey,
    classification: r.exactOnlySingoga
      ? "EXACT_ONLY_SINGOGA"
      : r.isGroupSingoga
        ? "GROUP_SINGOGA"
        : r.groupKey == null && r.isExactSingoga
          ? "EXACT_FALLBACK_SINGOGA"
          : r.primarySingoga
            ? "PRIMARY_SINGOGA"
            : "NOT_SINGOGA",
  };
}

/**
 * Legacy all-time max equality (singoga.ts markSingogaExclusiveAllTimeMax semantics)
 * on report-window trades only — for comparison note, not policy equivalence.
 */
export function countLegacyAllTimeMaxEquality(tradesInWindow: PilotTrade[]) {
  const maxByArea = new Map<string, number>();
  for (const tx of tradesInWindow) {
    const k = areaKeyStr(tx.exclusiveArea);
    maxByArea.set(k, Math.max(maxByArea.get(k) ?? 0, tx.dealAmount));
  }
  let n = 0;
  for (const tx of tradesInWindow) {
    if (tx.dealAmount === (maxByArea.get(areaKeyStr(tx.exclusiveArea)) ?? -1)) {
      n += 1;
    }
  }
  return n;
}

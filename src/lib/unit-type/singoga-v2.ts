/**
 * SINGOGA_V2 — production pure classifier (Stage17).
 *
 * Semantic (frozen Stage16):
 *   primary = strict break of prior max as of contract date (deal_date)
 *   group exists → groupPriorMax; else → exactPriorMax (fallback)
 *   exact-only (group exists && exact break && !group break) = secondary only
 *   no prior → FALSE
 *   same-day peers share prior snapshot (not each other)
 *
 * Does not write DB. Does not change public API by itself.
 * Activation is gated by ENABLE_SINGOGA_V2 (see singoga-v2-gate.ts).
 */

export const SINGOGA_V2_GROUP_RULE = "similar_exclusive_area_v1" as const;

export type SingogaV2BaselineMode =
  | "GROUP_V1"
  | "EXACT_FALLBACK"
  | "NO_PRIOR_BASELINE";

export type SingogaV2Trade = {
  id: string;
  dealDate: string; // YYYY-MM-DD
  exclusiveArea: number;
  dealAmount: number;
};

export type SingogaV2Group = {
  groupKey: string;
  memberAreaKeys: number[];
  source: string;
};

export type SingogaV2TxResult = {
  txId: string;
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
  primarySingogaV2: boolean;
  baselineMode: SingogaV2BaselineMode;
  /** Prior used for primary judgment (group or exact). Null when no prior. */
  primaryPriorMax: number | null;
};

export type SingogaV2InvariantViolations = {
  groupPriorLtExact: number;
  groupTrueExactFalse: number;
  samples: Array<Record<string, unknown>>;
};

/** Canonical areaKey — matches production ROUND(sqm*100)/100. */
export function singogaV2AreaKey(sqm: number): number {
  return Math.round(sqm * 100) / 100;
}

export function singogaV2AreaKeyStr(sqm: number): string {
  return String(singogaV2AreaKey(sqm));
}

/**
 * Eligible V1 similar-area groups for SINGOGA_V2.
 * Prefer similar_exclusive_area_v1; Stage7–13 pilot source also accepted.
 * Legacy Phase5 slug groups are NOT treated as V1.
 */
export function isEligibleSingogaV2GroupSource(source: string): boolean {
  return (
    source === "similar_exclusive_area_v1" ||
    source === "transactions-similar-area"
  );
}

/** Strict break: current > prior. Null prior → false. */
export function isStrictSingogaV2Break(
  price: number,
  priorMax: number | null,
): boolean {
  return priorMax != null && price > priorMax;
}

/**
 * Classify all history for one complex chronologically (deal_date ASC).
 * Same-day trades share the prior snapshot; rolling maxima update after the day.
 */
export function classifySingogaV2ForComplex(params: {
  complexId: string;
  trades: SingogaV2Trade[];
  groups: SingogaV2Group[];
  /** Inclusive report window start; history before this still builds priors. */
  windowStart?: string;
}): {
  results: SingogaV2TxResult[];
  invariantViolations: SingogaV2InvariantViolations;
} {
  const windowStart = params.windowStart ?? "1900-01-01";
  const areaToGroup = new Map<string, string>();
  for (const g of params.groups) {
    if (!isEligibleSingogaV2GroupSource(g.source)) continue;
    for (const a of g.memberAreaKeys) {
      const k = singogaV2AreaKeyStr(a);
      if (!areaToGroup.has(k)) areaToGroup.set(k, g.groupKey);
    }
  }

  const sorted = [...params.trades].sort((a, b) => {
    if (a.dealDate !== b.dealDate) return a.dealDate < b.dealDate ? -1 : 1;
    return a.id.localeCompare(b.id);
  });

  const runningExact = new Map<string, number>();
  const runningGroup = new Map<string, number>();
  const results: SingogaV2TxResult[] = [];
  const invariantViolations: SingogaV2InvariantViolations = {
    groupPriorLtExact: 0,
    groupTrueExactFalse: 0,
    samples: [],
  };

  let i = 0;
  while (i < sorted.length) {
    const day = sorted[i]!.dealDate;
    const batch: SingogaV2Trade[] = [];
    while (i < sorted.length && sorted[i]!.dealDate === day) {
      batch.push(sorted[i]!);
      i += 1;
    }

    for (const tx of batch) {
      if (tx.dealDate < windowStart) continue;
      const ak = singogaV2AreaKey(tx.exclusiveArea);
      const aks = singogaV2AreaKeyStr(ak);
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

      const isExactSingoga = isStrictSingogaV2Break(tx.dealAmount, exactPrior);
      const isGroupSingoga =
        gk != null ? isStrictSingogaV2Break(tx.dealAmount, groupPrior) : null;
      const exactOnlySingoga =
        gk != null && isExactSingoga && isGroupSingoga === false;
      const primarySingogaV2 =
        gk != null ? (isGroupSingoga ?? false) : isExactSingoga;
      const primaryPriorMax = gk != null ? groupPrior : exactPrior;

      let baselineMode: SingogaV2BaselineMode;
      if (gk != null) {
        baselineMode =
          groupPrior == null && exactPrior == null
            ? "NO_PRIOR_BASELINE"
            : "GROUP_V1";
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
        txId: tx.id,
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
        primarySingogaV2,
        baselineMode,
        primaryPriorMax,
      });
    }

    for (const tx of batch) {
      const ak = singogaV2AreaKey(tx.exclusiveArea);
      const aks = singogaV2AreaKeyStr(ak);
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

/**
 * Legacy all-time-max equality (CURRENT_ALL_TIME_HIGH conceptually).
 * Kept separate from SINGOGA_V2; does not delete production singoga.ts helper.
 */
export function countLegacyAllTimeHighEquality(
  trades: SingogaV2Trade[],
): number {
  const maxByArea = new Map<string, number>();
  for (const tx of trades) {
    const k = singogaV2AreaKeyStr(tx.exclusiveArea);
    maxByArea.set(k, Math.max(maxByArea.get(k) ?? 0, tx.dealAmount));
  }
  let n = 0;
  for (const tx of trades) {
    if (
      tx.dealAmount ===
      (maxByArea.get(singogaV2AreaKeyStr(tx.exclusiveArea)) ?? -1)
    ) {
      n += 1;
    }
  }
  return n;
}

export function summarizeSingogaV2Results(results: SingogaV2TxResult[]) {
  const grouped = results.filter((r) => r.groupKey != null);
  const nonGrouped = results.filter((r) => r.groupKey == null);
  return {
    transactions: results.length,
    exactPrior: results.filter((r) => r.isExactSingoga).length,
    groupPrimary: results.filter((r) => r.isGroupSingoga === true).length,
    exactOnly: results.filter((r) => r.exactOnlySingoga).length,
    fallback: nonGrouped.filter((r) => r.isExactSingoga).length,
    primaryV2: results.filter((r) => r.primarySingogaV2).length,
    groupedTransactions: grouped.length,
    fallbackTransactions: nonGrouped.length,
  };
}

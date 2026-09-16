/**
 * Stage15 singoga shadow dual-computation (pure / diagnostic).
 * Reuses production markSingogaExclusiveAllTimeMax + Stage14 prior helpers.
 * Does NOT change user-visible production results.
 */
import { markSingogaExclusiveAllTimeMax } from "../../src/lib/unit-type/singoga";
import { areaKeyStr } from "./stage9-grouping-contract";
import {
  computePilotResults,
  type BaselineMode,
  type PilotGroup,
  type PilotTrade,
  type PilotTxResult,
} from "./stage14-singoga-policy";

export type SingogaShadowResult = {
  txId: string;
  complexId: string;
  contractDate: string;
  areaKey: number;
  price: number;

  legacySingoga: boolean;

  exactPriorMax: number | null;
  exactPriorSingoga: boolean;

  groupKey: string | null;
  groupPriorMax: number | null;
  groupPriorSingoga: boolean | null;

  exactOnly: boolean;
  primaryShadowSingoga: boolean;
  baselineMode: BaselineMode;

  compareClass:
    | "LEGACY_ONLY"
    | "EXACT_PRIOR_ONLY"
    | "BOTH_LEGACY_EXACT"
    | "EXACT_ONLY_SUPPRESSED_BY_GROUP"
    | "GROUP_PRIMARY"
    | "FALLBACK_EXACT"
    | "NO_SINGOGA"
    | "OTHER";
};

export type TemporalDiffKind =
  | "historical_prior_break_later_surpassed"
  | "all_time_tie_equality_no_exceed"
  | "same_day_batch"
  | "other";

export function classifyCompare(r: {
  legacySingoga: boolean;
  exactPriorSingoga: boolean;
  groupPriorSingoga: boolean | null;
  exactOnly: boolean;
  primaryShadowSingoga: boolean;
  groupKey: string | null;
}): SingogaShadowResult["compareClass"] {
  if (r.exactOnly) return "EXACT_ONLY_SUPPRESSED_BY_GROUP";
  if (r.groupKey != null && r.groupPriorSingoga === true) return "GROUP_PRIMARY";
  if (r.groupKey == null && r.exactPriorSingoga) return "FALLBACK_EXACT";
  if (r.legacySingoga && r.exactPriorSingoga) return "BOTH_LEGACY_EXACT";
  if (r.legacySingoga && !r.exactPriorSingoga) return "LEGACY_ONLY";
  if (!r.legacySingoga && r.exactPriorSingoga) return "EXACT_PRIOR_ONLY";
  if (!r.legacySingoga && !r.exactPriorSingoga && !r.primaryShadowSingoga) {
    return "NO_SINGOGA";
  }
  return "OTHER";
}

/**
 * Three-lane shadow for one complex.
 *
 * LANE A LEGACY: production markSingogaExclusiveAllTimeMax (full history)
 * LANE B EXACT_PRIOR + LANE C GROUP_PRIMARY: Stage14 computePilotResults
 *
 * Single history load → in-memory (no per-row N+1).
 */
export function computeThreeLaneShadow(params: {
  complexId: string;
  trades: PilotTrade[];
  groups: PilotGroup[];
  windowStart: string;
}): {
  shadows: SingogaShadowResult[];
  pilot: PilotTxResult[];
  legacyMap: Map<string, boolean>;
  invariantViolations: {
    groupPriorLtExact: number;
    groupTrueExactFalse: number;
    samples: Array<Record<string, unknown>>;
  };
  temporalDiff: Record<TemporalDiffKind, number>;
} {
  const deals = params.trades.map((t) => ({
    id: t.id,
    dealType: "trade",
    dealDate: t.dealDate,
    dealAmount: t.dealAmount,
    exclusiveArea: t.exclusiveArea,
  }));

  const legacyMap = markSingogaExclusiveAllTimeMax(deals);
  const { results: pilot, invariantViolations } = computePilotResults(params);

  const bucket = new Map<string, PilotTrade[]>();
  for (const t of params.trades) {
    if (t.dealDate < params.windowStart) continue;
    const k = `${t.dealDate}|${areaKeyStr(t.exclusiveArea)}|${t.dealAmount}`;
    const arr = bucket.get(k) ?? [];
    arr.push(t);
    bucket.set(k, arr);
  }
  const bucketCursor = new Map<string, number>();

  const allTimeMax = new Map<string, number>();
  for (const t of params.trades) {
    const k = areaKeyStr(t.exclusiveArea);
    allTimeMax.set(k, Math.max(allTimeMax.get(k) ?? 0, t.dealAmount));
  }
  const dayAreaCount = new Map<string, number>();
  for (const t of params.trades) {
    if (t.dealDate < params.windowStart) continue;
    const key = `${t.dealDate}|${areaKeyStr(t.exclusiveArea)}`;
    dayAreaCount.set(key, (dayAreaCount.get(key) ?? 0) + 1);
  }

  const temporalDiff: Record<TemporalDiffKind, number> = {
    historical_prior_break_later_surpassed: 0,
    all_time_tie_equality_no_exceed: 0,
    same_day_batch: 0,
    other: 0,
  };

  const shadows: SingogaShadowResult[] = [];
  for (const p of pilot) {
    const bk = `${p.contractDate}|${areaKeyStr(p.areaKey)}|${p.price}`;
    const arr = bucket.get(bk) ?? [];
    const idx = bucketCursor.get(bk) ?? 0;
    const trade = arr[idx];
    bucketCursor.set(bk, idx + 1);
    const txId = trade?.id ?? `missing:${bk}:${idx}`;
    const legacySingoga = legacyMap.get(txId) ?? false;

    const compareClass = classifyCompare({
      legacySingoga,
      exactPriorSingoga: p.isExactSingoga,
      groupPriorSingoga: p.isGroupSingoga,
      exactOnly: p.exactOnlySingoga,
      primaryShadowSingoga: p.primarySingoga,
      groupKey: p.groupKey,
    });

    if (legacySingoga !== p.isExactSingoga) {
      const aks = areaKeyStr(p.areaKey);
      const atMax = allTimeMax.get(aks) ?? -1;
      const sameDay =
        (dayAreaCount.get(`${p.contractDate}|${aks}`) ?? 0) > 1;
      if (!legacySingoga && p.isExactSingoga) {
        if (p.price < atMax) {
          temporalDiff.historical_prior_break_later_surpassed += 1;
        } else if (sameDay) {
          temporalDiff.same_day_batch += 1;
        } else {
          temporalDiff.other += 1;
        }
      } else if (legacySingoga && !p.isExactSingoga) {
        if (p.price === atMax) {
          temporalDiff.all_time_tie_equality_no_exceed += 1;
        } else if (sameDay) {
          temporalDiff.same_day_batch += 1;
        } else {
          temporalDiff.other += 1;
        }
      }
    }

    shadows.push({
      txId,
      complexId: params.complexId,
      contractDate: p.contractDate,
      areaKey: p.areaKey,
      price: p.price,
      legacySingoga,
      exactPriorMax: p.exactPriorMax,
      exactPriorSingoga: p.isExactSingoga,
      groupKey: p.groupKey,
      groupPriorMax: p.groupPriorMax,
      groupPriorSingoga: p.isGroupSingoga,
      exactOnly: p.exactOnlySingoga,
      primaryShadowSingoga: p.primarySingoga,
      baselineMode: p.baselineMode,
      compareClass,
    });
  }

  return {
    shadows,
    pilot,
    legacyMap,
    invariantViolations,
    temporalDiff,
  };
}

export function summarizeShadow(shadows: SingogaShadowResult[]) {
  const legacy = shadows.filter((s) => s.legacySingoga).length;
  const exact = shadows.filter((s) => s.exactPriorSingoga).length;
  const groupPrimary = shadows.filter((s) => s.primaryShadowSingoga).length;
  const exactOnly = shadows.filter((s) => s.exactOnly).length;
  const fallbackExact = shadows.filter(
    (s) => s.groupKey == null && s.exactPriorSingoga,
  ).length;
  const grouped = shadows.filter((s) => s.groupKey != null);
  const gLegacy = grouped.filter((s) => s.legacySingoga).length;
  const gExact = grouped.filter((s) => s.exactPriorSingoga).length;
  const gGroup = grouped.filter((s) => s.groupPriorSingoga === true).length;
  const gExactOnly = grouped.filter((s) => s.exactOnly).length;
  const gPrimary = grouped.filter((s) => s.primaryShadowSingoga).length;

  const compareClassCounts: Record<string, number> = {};
  for (const s of shadows) {
    compareClassCounts[s.compareClass] =
      (compareClassCounts[s.compareClass] ?? 0) + 1;
  }

  return {
    reportTransactions: shadows.length,
    legacy,
    exactPrior: exact,
    groupPrimary,
    exactOnlySuppressed: exactOnly,
    fallbackExact,
    temporalSemanticsDelta: exact - legacy,
    groupingDelta: groupPrimary - exact,
    compareClassCounts,
    groupedSubset: {
      transactions: grouped.length,
      legacy: gLegacy,
      exactPrior: gExact,
      groupPrior: gGroup,
      exactOnly: gExactOnly,
      groupPrimary: gPrimary,
      suppressionRate:
        gExact > 0 ? Math.round((gExactOnly / gExact) * 10000) / 10000 : null,
    },
  };
}

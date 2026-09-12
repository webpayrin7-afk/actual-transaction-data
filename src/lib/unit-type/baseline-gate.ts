/**
 * Phase 5.3b / 5.4a — production gates for baseline-backed market-group 신고가.
 *
 * Two independent switches (Phase 5.4a separation):
 *
 * - ENABLE_MARKET_GROUP_BASELINE_SINGOGA
 *   Rollout switch. When "1", the baseline 신고가 path may load DB prior-max
 *   and apply it. Defaults OFF. Existing legacy/full-history safety fallback
 *   remains in code regardless of this flag.
 *
 * - POST_WH_SINGOGA_GAPS_CLEARED
 *   Migration-completion switch. When "1", post-warehouse Banpo/Jamsil gaps
 *   are considered cleared enough that *future* removal of legacy/full-history
 *   fallback may be considered. This flag does NOT enable the baseline path
 *   and must not be treated as a rollout switch.
 *
 * No UI / selector coupling — read-path only.
 */

export type PostWarehouseSingogaGap = {
  complexKey: string;
  dealDate: string;
  dealAmount: number;
  exclusiveArea: number;
  kind: "missing_from_warehouse" | "warehouse_only_anomaly";
  note: string;
};

/** Known blockers from Phase 5.3 warehouse-path diffs (open until repaired). */
export const POST_WH_SINGOGA_GAP_BLOCKERS: readonly PostWarehouseSingogaGap[] = [
  {
    complexKey: "banpo-xi",
    dealDate: "2025-01-25",
    dealAmount: 415_000,
    exclusiveArea: 84.943,
    kind: "missing_from_warehouse",
    note: "sets full prior for 2025-02-18 / 415000 flip",
  },
  {
    complexKey: "banpo-xi",
    dealDate: "2025-06-14",
    dealAmount: 480_000,
    exclusiveArea: 84.943,
    kind: "missing_from_warehouse",
    note: "sets full prior for 2025-07-10 / 475000 flip",
  },
  {
    complexKey: "banpo-xi",
    dealDate: "2026-03-09",
    dealAmount: 620_000,
    exclusiveArea: 132.439,
    kind: "missing_from_warehouse",
    note: "sets full prior for 2026-06-20 / 615000 flip",
  },
  {
    complexKey: "banpo-xi",
    dealDate: "2025-07-10",
    dealAmount: 380_000,
    exclusiveArea: 59.98,
    kind: "missing_from_warehouse",
    note: "sets full prior for 2026-07-20 / 373000 flip",
  },
  {
    complexKey: "jamsil-els",
    dealDate: "2025-06-27",
    dealAmount: 300_000,
    exclusiveArea: 59.96,
    kind: "warehouse_only_anomaly",
    note: "warehouse prior above MOLIT active max; 2025-07-10 / 300000 path diff",
  },
] as const;

/**
 * Migration-completion signal only.
 * Does not enable or disable the baseline 신고가 path.
 */
export function arePostWarehouseSingogaGapsCleared(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.POST_WH_SINGOGA_GAPS_CLEARED === "1";
}

/**
 * True when ENABLE_MARKET_GROUP_BASELINE_SINGOGA=1.
 *
 * Independent of POST_WH_SINGOGA_GAPS_CLEARED so staged pilot activation
 * is possible while legacy/full-history safety fallback stays in code.
 */
export function isMarketGroupBaselineSingogaEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.ENABLE_MARKET_GROUP_BASELINE_SINGOGA === "1";
}

/** Why the baseline rollout path is blocked (ENABLE only). */
export function marketGroupBaselineSingogaBlockReason(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (env.ENABLE_MARKET_GROUP_BASELINE_SINGOGA !== "1") {
    return "ENABLE_MARKET_GROUP_BASELINE_SINGOGA is not 1";
  }
  return null;
}

/**
 * Why legacy/full-history fallback must not be removed yet.
 * POST_WH remains meaningful; this phase never deletes fallback code.
 */
export function legacySingogaFallbackRetirementBlockReason(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!arePostWarehouseSingogaGapsCleared(env)) {
    return (
      "POST_WH_SINGOGA_GAPS_CLEARED is not 1 " +
      `(${POST_WH_SINGOGA_GAP_BLOCKERS.length} Banpo/Jamsil warehouse gaps still open); ` +
      "legacy/full-history fallback must be retained"
    );
  }
  return null;
}

/** True only when POST_WH says gaps are cleared — does not remove fallback by itself. */
export function isLegacySingogaFallbackRetirementAllowed(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return legacySingogaFallbackRetirementBlockReason(env) == null;
}

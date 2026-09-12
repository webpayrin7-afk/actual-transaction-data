/**
 * Phase 5.3b — production activation gate for baseline-backed market-group 신고가.
 *
 * Defaults OFF. Even with ENABLE_MARKET_GROUP_BASELINE_SINGOGA=1, activation
 * stays blocked until Codex confirms Banpo 4 + Jamsil 1 post-warehouse gaps
 * are repaired in the warehouse (POST_WH_SINGOGA_GAPS_CLEARED=1).
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

export function arePostWarehouseSingogaGapsCleared(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.POST_WH_SINGOGA_GAPS_CLEARED === "1";
}

/**
 * True only when both:
 * - ENABLE_MARKET_GROUP_BASELINE_SINGOGA=1
 * - POST_WH_SINGOGA_GAPS_CLEARED=1
 *
 * Historical baseline math is proven (Phase 5.3); warehouse completeness is not.
 */
export function isMarketGroupBaselineSingogaEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.ENABLE_MARKET_GROUP_BASELINE_SINGOGA !== "1") return false;
  return arePostWarehouseSingogaGapsCleared(env);
}

export function marketGroupBaselineSingogaBlockReason(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (env.ENABLE_MARKET_GROUP_BASELINE_SINGOGA !== "1") {
    return "ENABLE_MARKET_GROUP_BASELINE_SINGOGA is not 1";
  }
  if (!arePostWarehouseSingogaGapsCleared(env)) {
    return (
      "POST_WH_SINGOGA_GAPS_CLEARED is not 1 " +
      `(${POST_WH_SINGOGA_GAP_BLOCKERS.length} Banpo/Jamsil warehouse gaps still open)`
    );
  }
  return null;
}

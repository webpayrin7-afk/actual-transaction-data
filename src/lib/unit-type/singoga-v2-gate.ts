/**
 * SINGOGA_V2 feature gate (Stage17).
 *
 * New flag — do NOT repurpose ENABLE_MARKET_GROUP_BASELINE_SINGOGA
 * or POST_WH_SINGOGA_GAPS_CLEARED.
 *
 * Default OFF. Server-only. Stage17: Production/Preview must stay OFF.
 */

export const SINGOGA_V2_FLAG_NAME = "ENABLE_SINGOGA_V2" as const;

/**
 * True only when ENABLE_SINGOGA_V2=1.
 * Unset / "0" / any other value → OFF (legacy production path).
 */
export function isSingogaV2Enabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.ENABLE_SINGOGA_V2 === "1";
}

/** Why V2 rebuild classification is blocked. */
export function singogaV2BlockReason(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (env.ENABLE_SINGOGA_V2 !== "1") {
    return "ENABLE_SINGOGA_V2 is not 1";
  }
  return null;
}

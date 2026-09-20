/**
 * Region-overview board gate.
 * A complex with incomplete band coverage does not fail the district board.
 */

export const REGION_BOARD_MIN_ELIGIBLE = 5;

export type RegionBoardStatus = "PASS" | "REGION_INSUFFICIENT_COHORT" | "HOLD_RANK_INTEGRITY";

export function assessRegionBoard(params: {
  eligibleCount: number;
  ranks: readonly number[];
  deterministic: boolean;
}): RegionBoardStatus {
  if (!params.deterministic) return "HOLD_RANK_INTEGRITY";
  if (params.eligibleCount < REGION_BOARD_MIN_ELIGIBLE) return "REGION_INSUFFICIENT_COHORT";
  if (params.ranks.length !== params.eligibleCount) return "HOLD_RANK_INTEGRITY";
  const sorted = [...params.ranks].sort((a, b) => a - b);
  const contiguous = sorted.every((rank, index) => rank === index + 1);
  const unique = new Set(sorted).size === sorted.length;
  if (!contiguous || !unique || sorted[0] !== 1) return "HOLD_RANK_INTEGRITY";
  return "PASS";
}

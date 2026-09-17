/**
 * Advancement / career category colors — single source for donut + list bars.
 * Ranked by display order (largest first): navy → teal → cool auxiliaries.
 * Fits ziplab navy/teal; no brown/muddy tones.
 */

export const ADVANCEMENT_RANK_COLORS = [
  "#0b2745", // lab-navy-900 — largest
  "#087f83", // lab-teal-700 — second
  "#3d8fb5", // steel blue
  "#5b7bb5", // soft indigo-blue
  "#6f8fd0", // periwinkle
  "#4f9a8a", // muted sea green
  "#7a8aa3", // cool slate
  "#9a7eb8", // muted violet
  "#5c9bb8", // soft cyan-blue
] as const;

export function advancementColorByRank(rankIndex: number): string {
  const colors = ADVANCEMENT_RANK_COLORS;
  return colors[rankIndex % colors.length]!;
}

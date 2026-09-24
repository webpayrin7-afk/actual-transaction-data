/**
 * Advancement / career category colors — single source for donut + list bars.
 * Ranked by display order (largest first).
 *
 * Adjacent ranks alternate hue families so donut segments stay separable:
 * navy → teal → coral → blue → violet → green → amber → slate → magenta.
 * Fits ziplab navy/teal; no muddy brown; not a full rainbow flood.
 */

export const ADVANCEMENT_RANK_COLORS = [
  "#0b2745", // lab-navy-900 — largest
  "#0a9ea3", // bright teal — second
  "#e35d6a", // coral rose
  "#2f7fd1", // clear blue
  "#8b63c7", // violet
  "#2f9e6e", // green
  "#e8a017", // clean amber (high chroma, not brown)
  "#5c6b82", // cool slate
  "#c45d9a", // magenta
] as const;

export function advancementColorByRank(rankIndex: number): string {
  const colors = ADVANCEMENT_RANK_COLORS;
  return colors[rankIndex % colors.length]!;
}

/** 지역 → 동별 단지 목록 페이지 경로 */
export function regionDongHref(
  regionSlug: string,
  dong: string,
  gu?: string,
): string {
  const base = `/region/${encodeURIComponent(regionSlug)}/dong/${encodeURIComponent(dong)}`;
  if (!gu || gu === "all") return base;
  return `${base}?gu=${encodeURIComponent(gu)}`;
}

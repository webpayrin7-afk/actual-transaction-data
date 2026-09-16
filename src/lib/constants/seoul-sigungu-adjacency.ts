/**
 * Seoul 25-gu administrative adjacency (static metadata).
 * Used for bounded cross-district 종합병원 discovery — not hospital-name lists.
 *
 * Borders follow contiguous Seoul district boundaries (river-crossing neighbors
 * included when districts share a Han River frontage interface used in common
 * administrative neighbor tables).
 */

/** Current gu → adjacent Seoul gu names (exclude self). */
export const SEOUL_SIGUNGU_ADJACENCY: Readonly<
  Record<string, readonly string[]>
> = {
  종로구: ["중구", "성북구", "동대문구", "서대문구", "은평구"],
  중구: ["종로구", "용산구", "성동구", "동대문구", "서대문구", "마포구"],
  용산구: ["중구", "성동구", "마포구", "동작구", "서초구", "강남구"],
  성동구: ["중구", "용산구", "광진구", "동대문구", "중랑구", "강남구"],
  광진구: ["성동구", "동대문구", "중랑구", "송파구", "강동구"],
  동대문구: ["종로구", "중구", "성동구", "광진구", "중랑구", "성북구"],
  중랑구: ["동대문구", "광진구", "성북구", "노원구", "강북구"],
  성북구: ["종로구", "동대문구", "중랑구", "강북구", "도봉구", "서대문구", "은평구"],
  강북구: ["성북구", "도봉구", "노원구", "중랑구"],
  도봉구: ["강북구", "노원구", "성북구"],
  노원구: ["도봉구", "강북구", "중랑구", "성북구"],
  은평구: ["종로구", "서대문구", "마포구", "성북구"],
  서대문구: ["종로구", "중구", "마포구", "은평구", "성북구"],
  마포구: ["중구", "용산구", "서대문구", "은평구", "영등포구", "양천구"],
  양천구: ["강서구", "영등포구", "구로구", "마포구"],
  강서구: ["양천구", "영등포구", "마포구"],
  구로구: ["양천구", "영등포구", "금천구", "관악구"],
  금천구: ["구로구", "영등포구", "관악구", "동작구"],
  영등포구: ["마포구", "양천구", "강서구", "구로구", "금천구", "동작구", "용산구"],
  동작구: ["용산구", "영등포구", "금천구", "관악구", "서초구"],
  관악구: ["동작구", "금천구", "구로구", "서초구"],
  서초구: ["용산구", "동작구", "관악구", "강남구"],
  강남구: ["용산구", "성동구", "서초구", "송파구"],
  송파구: ["광진구", "강남구", "강동구"],
  강동구: ["광진구", "송파구"],
};

/** Districts to query for `${district} 종합병원`: current + adjacent (stable). */
export function hospitalGeneralHospitalDistricts(
  sigungu: string | null | undefined,
): string[] {
  const current = String(sigungu || "").trim();
  if (!current) return [];
  const out: string[] = [current];
  const seen = new Set(out);
  const adjacent = SEOUL_SIGUNGU_ADJACENCY[current];
  if (adjacent) {
    for (const d of adjacent) {
      const name = String(d || "").trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

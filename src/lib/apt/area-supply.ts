/**
 * 평형 선택 목록에 공급면적 붙이기 — 거래에서 나온 전용면적 옵션에, 같은 단지 타입(apt_canonical_unit_types)의
 * 공급면적 범위를 붙인다. 전용이 0.05㎡ 안으로 같은 타입만. 이미 공급·시장 평형이 있는 옵션(시범 단지)은 그대로.
 * 한 전용에 공급이 여럿이면(호마다 공용 배분이 조금씩 다름) 최소~최대 범위 — 지도 평형과 같은 방식.
 */
import type { AptAreaOption } from "@/lib/molit/apt-client";
import type { UnitTypeInfo } from "@/lib/apt/unit-types-dongs";

export async function fetchComplexTypes(complexId: string): Promise<{ types: UnitTypeInfo[] }> {
  const res = await fetch(`/api/complex-types/${complexId}`);
  if (!res.ok) return { types: [] };
  return res.json();
}

export function attachTypeSupply(areas: AptAreaOption[], types: UnitTypeInfo[]): AptAreaOption[] {
  if (!types.length) return areas;
  return areas.map((area) => {
    const hasMarket = area.marketLabel != null && Number.isFinite(area.marketLabel);
    const hasSupply = area.supplyAreaMin != null && area.supplyAreaMax != null && area.supplyAreaMin > 0 && area.supplyAreaMax > 0;
    if (hasMarket || hasSupply) return area;
    const exMin = area.exclusiveAreaMin ?? area.exclusiveArea;
    const exMax = area.exclusiveAreaMax ?? area.exclusiveArea;
    const supplies = types
      .filter((t) => t.supplySqm != null && t.supplySqm > 0 && t.exclusiveSqm >= exMin - 0.05 && t.exclusiveSqm <= exMax + 0.05)
      .map((t) => t.supplySqm as number);
    if (!supplies.length) return area;
    return { ...area, supplyAreaMin: Math.min(...supplies), supplyAreaMax: Math.max(...supplies) };
  });
}

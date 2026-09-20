import { areaCents } from "./identity";
import { dongMatchKey } from "./dong-label";
import type { LinkStatus } from "./types";

export type CanonicalType = {
  unitTypeId: string;
  exclusiveCents: number;
  supplyCents: number;
  status: string;
  householdCount: number | null;
};

export type OfficialUnit = {
  dong: string;
  floor: string;
  ho: string;
  exclusiveArea: number | null;
  residentialCommonArea: number | null;
  officialBuildingKey?: string | null;
  sourceAsOf: string;
  sourceKey: string;
};

export type BuildingDong = {
  buildingId: string;
  dongLabel: string | null;
  residentialFlag: boolean;
  officialBuildingKey?: string | null;
};

export type TypeBuildingLink = {
  unitTypeId: string;
  buildingId: string;
  householdCount: number;
  source: string;
  sourceKey: string;
  confidence: "exact" | "hold";
  status: LinkStatus;
  sourceAsOf: string;
};

function dedupeUnits(units: OfficialUnit[]): OfficialUnit[] {
  const seen = new Map<string, OfficialUnit>();
  for (const unit of units) {
    const dong = unit.dong.trim();
    const ho = unit.ho.trim();
    if (!dong || !ho) continue;
    const key = `${dong}\t${unit.floor.trim()}\t${ho}`;
    if (!seen.has(key)) seen.set(key, unit);
  }
  return [...seen.values()];
}

function typesByExclusive(types: CanonicalType[]): Map<number, CanonicalType[]> {
  const map = new Map<number, CanonicalType[]>();
  for (const type of types) {
    const list = map.get(type.exclusiveCents);
    if (list) list.push(type);
    else map.set(type.exclusiveCents, [type]);
  }
  return map;
}

/**
 * Link official unit rows to Core canonical unit_type_id.
 * EXACT_SINGLE: exclusive match.
 * AMBIGUOUS_MULTI: only when exclusive + derived supply selects one variant.
 * Never majority-picks a supply variant.
 */
export function resolveUnitTypeId(
  exclusiveArea: number,
  residentialCommonArea: number | null,
  types: CanonicalType[],
): { unitTypeId: string | null; status: LinkStatus } {
  const ex = areaCents(exclusiveArea);
  if (ex < 0 || types.length === 0) return { unitTypeId: null, status: "NO_SOURCE" };
  const exactSingle = types.filter((t) => t.status === "EXACT_SINGLE");
  if (exactSingle.length === 1) {
    return { unitTypeId: exactSingle[0].unitTypeId, status: "EXACT" };
  }
  if (exactSingle.length > 1) {
    return { unitTypeId: null, status: "TYPE_VARIANT_AMBIGUOUS" };
  }
  const ambiguous = types.filter((t) => t.status === "AMBIGUOUS_MULTI");
  if (ambiguous.length === 0) return { unitTypeId: null, status: "NO_SOURCE" };
  if (residentialCommonArea == null || !Number.isFinite(residentialCommonArea)) {
    return { unitTypeId: null, status: "TYPE_VARIANT_AMBIGUOUS" };
  }
  const supply = areaCents(exclusiveArea + residentialCommonArea);
  const matched = ambiguous.filter((t) => t.supplyCents === supply);
  if (matched.length === 1) {
    return { unitTypeId: matched[0].unitTypeId, status: "EXACT" };
  }
  return { unitTypeId: null, status: "TYPE_VARIANT_AMBIGUOUS" };
}

export function buildTypeBuildingLinks(input: {
  units: OfficialUnit[];
  types: CanonicalType[];
  buildings: BuildingDong[];
  source: string;
}): { links: TypeBuildingLink[]; unresolvedDong: number; ambiguousType: number } {
  const units = dedupeUnits(input.units);
  const byEx = typesByExclusive(input.types);
  const buildingByKey = new Map<string, BuildingDong>();
  const buildingByDong = new Map<string, BuildingDong[]>();
  for (const b of input.buildings) {
    if (!b.residentialFlag) continue;
    if (b.officialBuildingKey) buildingByKey.set(b.officialBuildingKey, b);
    const key = dongMatchKey(b.dongLabel);
    if (!key) continue;
    const list = buildingByDong.get(key);
    if (list) list.push(b);
    else buildingByDong.set(key, [b]);
  }

  const counts = new Map<string, TypeBuildingLink>();
  let unresolvedDong = 0;
  let ambiguousType = 0;

  for (const unit of units) {
    if (unit.exclusiveArea == null) continue;
    const candidates = byEx.get(areaCents(unit.exclusiveArea)) ?? [];
    const resolved = resolveUnitTypeId(
      unit.exclusiveArea,
      unit.residentialCommonArea,
      candidates,
    );
    if (!resolved.unitTypeId) {
      if (resolved.status === "TYPE_VARIANT_AMBIGUOUS") ambiguousType += 1;
      continue;
    }
    let building: BuildingDong | undefined;
    const unitPk = (unit.officialBuildingKey ?? "").trim();
    if (unitPk) building = buildingByKey.get(unitPk);
    if (!building) {
      const dongKey = dongMatchKey(unit.dong);
      if (!dongKey) {
        unresolvedDong += 1;
        continue;
      }
      const buildings = buildingByDong.get(dongKey);
      if (!buildings || buildings.length === 0) {
        unresolvedDong += 1;
        continue;
      }
      if (buildings.length > 1) continue;
      building = buildings[0];
    }
    if (!building) continue;
    const id = `${resolved.unitTypeId}\t${building.buildingId}`;
    const prev = counts.get(id);
    if (prev) {
      prev.householdCount += 1;
      if (unit.sourceAsOf > prev.sourceAsOf) prev.sourceAsOf = unit.sourceAsOf;
    } else {
      counts.set(id, {
        unitTypeId: resolved.unitTypeId,
        buildingId: building.buildingId,
        householdCount: 1,
        source: input.source,
        sourceKey: `${building.buildingId}:${resolved.unitTypeId}`,
        confidence: "exact",
        status: "EXACT",
        sourceAsOf: unit.sourceAsOf,
      });
    }
  }

  return {
    links: [...counts.values()],
    unresolvedDong,
    ambiguousType,
  };
}

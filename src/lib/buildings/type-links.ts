import { areaCents } from "./identity";
import { dongMatchKey } from "./dong-label";
import type { LinkStatus } from "./types";

export const TYPE_BUILDING_RESOLUTIONS = [
  "EXACT_VARIANT_BUILDING",
  "EXACT_SINGLE_BUILDING",
  "EXCLUSIVE_GROUP_ONLY",
  "AMBIGUOUS_TYPE",
  "AMBIGUOUS_BUILDING",
  "NO_CANONICAL_TYPE",
  "NO_BUILDING_IDENTITY",
] as const;
export type TypeBuildingResolution = (typeof TYPE_BUILDING_RESOLUTIONS)[number];

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
  unitRegisterPk?: string | null;
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
  resolutionStatus: TypeBuildingResolution;
  sourceAsOf: string;
};

export type TypeBuildingResolutionStats = {
  physicalUnits: number;
  buildingLinkedUnits: number;
  exactVariantBuilding: number;
  exactSingleBuilding: number;
  exclusiveGroupOnly: number;
  ambiguousType: number;
  ambiguousBuilding: number;
  noCanonicalType: number;
  noBuildingIdentity: number;
  publicExactLinks: number;
};

export function emptyResolutionStats(): TypeBuildingResolutionStats {
  return {
    physicalUnits: 0,
    buildingLinkedUnits: 0,
    exactVariantBuilding: 0,
    exactSingleBuilding: 0,
    exclusiveGroupOnly: 0,
    ambiguousType: 0,
    ambiguousBuilding: 0,
    noCanonicalType: 0,
    noBuildingIdentity: 0,
    publicExactLinks: 0,
  };
}

function dedupeUnits(units: OfficialUnit[]): OfficialUnit[] {
  const seen = new Map<string, OfficialUnit>();
  for (const unit of units) {
    const dong = unit.dong.trim();
    const ho = unit.ho.trim();
    if (!dong || !ho) continue;
    const register = (unit.unitRegisterPk ?? "").trim();
    const key = register
      ? `pk:${register}`
      : `${dong}\t${unit.floor.trim()}\t${ho}`;
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

function bump(
  stats: TypeBuildingResolutionStats,
  status: TypeBuildingResolution,
): void {
  if (status === "EXACT_VARIANT_BUILDING") stats.exactVariantBuilding += 1;
  else if (status === "EXACT_SINGLE_BUILDING") stats.exactSingleBuilding += 1;
  else if (status === "EXCLUSIVE_GROUP_ONLY") stats.exclusiveGroupOnly += 1;
  else if (status === "AMBIGUOUS_TYPE") stats.ambiguousType += 1;
  else if (status === "AMBIGUOUS_BUILDING") stats.ambiguousBuilding += 1;
  else if (status === "NO_CANONICAL_TYPE") stats.noCanonicalType += 1;
  else stats.noBuildingIdentity += 1;
}

export function isPublicExactResolution(status: TypeBuildingResolution): boolean {
  return status === "EXACT_VARIANT_BUILDING" || status === "EXACT_SINGLE_BUILDING";
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
): { unitTypeId: string | null; status: LinkStatus; resolution: TypeBuildingResolution } {
  const ex = areaCents(exclusiveArea);
  if (ex < 0 || types.length === 0) {
    return { unitTypeId: null, status: "NO_SOURCE", resolution: "NO_CANONICAL_TYPE" };
  }
  const exactSingle = types.filter((t) => t.status === "EXACT_SINGLE");
  if (exactSingle.length === 1) {
    return {
      unitTypeId: exactSingle[0].unitTypeId,
      status: "EXACT",
      resolution: "EXACT_SINGLE_BUILDING",
    };
  }
  if (exactSingle.length > 1) {
    return { unitTypeId: null, status: "TYPE_VARIANT_AMBIGUOUS", resolution: "AMBIGUOUS_TYPE" };
  }
  const ambiguous = types.filter((t) => t.status === "AMBIGUOUS_MULTI");
  if (ambiguous.length === 0) {
    return { unitTypeId: null, status: "NO_SOURCE", resolution: "NO_CANONICAL_TYPE" };
  }
  if (residentialCommonArea == null || !Number.isFinite(residentialCommonArea)) {
    return {
      unitTypeId: null,
      status: "TYPE_VARIANT_AMBIGUOUS",
      resolution: "EXCLUSIVE_GROUP_ONLY",
    };
  }
  const supply = areaCents(exclusiveArea + residentialCommonArea);
  const matched = ambiguous.filter((t) => t.supplyCents === supply);
  if (matched.length === 1) {
    return {
      unitTypeId: matched[0].unitTypeId,
      status: "EXACT",
      resolution: "EXACT_VARIANT_BUILDING",
    };
  }
  if (matched.length === 0 && ambiguous.length > 1) {
    return { unitTypeId: null, status: "TYPE_VARIANT_AMBIGUOUS", resolution: "EXCLUSIVE_GROUP_ONLY" };
  }
  return { unitTypeId: null, status: "TYPE_VARIANT_AMBIGUOUS", resolution: "AMBIGUOUS_TYPE" };
}

export function resolveBuildingIdentity(
  unit: OfficialUnit,
  buildingByKey: Map<string, BuildingDong>,
  buildingByDong: Map<string, BuildingDong[]>,
): { building: BuildingDong | null; status: "ok" | "AMBIGUOUS_BUILDING" | "NO_BUILDING_IDENTITY" } {
  const unitPk = (unit.officialBuildingKey ?? "").trim();
  if (unitPk) {
    const hit = buildingByKey.get(unitPk);
    if (hit) return { building: hit, status: "ok" };
  }
  const dongKey = dongMatchKey(unit.dong);
  if (!dongKey) return { building: null, status: "NO_BUILDING_IDENTITY" };
  const buildings = buildingByDong.get(dongKey);
  if (!buildings || buildings.length === 0) return { building: null, status: "NO_BUILDING_IDENTITY" };
  if (buildings.length > 1) return { building: null, status: "AMBIGUOUS_BUILDING" };
  return { building: buildings[0], status: "ok" };
}

export function buildTypeBuildingLinks(input: {
  units: OfficialUnit[];
  types: CanonicalType[];
  buildings: BuildingDong[];
  source: string;
}): {
  links: TypeBuildingLink[];
  unresolvedDong: number;
  ambiguousType: number;
  stats: TypeBuildingResolutionStats;
} {
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
  const stats = emptyResolutionStats();
  stats.physicalUnits = units.length;
  let unresolvedDong = 0;
  let ambiguousType = 0;

  for (const unit of units) {
    if (unit.exclusiveArea == null) {
      bump(stats, "NO_CANONICAL_TYPE");
      continue;
    }
    const buildingHit = resolveBuildingIdentity(unit, buildingByKey, buildingByDong);
    if (buildingHit.status !== "ok" || !buildingHit.building) {
      bump(stats, buildingHit.status);
      if (buildingHit.status === "NO_BUILDING_IDENTITY") unresolvedDong += 1;
      continue;
    }
    stats.buildingLinkedUnits += 1;
    const candidates = byEx.get(areaCents(unit.exclusiveArea)) ?? [];
    const resolved = resolveUnitTypeId(
      unit.exclusiveArea,
      unit.residentialCommonArea,
      candidates,
    );
    if (!resolved.unitTypeId || !isPublicExactResolution(resolved.resolution)) {
      bump(stats, resolved.resolution);
      if (resolved.status === "TYPE_VARIANT_AMBIGUOUS") ambiguousType += 1;
      continue;
    }
    bump(stats, resolved.resolution);
    const building = buildingHit.building;
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
        resolutionStatus: resolved.resolution,
        sourceAsOf: unit.sourceAsOf,
      });
    }
  }

  const links = [...counts.values()];
  stats.publicExactLinks = links.length;
  return { links, unresolvedDong, ambiguousType, stats };
}

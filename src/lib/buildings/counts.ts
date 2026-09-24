import { areaCents } from "./identity";
import { resolveUnitTypeId, type CanonicalType, type OfficialUnit } from "./type-links";
import type { CountStatus } from "./types";

export type { CountStatus };
export { COUNT_STATUSES } from "./types";

export type DerivedTypeCount = {
  unitTypeId: string;
  exclusiveCents: number;
  supplyCents: number | null;
  householdCount: number | null;
  countStatus: CountStatus;
  uiSafe: boolean;
  source: string;
  provenance: Record<string, unknown>;
};

export type DerivedGroupCount = {
  exclusiveCents: number;
  householdCount: number | null;
  variantCount: number;
  countStatus: CountStatus;
  source: string;
  provenance: Record<string, unknown>;
};

function uiSafe(status: CountStatus): boolean {
  return status === "EXACT_VARIANT_COUNT" || status === "EXACT_SINGLE_VARIANT_COUNT";
}

function dedupePhysical(units: OfficialUnit[]): OfficialUnit[] {
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

function groupTypes(types: CanonicalType[]): Map<number, CanonicalType[]> {
  const map = new Map<number, CanonicalType[]>();
  for (const type of types) {
    const list = map.get(type.exclusiveCents);
    if (list) list.push(type);
    else map.set(type.exclusiveCents, [type]);
  }
  return map;
}

function sameCopiedAggregate(group: CanonicalType[]): boolean {
  const counts = group
    .map((t) => t.householdCount)
    .filter((n): n is number => n != null && Number.isFinite(n) && n > 0);
  if (counts.length < 2) return false;
  return counts.every((n) => n === counts[0]);
}

/**
 * Physical household semantics.
 * Unit-level official rows count a physical unit once, on its exact supply variant
 * when that variant is deterministic. Exclusive-area aggregates are never copied
 * onto every supply variant.
 */
export function deriveHouseholdCounts(input: {
  types: CanonicalType[];
  units: OfficialUnit[];
}): { types: DerivedTypeCount[]; groups: DerivedGroupCount[] } {
  const byEx = groupTypes(input.types);
  const physical = dedupePhysical(input.units);
  const unitTypeCounts = new Map<string, number>();
  const unitGroupCounts = new Map<number, number>();
  let resolvedUnits = 0;
  let ambiguousUnits = 0;

  for (const unit of physical) {
    if (unit.exclusiveArea == null) continue;
    const ex = areaCents(unit.exclusiveArea);
    unitGroupCounts.set(ex, (unitGroupCounts.get(ex) ?? 0) + 1);
    const candidates = byEx.get(ex) ?? [];
    const resolved = resolveUnitTypeId(unit.exclusiveArea, unit.residentialCommonArea, candidates);
    if (!resolved.unitTypeId) {
      if (resolved.status === "TYPE_VARIANT_AMBIGUOUS") ambiguousUnits += 1;
      continue;
    }
    resolvedUnits += 1;
    unitTypeCounts.set(resolved.unitTypeId, (unitTypeCounts.get(resolved.unitTypeId) ?? 0) + 1);
  }

  const hasPhysical = physical.length > 0;
  const typeRows: DerivedTypeCount[] = [];
  const groupRows: DerivedGroupCount[] = [];

  for (const [exclusiveCents, group] of byEx) {
    const variantCount = group.length;
    const unitGroup = unitGroupCounts.get(exclusiveCents) ?? null;
    const copied = variantCount > 1 && sameCopiedAggregate(group);

    if (hasPhysical) {
      const assigned = group.reduce((n, t) => n + (unitTypeCounts.get(t.unitTypeId) ?? 0), 0);
      const groupStatus: CountStatus =
        ambiguousUnits > 0 && assigned === 0 && (unitGroup ?? 0) > 0
          ? "EXCLUSIVE_GROUP_ONLY"
          : unitGroup != null && unitGroup > 0
            ? assigned === unitGroup
              ? variantCount === 1
                ? "EXACT_SINGLE_VARIANT_COUNT"
                : "EXACT_VARIANT_COUNT"
              : assigned > 0
                ? "PARTIAL_UNIT_EVIDENCE"
                : "EXCLUSIVE_GROUP_ONLY"
            : "NO_SOURCE";
      groupRows.push({
        exclusiveCents,
        householdCount: unitGroup,
        variantCount,
        countStatus: groupStatus === "EXACT_VARIANT_COUNT" && variantCount === 1
          ? "EXACT_SINGLE_VARIANT_COUNT"
          : groupStatus,
        source: "official_unit_area_cache.BldRgstHubService",
        provenance: { physical: unitGroup, assigned, ambiguousUnits },
      });
      for (const type of group) {
        const n = unitTypeCounts.get(type.unitTypeId) ?? null;
        let countStatus: CountStatus;
        if (n != null && n > 0) {
          countStatus = variantCount === 1 ? "EXACT_SINGLE_VARIANT_COUNT" : "EXACT_VARIANT_COUNT";
        } else if ((unitGroup ?? 0) > 0) {
          countStatus = "EXCLUSIVE_GROUP_ONLY";
        } else {
          countStatus = type.householdCount == null ? "NO_SOURCE" : "PARTIAL_UNIT_EVIDENCE";
        }
        typeRows.push({
          unitTypeId: type.unitTypeId,
          exclusiveCents,
          supplyCents: type.supplyCents,
          householdCount: n != null && n > 0 ? n : null,
          countStatus,
          uiSafe: uiSafe(countStatus),
          source: "official_unit_area_cache.BldRgstHubService",
          provenance: { physicalGroup: unitGroup, assigned: n ?? 0 },
        });
      }
      continue;
    }

    if (variantCount === 1) {
      const type = group[0];
      const status: CountStatus =
        type.householdCount != null && type.householdCount > 0
          ? "EXACT_SINGLE_VARIANT_COUNT"
          : "NO_SOURCE";
      typeRows.push({
        unitTypeId: type.unitTypeId,
        exclusiveCents,
        supplyCents: type.supplyCents,
        householdCount: type.householdCount,
        countStatus: status,
        uiSafe: uiSafe(status),
        source: "apt_canonical_unit_types",
        provenance: { coreStatus: type.status },
      });
      groupRows.push({
        exclusiveCents,
        householdCount: type.householdCount,
        variantCount,
        countStatus: status,
        source: "apt_canonical_unit_types",
        provenance: { coreStatus: type.status },
      });
      continue;
    }

    if (copied) {
      const copiedCount = group.find((t) => t.householdCount != null)?.householdCount ?? null;
      groupRows.push({
        exclusiveCents,
        householdCount: copiedCount,
        variantCount,
        countStatus: "EXCLUSIVE_GROUP_ONLY",
        source: "apt_canonical_unit_types",
        provenance: { duplicatedVariantHousehold: copiedCount },
      });
      for (const type of group) {
        typeRows.push({
          unitTypeId: type.unitTypeId,
          exclusiveCents,
          supplyCents: type.supplyCents,
          householdCount: null,
          countStatus: "EXCLUSIVE_GROUP_ONLY",
          uiSafe: false,
          source: "apt_canonical_unit_types",
          provenance: { copiedAggregate: type.householdCount },
        });
      }
      continue;
    }

    const coreCounts = group.map((t) => t.householdCount).filter((n): n is number => n != null);
    groupRows.push({
      exclusiveCents,
      householdCount: null,
      variantCount,
      countStatus: coreCounts.length ? "PARTIAL_UNIT_EVIDENCE" : "NO_SOURCE",
      source: "apt_canonical_unit_types",
      provenance: { variantHouseholds: group.map((t) => t.householdCount) },
    });
    for (const type of group) {
      typeRows.push({
        unitTypeId: type.unitTypeId,
        exclusiveCents,
        supplyCents: type.supplyCents,
        householdCount: null,
        countStatus: type.householdCount == null ? "NO_SOURCE" : "PARTIAL_UNIT_EVIDENCE",
        uiSafe: false,
        source: "apt_canonical_unit_types",
        provenance: { coreHousehold: type.householdCount },
      });
    }
  }

  return { types: typeRows, groups: groupRows };
}

export function uiSafeTypeSum(rows: DerivedTypeCount[]): number {
  return rows.reduce((n, row) => n + (row.uiSafe && row.householdCount ? row.householdCount : 0), 0);
}

export function displayedExceedsPhysical(
  uiSafeSum: number,
  physical: number | null,
): boolean {
  if (physical == null || physical <= 0) return false;
  return uiSafeSum > physical;
}

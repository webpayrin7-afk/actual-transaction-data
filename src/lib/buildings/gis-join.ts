import { officialKeyFromTitlePk } from "./identity";

export type GisFeature = {
  properties: Record<string, unknown>;
  geometry: { type: string; coordinates: unknown };
};

export type GisJoin = {
  buildingKey: string | null;
  sourceGeometryId: string | null;
  pnu: string | null;
  status: "MATCHED" | "GEOMETRY_IDENTITY_UNRESOLVED";
  evidence: string;
};

function str(props: Record<string, unknown>, names: string[]): string | null {
  const keys = Object.keys(props);
  for (const want of names) {
    const hit = keys.find((k) => k.replace(/[^a-z0-9]/gi, "").toLowerCase() === want);
    if (!hit) continue;
    const v = props[hit];
    const s = v == null ? "" : String(v).trim();
    if (s) return s;
  }
  return null;
}

export function discoverGisIdentity(props: Record<string, unknown>): {
  bldrgstPk: string | null;
  ufid: string | null;
  pnu: string | null;
  bdMgtSn: string | null;
} {
  return {
    bldrgstPk: str(props, ["bldrgstpk", "mgmbldrgstpk", "buildingregisterpk"]),
    ufid: str(props, ["ufid", "a1", "gisbuildingid"]),
    pnu: str(props, ["pnu", "a2", "bldgpnu"]),
    bdMgtSn: str(props, ["bdmgtsn", "bldmgtsn", "buildingmanagementsn"]),
  };
}

export function pnuUniqueJoinAllowed(gisCount: number, buildingCount: number): boolean {
  return gisCount === 1 && buildingCount === 1;
}

/**
 * Join GIS footprint using official register identity only.
 * Never dong-name, nearest centroid, polygon proximity, or apartment name.
 */
export function joinGisFeature(
  feature: GisFeature,
  buildingsByPk: Map<string, { officialBuildingKey: string }>,
  pnuBuildingKeys: Map<string, string[]>,
  pnuGisCount: Map<string, number>,
): GisJoin {
  const id = discoverGisIdentity(feature.properties);
  const pk = id.bldrgstPk ? officialKeyFromTitlePk(id.bldrgstPk) : null;
  const sourceGeometryId = id.ufid ?? id.bdMgtSn ?? pk;
  if (pk && buildingsByPk.has(pk)) {
    return {
      buildingKey: pk,
      sourceGeometryId,
      pnu: id.pnu,
      status: "MATCHED",
      evidence: "official_building_register_pk",
    };
  }
  if (id.pnu) {
    const buildingKeys = pnuBuildingKeys.get(id.pnu) ?? [];
    const gisCount = pnuGisCount.get(id.pnu) ?? 0;
    if (pnuUniqueJoinAllowed(gisCount, buildingKeys.length)) {
      return {
        buildingKey: buildingKeys[0],
        sourceGeometryId,
        pnu: id.pnu,
        status: "MATCHED",
        evidence: "exact_pnu_unique_building",
      };
    }
  }
  return {
    buildingKey: null,
    sourceGeometryId,
    pnu: id.pnu,
    status: "GEOMETRY_IDENTITY_UNRESOLVED",
    evidence: pk ? "register_pk_not_in_inventory" : "missing_register_pk_or_nonunique_pnu",
  };
}

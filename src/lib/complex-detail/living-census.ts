/**
 * SEMAS living census per complex (complex_living_snapshots, current publication).
 * Read-only. Counts only — no business identity, no map points.
 * Taxonomy is living_semas_v1 (FOOD/MEDICAL/CAFE/…), not the 잠실엘스 commerce pilot buckets.
 */
import type { Client } from "@libsql/client";

export const LIVING_CENSUS_RADII = [500, 1000] as const;
export type LivingCensusRadius = (typeof LIVING_CENSUS_RADII)[number];

export type LivingCensusFacilityKey =
  | "MEDICAL"
  | "PHARMACY"
  | "CONVENIENCE"
  | "GROCERY"
  | "CAFE"
  | "FOOD"
  | "SPORTS";

export type LivingCensusRadiusData = {
  facilities: Record<LivingCensusFacilityKey, number>;
  /** FOOD subcategories, largest first (count > 0). */
  food: Array<{ key: string; count: number }>;
  /** MEDICAL subcategories, largest first (count > 0). */
  medical: Array<{ key: string; count: number }>;
};

export type LivingCensus = {
  complexId: string;
  sourceVersion: string;
  sourceDataset: string;
  sourceAsOf: string;
  radii: Record<LivingCensusRadius, LivingCensusRadiusData>;
};

function emptyRadius(): LivingCensusRadiusData {
  return {
    facilities: {
      MEDICAL: 0,
      PHARMACY: 0,
      CONVENIENCE: 0,
      GROCERY: 0,
      CAFE: 0,
      FOOD: 0,
      SPORTS: 0,
    },
    food: [],
    medical: [],
  };
}

export async function readLivingCensus(
  db: Client,
  complexId: string,
): Promise<LivingCensus | null> {
  const pub = await db.execute({
    sql: `SELECT source_version, snapshot_version, source_dataset, source_as_of
          FROM complex_living_publications
          WHERE is_current = 1
          ORDER BY built_at DESC
          LIMIT 1`,
    args: [],
  });
  const current = pub.rows[0];
  if (!current) return null;

  const res = await db.execute({
    sql: `SELECT radius_m, product_category, product_subcategory, facility_count
          FROM complex_living_snapshots
          WHERE complex_id = ? AND source_version = ? AND snapshot_version = ?
            AND quality_status = 'COMPLETE'`,
    args: [complexId, String(current.source_version), String(current.snapshot_version)],
  });
  if (res.rows.length === 0) return null;

  const radii = { 500: emptyRadius(), 1000: emptyRadius() } as LivingCensus["radii"];
  for (const row of res.rows) {
    const radius = Number(row.radius_m) as LivingCensusRadius;
    const bucket = radii[radius];
    if (!bucket) continue;
    const category = String(row.product_category);
    const sub = String(row.product_subcategory);
    const count = Number(row.facility_count) || 0;
    if (category === "ETC" && sub === "PHARMACY") bucket.facilities.PHARMACY += count;
    else if (category in bucket.facilities) {
      bucket.facilities[category as LivingCensusFacilityKey] += count;
    }
    if (count > 0 && category === "FOOD") bucket.food.push({ key: sub, count });
    if (count > 0 && category === "MEDICAL") bucket.medical.push({ key: sub, count });
  }
  for (const r of LIVING_CENSUS_RADII) {
    radii[r].food.sort((a, b) => b.count - a.count);
    radii[r].medical.sort((a, b) => b.count - a.count);
  }

  return {
    complexId,
    sourceVersion: String(current.source_version),
    sourceDataset: String(current.source_dataset),
    sourceAsOf: String(current.source_as_of),
    radii,
  };
}

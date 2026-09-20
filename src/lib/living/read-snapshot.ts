import type { Client } from "@libsql/client";
import rules from "@/lib/living/category-rules.json";

export const LIVING_RADII_M = [500, 1000] as const;

export type LivingCategoryBlock = {
  category: string;
  count: number;
  qualityStatus: "COMPLETE";
  subcategories: Array<{ subcategory: string; count: number }>;
};

export type LivingHeldCategory = {
  category: string;
  qualityStatus: "NO_SOURCE";
  reason: string;
};

export type LivingSnapshotResponse = {
  complexId: string;
  radiusM: number;
  sourceVersion: string | null;
  sourceAsOf: string | null;
  snapshotVersion: string | null;
  ruleVersion: string | null;
  coordinateSemantics: string | null;
  distanceMetric: string | null;
  qualityStatus: string;
  categories: LivingCategoryBlock[];
  held: LivingHeldCategory[];
};

const HELD: LivingHeldCategory[] = rules.held.map((row) => ({
  category: row.category,
  qualityStatus: "NO_SOURCE",
  reason: row.reason,
}));

type SnapRow = {
  product_category: string;
  product_subcategory: string;
  facility_count: number;
  quality_status: string;
  coordinate_semantics: string;
  distance_metric: string;
  source_as_of: string;
  rule_version: string;
};

export async function readComplexLiving(
  db: Client,
  complexId: string,
  radiusM: number,
): Promise<LivingSnapshotResponse> {
  const empty = (
    qualityStatus: string,
    extra: Partial<LivingSnapshotResponse> = {},
  ): LivingSnapshotResponse => ({
    complexId,
    radiusM,
    sourceVersion: null,
    sourceAsOf: null,
    snapshotVersion: null,
    ruleVersion: null,
    coordinateSemantics: null,
    distanceMetric: null,
    qualityStatus,
    categories: [],
    held: HELD,
    ...extra,
  });

  const pub = await db.execute(
    `SELECT source_version, snapshot_version, rule_version, source_as_of
     FROM complex_living_publications
     WHERE is_current = 1
     ORDER BY built_at DESC
     LIMIT 1`,
  );
  const current = pub.rows[0];
  if (!current) return empty("NO_SNAPSHOT");

  const sourceVersion = String(current.source_version);
  const snapshotVersion = String(current.snapshot_version);
  const ruleVersion = String(current.rule_version);
  const sourceAsOf = String(current.source_as_of);

  const ready = await db.execute({
    sql: `SELECT quality_status, coordinate_semantics
          FROM complex_living_readiness
          WHERE complex_id = ? AND source_version = ? AND snapshot_version = ?
          LIMIT 1`,
    args: [complexId, sourceVersion, snapshotVersion],
  });
  const readiness = ready.rows[0];
  if (!readiness) {
    return empty("NO_SNAPSHOT", {
      sourceVersion,
      sourceAsOf,
      snapshotVersion,
      ruleVersion,
    });
  }

  const qualityStatus = String(readiness.quality_status);
  if (qualityStatus !== "COMPLETE") {
    return empty(qualityStatus, {
      sourceVersion,
      sourceAsOf,
      snapshotVersion,
      ruleVersion,
      coordinateSemantics: readiness.coordinate_semantics
        ? String(readiness.coordinate_semantics)
        : null,
    });
  }

  const snaps = await db.execute({
    sql: `SELECT product_category, product_subcategory, facility_count,
                 quality_status, coordinate_semantics, distance_metric,
                 source_as_of, rule_version
          FROM complex_living_snapshots
          WHERE complex_id = ?
            AND radius_m = ?
            AND source_version = ?
            AND snapshot_version = ?`,
    args: [complexId, radiusM, sourceVersion, snapshotVersion],
  });

  const grouped = new Map<string, LivingCategoryBlock>();
  let coordinateSemantics: string | null = null;
  let distanceMetric: string | null = null;
  for (const raw of snaps.rows) {
    const row = raw as unknown as SnapRow;
    coordinateSemantics = String(row.coordinate_semantics);
    distanceMetric = String(row.distance_metric);
    const category = String(row.product_category);
    const block = grouped.get(category) ?? {
      category,
      count: 0,
      qualityStatus: "COMPLETE" as const,
      subcategories: [],
    };
    const count = Number(row.facility_count);
    block.count += count;
    if (count > 0) {
      block.subcategories.push({
        subcategory: String(row.product_subcategory),
        count,
      });
    }
    grouped.set(category, block);
  }

  const categories = [...grouped.values()].map((block) => ({
    ...block,
    subcategories: block.subcategories.sort((a, b) =>
      b.count - a.count || a.subcategory.localeCompare(b.subcategory),
    ),
  }));
  categories.sort((a, b) => a.category.localeCompare(b.category));

  return {
    complexId,
    radiusM,
    sourceVersion,
    sourceAsOf,
    snapshotVersion,
    ruleVersion,
    coordinateSemantics,
    distanceMetric,
    qualityStatus: "COMPLETE",
    categories,
    held: HELD,
  };
}

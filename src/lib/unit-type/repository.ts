import type { Client } from "@libsql/client";
import { getDb, ensureSchema } from "@/lib/db/client";
import type {
  AptComplexClassification,
  AptPyeongGroupRow,
  AptUnitTypeGroupLinkRow,
  AptUnitTypeRow,
  UnitTypeMasterBundle,
} from "@/lib/unit-type/types";

const UNIT_TYPE_DDL = `
CREATE TABLE IF NOT EXISTS apt_complex_classifications (
  complex_key TEXT PRIMARY KEY,
  apt_name_norm TEXT NOT NULL,
  lawd_cd TEXT NOT NULL,
  gu TEXT NOT NULL DEFAULT '',
  classification TEXT NOT NULL,
  singoga_mode TEXT NOT NULL,
  label_confidence REAL,
  group_confidence_high INTEGER NOT NULL DEFAULT 0,
  source_phase TEXT NOT NULL DEFAULT '',
  provenance_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_apt_complex_class_name
  ON apt_complex_classifications (apt_name_norm);

CREATE TABLE IF NOT EXISTS apt_unit_types (
  unit_type_key TEXT PRIMARY KEY,
  complex_key TEXT NOT NULL,
  supply_area_sqm REAL,
  exclusive_area_min REAL NOT NULL,
  exclusive_area_max REAL NOT NULL,
  household_count INTEGER,
  mapping_confidence TEXT,
  exclusive_includes_partial_common INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_apt_unit_types_complex
  ON apt_unit_types (complex_key);

CREATE TABLE IF NOT EXISTS apt_pyeong_groups (
  group_key TEXT PRIMARY KEY,
  complex_key TEXT NOT NULL,
  market_label INTEGER,
  display_mode TEXT NOT NULL,
  supply_area_min REAL,
  supply_area_max REAL,
  exclusive_area_min REAL NOT NULL,
  exclusive_area_max REAL NOT NULL,
  household_count INTEGER,
  confidence TEXT,
  group_confidence_high INTEGER NOT NULL DEFAULT 0,
  label_null_reason TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_apt_pyeong_groups_complex
  ON apt_pyeong_groups (complex_key);

CREATE TABLE IF NOT EXISTS apt_unit_type_group_links (
  unit_type_key TEXT NOT NULL,
  group_key TEXT NOT NULL,
  complex_key TEXT NOT NULL,
  is_outlier INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (unit_type_key, group_key)
);
CREATE INDEX IF NOT EXISTS idx_apt_unit_type_links_complex
  ON apt_unit_type_group_links (complex_key);
`;

export async function ensureUnitTypeSchema(
  db: Client = getDb()!,
): Promise<void> {
  await ensureSchema(db);
  await db.executeMultiple(UNIT_TYPE_DDL);
}

export async function replacePilotMasterBundles(
  bundles: UnitTypeMasterBundle[],
  db: Client = getDb()!,
): Promise<{
  classifications: number;
  unitTypes: number;
  groups: number;
  links: number;
}> {
  await ensureUnitTypeSchema(db);
  const keys = bundles.map((b) => b.classification.complexKey);
  for (const key of keys) {
    await db.execute({
      sql: `DELETE FROM apt_unit_type_group_links WHERE complex_key = ?`,
      args: [key],
    });
    await db.execute({
      sql: `DELETE FROM apt_unit_types WHERE complex_key = ?`,
      args: [key],
    });
    await db.execute({
      sql: `DELETE FROM apt_pyeong_groups WHERE complex_key = ?`,
      args: [key],
    });
    await db.execute({
      sql: `DELETE FROM apt_complex_classifications WHERE complex_key = ?`,
      args: [key],
    });
  }

  let unitTypes = 0;
  let groups = 0;
  let links = 0;
  for (const bundle of bundles) {
    const c = bundle.classification;
    await db.execute({
      sql: `INSERT INTO apt_complex_classifications (
        complex_key, apt_name_norm, lawd_cd, gu, classification, singoga_mode,
        label_confidence, group_confidence_high, source_phase, provenance_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        c.complexKey,
        c.aptNameNorm,
        c.lawdCd,
        c.gu,
        c.classification,
        c.singogaMode,
        c.labelConfidence,
        c.groupConfidenceHigh ? 1 : 0,
        c.sourcePhase,
        c.provenanceJson,
        c.updatedAt,
      ],
    });
    for (const ut of bundle.unitTypes) {
      await db.execute({
        sql: `INSERT INTO apt_unit_types (
          unit_type_key, complex_key, supply_area_sqm, exclusive_area_min, exclusive_area_max,
          household_count, mapping_confidence, exclusive_includes_partial_common, source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          ut.unitTypeKey,
          ut.complexKey,
          ut.supplyAreaSqm,
          ut.exclusiveAreaMin,
          ut.exclusiveAreaMax,
          ut.householdCount,
          ut.mappingConfidence,
          ut.exclusiveIncludesPartialCommon ? 1 : 0,
          ut.source,
        ],
      });
      unitTypes += 1;
    }
    for (const g of bundle.groups) {
      await db.execute({
        sql: `INSERT INTO apt_pyeong_groups (
          group_key, complex_key, market_label, display_mode,
          supply_area_min, supply_area_max, exclusive_area_min, exclusive_area_max,
          household_count, confidence, group_confidence_high, label_null_reason,
          sort_order, source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          g.groupKey,
          g.complexKey,
          g.marketLabel,
          g.displayMode,
          g.supplyAreaMin,
          g.supplyAreaMax,
          g.exclusiveAreaMin,
          g.exclusiveAreaMax,
          g.householdCount,
          g.confidence,
          g.groupConfidenceHigh ? 1 : 0,
          g.labelNullReason,
          g.sortOrder,
          g.source,
        ],
      });
      groups += 1;
    }
    for (const link of bundle.links) {
      await db.execute({
        sql: `INSERT INTO apt_unit_type_group_links (
          unit_type_key, group_key, complex_key, is_outlier
        ) VALUES (?, ?, ?, ?)`,
        args: [
          link.unitTypeKey,
          link.groupKey,
          link.complexKey,
          link.isOutlier ? 1 : 0,
        ],
      });
      links += 1;
    }
  }
  return {
    classifications: bundles.length,
    unitTypes,
    groups,
    links,
  };
}

function mapClassification(row: Record<string, unknown>): AptComplexClassification {
  return {
    complexKey: String(row.complex_key),
    aptNameNorm: String(row.apt_name_norm),
    lawdCd: String(row.lawd_cd),
    gu: String(row.gu ?? ""),
    classification: String(row.classification) as AptComplexClassification["classification"],
    singogaMode: String(row.singoga_mode) as AptComplexClassification["singogaMode"],
    labelConfidence:
      row.label_confidence == null ? null : Number(row.label_confidence),
    groupConfidenceHigh: Number(row.group_confidence_high) === 1,
    sourcePhase: String(row.source_phase ?? ""),
    provenanceJson: String(row.provenance_json ?? "{}"),
    updatedAt: String(row.updated_at ?? ""),
  };
}

function mapGroup(row: Record<string, unknown>): AptPyeongGroupRow {
  return {
    groupKey: String(row.group_key),
    complexKey: String(row.complex_key),
    marketLabel: row.market_label == null ? null : Number(row.market_label),
    displayMode: String(row.display_mode) as AptPyeongGroupRow["displayMode"],
    supplyAreaMin: row.supply_area_min == null ? null : Number(row.supply_area_min),
    supplyAreaMax: row.supply_area_max == null ? null : Number(row.supply_area_max),
    exclusiveAreaMin: Number(row.exclusive_area_min),
    exclusiveAreaMax: Number(row.exclusive_area_max),
    householdCount:
      row.household_count == null ? null : Number(row.household_count),
    confidence: row.confidence == null ? null : String(row.confidence),
    groupConfidenceHigh: Number(row.group_confidence_high) === 1,
    labelNullReason:
      row.label_null_reason == null ? null : String(row.label_null_reason),
    sortOrder: Number(row.sort_order ?? 0),
    source: String(row.source ?? ""),
  };
}

export async function loadUnitTypeMasterByAptName(
  aptNameNorm: string,
  db: Client | null = getDb(),
): Promise<UnitTypeMasterBundle | null> {
  if (!db) return null;
  try {
    await ensureUnitTypeSchema(db);
  } catch {
    // schema create may fail on read-only; still try SELECT
  }
  const classRes = await db.execute({
    sql: `SELECT * FROM apt_complex_classifications WHERE apt_name_norm = ? LIMIT 1`,
    args: [aptNameNorm.replace(/\s+/g, "")],
  });
  if (classRes.rows.length === 0) return null;
  const classification = mapClassification(
    classRes.rows[0] as Record<string, unknown>,
  );
  const complexKey = classification.complexKey;
  const [utRes, gRes, linkRes] = await Promise.all([
    db.execute({
      sql: `SELECT * FROM apt_unit_types WHERE complex_key = ?`,
      args: [complexKey],
    }),
    db.execute({
      sql: `SELECT * FROM apt_pyeong_groups WHERE complex_key = ? ORDER BY sort_order`,
      args: [complexKey],
    }),
    db.execute({
      sql: `SELECT * FROM apt_unit_type_group_links WHERE complex_key = ?`,
      args: [complexKey],
    }),
  ]);

  const unitTypes: AptUnitTypeRow[] = utRes.rows.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      unitTypeKey: String(r.unit_type_key),
      complexKey: String(r.complex_key),
      supplyAreaSqm: r.supply_area_sqm == null ? null : Number(r.supply_area_sqm),
      exclusiveAreaMin: Number(r.exclusive_area_min),
      exclusiveAreaMax: Number(r.exclusive_area_max),
      householdCount:
        r.household_count == null ? null : Number(r.household_count),
      mappingConfidence:
        r.mapping_confidence == null ? null : String(r.mapping_confidence),
      exclusiveIncludesPartialCommon:
        Number(r.exclusive_includes_partial_common) === 1,
      source: String(r.source ?? ""),
    };
  });

  const groups = gRes.rows.map((row) =>
    mapGroup(row as Record<string, unknown>),
  );

  const links: AptUnitTypeGroupLinkRow[] = linkRes.rows.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      unitTypeKey: String(r.unit_type_key),
      groupKey: String(r.group_key),
      complexKey: String(r.complex_key),
      isOutlier: Number(r.is_outlier) === 1,
    };
  });

  return { classification, unitTypes, groups, links };
}

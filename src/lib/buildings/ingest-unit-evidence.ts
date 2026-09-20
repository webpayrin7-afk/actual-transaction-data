import { createReadStream, existsSync } from "node:fs";
import { createGunzip } from "node:zlib";
import readline from "node:readline";
import { resolve } from "node:path";
import type { Client } from "@libsql/client";
import { officialKeyFromTitlePk } from "./identity";
import {
  buildTypeBuildingLinks,
  type CanonicalType,
  type OfficialUnit,
} from "./type-links";
import { upsertResolutionStats, upsertTypeBuildingLinks } from "./repository";
import { mapUnitEvidenceColumns, parseDelimitedHeader, splitCsvLine, cell } from "./unit-evidence";

export const COMPACT_CANDIDATE_PATHS = [
  process.env.UNIT_EVIDENCE_PATH,
  "data/poc/building-topology/national_unit_building_evidence.csv.gz",
  "C:\\data\\buildinghub\\2026-08\\filtered\\national_unit_building_evidence.csv.gz",
  "/data/buildinghub/2026-08/filtered/national_unit_building_evidence.csv.gz",
].filter((p): p is string => Boolean(p));

export function findCompactArtifact(): string | null {
  for (const path of COMPACT_CANDIDATE_PATHS) {
    const abs = resolve(path);
    if (existsSync(abs)) return abs;
  }
  return null;
}

function num(value: string): number | null {
  if (!value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function loadCompactUnits(path: string): Promise<Map<string, OfficialUnit[]>> {
  const rl = readline.createInterface({
    input: createReadStream(path).pipe(createGunzip()),
    crlfDelay: Infinity,
  });
  let mapping: ReturnType<typeof mapUnitEvidenceColumns> | null = null;
  let delimiter: string = ",";
  const byComplex = new Map<string, OfficialUnit[]>();
  for await (const line of rl) {
    if (!line.trim()) continue;
    if (!mapping) {
      const parsed = parseDelimitedHeader(line);
      mapping = mapUnitEvidenceColumns(parsed.header);
      delimiter = parsed.delimiter;
      if (!mapping.complexId || (!mapping.dong && !mapping.ho && !mapping.parentBuildingPk)) {
        throw new Error("compact artifact missing required identity columns");
      }
      continue;
    }
    const cols = splitCsvLine(line, delimiter);
    const complexId = cell(cols, mapping, mapping.complexId);
    if (!complexId) continue;
    const parent = officialKeyFromTitlePk(cell(cols, mapping, mapping.parentBuildingPk));
    const unit: OfficialUnit = {
      dong: cell(cols, mapping, mapping.dong),
      floor: cell(cols, mapping, mapping.floor),
      ho: cell(cols, mapping, mapping.ho),
      exclusiveArea: num(cell(cols, mapping, mapping.exclusiveArea) || cell(cols, mapping, mapping.area)),
      residentialCommonArea: num(cell(cols, mapping, mapping.residentialCommon)),
      officialBuildingKey: parent,
      unitRegisterPk: cell(cols, mapping, mapping.unitPk) || null,
      sourceAsOf: cell(cols, mapping, mapping.sourceVersion) || "2026-08",
      sourceKey: cell(cols, mapping, mapping.sourceRow) || "",
    };
    const list = byComplex.get(complexId);
    if (list) list.push(unit);
    else byComplex.set(complexId, [unit]);
  }
  return byComplex;
}

export async function ingestCompactUnitEvidence(
  db: Client,
  path: string,
  apply: boolean,
): Promise<{
  artifact: string;
  complexes: number;
  physicalUnits: number;
  publicExactLinks: number;
  inserted: number;
  skippedPositive: number;
}> {
  const byComplex = await loadCompactUnits(path);
  let physicalUnits = 0;
  let publicExactLinks = 0;
  let inserted = 0;
  let skippedPositive = 0;
  for (const [complexId, units] of byComplex) {
    physicalUnits += units.length;
    const typesRes = await db.execute({
      sql: `SELECT unit_type_id, exclusive_cents, supply_cents, status, household_count
            FROM apt_canonical_unit_types WHERE complex_id=?`,
      args: [complexId],
    });
    const types: CanonicalType[] = typesRes.rows.map((r) => ({
      unitTypeId: String(r.unit_type_id),
      exclusiveCents: Number(r.exclusive_cents),
      supplyCents: Number(r.supply_cents),
      status: String(r.status),
      householdCount: r.household_count == null ? null : Number(r.household_count),
    }));
    const bldRes = await db.execute({
      sql: `SELECT building_id, dong_label, residential_flag, official_building_key
            FROM complex_buildings WHERE complex_id=?`,
      args: [complexId],
    });
    const buildings = bldRes.rows.map((r) => ({
      buildingId: String(r.building_id),
      dongLabel: r.dong_label == null ? null : String(r.dong_label),
      residentialFlag: Number(r.residential_flag) === 1,
      officialBuildingKey: r.official_building_key == null ? null : String(r.official_building_key),
    }));
    const built = buildTypeBuildingLinks({
      units,
      types,
      buildings,
      source: "national_unit_building_evidence",
    });
    publicExactLinks += built.links.length;
    if (apply) {
      const up = await upsertTypeBuildingLinks(db, complexId, built.links);
      inserted += up.inserted;
      skippedPositive += up.skippedPositive;
      await upsertResolutionStats(
        db,
        complexId,
        built.stats,
        "national_unit_building_evidence",
        units[0]?.sourceAsOf ?? "",
      );
    }
  }
  return {
    artifact: path,
    complexes: byComplex.size,
    physicalUnits,
    publicExactLinks,
    inserted,
    skippedPositive,
  };
}

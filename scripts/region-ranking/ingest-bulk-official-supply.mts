/**
 * Ingest Building Hub bulk-matched shards into official_unit_area_cache and canonical unit types.
 * Reuses exclusive + residential-common semantics. Does not overwrite positive supplies.
 *
 * Usage: ./node_modules/.bin/tsx scripts/region-ranking/ingest-bulk-official-supply.mts
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, type Client, type InArgs } from "@libsql/client";
import { precheckAdditiveCreateSql } from "../../src/lib/region-ranking/migration-precheck";
import {
  areaFromCents,
  canonicalSupplyPyeong,
  canonicalUnitTypeId,
  NO_SUPPLY_CENTS,
  resolutionStatus,
} from "../../src/lib/unit-type/canonical";
import {
  deriveOfficialSupplies,
  type DerivedSupply,
  type ExposRow,
} from "../../src/lib/unit-type/official-expos";
import { supplyPyeongDisplayLabel } from "../../src/lib/unit-type/supply-label";

const ROOT = "/tmp/building-hub-bulk";
const SHARD_DIR = join(ROOT, "matched-shards");
const MIGRATION = "src/lib/db/migrations/20260924_official_unit_area.sql";
const BATCH = 40;
const AS_OF = "2026-09-17";
const START_12M = "2025-09-17";
const START_3Y = "2023-09-17";
const JAMSIL = "cx_4c63d9a100973c60";
const JAMSIL_REQUIRED: Array<[number, number]> = [
  [8480, 11152],
  [8488, 10929],
  [8497, 10947],
];
const PILOTS = [
  ["잠실엘스", "cx_4c63d9a100973c60"],
  ["파크리오", "cx_ed52bf895d064c11"],
  ["리센츠", "cx_caf229b5ac63cfbd"],
  ["헬리오시티", "cx_30d7eea6da810b52"],
  ["반포자이", "cx_1c244e7305d12c44"],
  ["래미안퍼스티지", "cx_3bcf0f87bce7496b"],
  ["은마", "cx_0320fd9e007e1f8c"],
  ["도곡렉슬", "cx_c9ed0235ecca960c"],
  ["마포프레스티지자이", "cx_07caf64c556e85a7"],
  ["포레나노원", "cx_88d05e29df26a0d6"],
] as const;

const stats = {
  complexesProcessed: 0,
  cacheRows: 0,
  supplyFills: 0,
  variants: 0,
  newTypes: 0,
  distinguishable: 0,
  noDerivable: 0,
  positiveOverwrites: 0,
  conflicts: 0,
};

function num(value: unknown): number {
  if (typeof value === "bigint") return Number(value);
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}
function str(value: unknown): string {
  return value == null ? "" : String(value).trim();
}

async function batchWrite(db: Client, statements: { sql: string; args: InArgs }[]) {
  for (let i = 0; i < statements.length; i += BATCH) {
    await db.batch(statements.slice(i, i + BATCH), "write");
  }
}

function listShards(): string[] {
  if (!existsSync(SHARD_DIR)) return [];
  const out: string[] = [];
  for (const dig of readdirSync(SHARD_DIR)) {
    const dir = join(SHARD_DIR, dig);
    for (const name of readdirSync(dir)) {
      if (name.endsWith(".jsonl")) out.push(join(dir, name));
    }
  }
  return out.sort();
}

function loadRows(path: string): ExposRow[] {
  const rows: ExposRow[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    rows.push(JSON.parse(line) as ExposRow);
  }
  return rows;
}

type Existing = Map<number, Map<number, string>>;

function groupSupplies(supplies: DerivedSupply[]) {
  const byExclusive = new Map<number, DerivedSupply[]>();
  for (const supply of supplies) {
    const list = byExclusive.get(supply.exclusiveCents);
    if (list) list.push(supply);
    else byExclusive.set(supply.exclusiveCents, [supply]);
  }
  return byExclusive;
}

async function writeCache(
  db: Client,
  complexId: string,
  pnu: string,
  units: ReturnType<typeof deriveOfficialSupplies>["units"],
  meta: { checksum: string; sourceMonth: string },
  now: string,
) {
  const statements = units.map((unit) => ({
    sql: `INSERT INTO official_unit_area_cache (
            complex_id, source_unit_id, source_provider, source_dataset, pnu, source_building_id,
            dong, floor, ho, exclusive_area, residential_common_area, other_common_area,
            explicit_supply_area, contract_area, source_key, source_as_of, fetched_at, provenance_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(complex_id, source_unit_id) DO NOTHING`,
    args: [
      complexId,
      `${unit.dong}|${unit.ho}`,
      "BldRgstHubService",
      "getBrExposPubuseAreaInfo",
      pnu,
      unit.sourceBuildingId,
      unit.dong,
      unit.floor,
      unit.ho,
      unit.exclusiveArea,
      unit.residentialCommonArea,
      unit.otherCommonArea,
      unit.explicitSupplyArea,
      unit.contractArea,
      `${pnu}:${unit.dong}:${unit.ho}`,
      unit.sourceAsOf,
      now,
      JSON.stringify({
        acquisition_method: "BULK",
        bulk_source_month: meta.sourceMonth,
        bulk_checksum: meta.checksum,
        formula: "exclusive_plus_residential_common",
        derivable: unit.derivable,
        partial: unit.partial,
      }),
    ] as InArgs,
  }));
  stats.cacheRows += statements.length;
  if (statements.length) await batchWrite(db, statements);
}

async function applySupplies(
  db: Client,
  complexId: string,
  pnu: string,
  supplies: DerivedSupply[],
  existing: Existing,
  meta: { checksum: string; sourceMonth: string },
  now: string,
) {
  const statements: { sql: string; args: InArgs }[] = [];
  const byExclusive = groupSupplies(supplies);
  for (const [exCents, variants] of byExclusive) {
    const prev = existing.get(exCents) ?? new Map<number, string>();
    const positive = [...prev.keys()].filter((cents) => cents >= 0);
    const fresh = variants.filter((variant) => !prev.has(variant.supplyCents));
    const combined = new Set<number>([...positive, ...variants.map((variant) => variant.supplyCents)]);
    if (fresh.length === 0 && positive.length > 0) continue;
    const status = resolutionStatus(combined.size, false);
    for (const variant of fresh) {
      const supplyArea = areaFromCents(variant.supplyCents);
      statements.push({
        sql: `INSERT INTO apt_canonical_unit_types (
                unit_type_id, complex_id, exclusive_area, exclusive_cents, supply_area, supply_cents,
                supply_pyeong, display_pyeong_label, type_name, household_count, source, source_key,
                source_as_of, confidence, status, formula, provenance_json, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(unit_type_id) DO NOTHING`,
        args: [
          canonicalUnitTypeId(complexId, exCents, variant.supplyCents),
          complexId,
          areaFromCents(exCents),
          exCents,
          supplyArea,
          variant.supplyCents,
          canonicalSupplyPyeong(supplyArea),
          supplyPyeongDisplayLabel(supplyArea),
          null,
          variant.householdCount,
          "BldRgstHubBulk",
          `${pnu}:${exCents}:${variant.supplyCents}`,
          meta.sourceMonth,
          "building_registry_expos",
          status,
          variant.formula,
          JSON.stringify({
            formula: variant.formula,
            acquisition_method: "BULK",
            bulk_source_month: meta.sourceMonth,
            bulk_checksum: meta.checksum,
            residential_common_area: variant.residentialCommonArea,
            household_count: variant.householdCount,
          }),
          now,
          now,
        ],
      });
      prev.set(variant.supplyCents, status);
      if (positive.length === 0) stats.supplyFills += 1;
      else stats.variants += 1;
      stats.newTypes += 1;
    }
    if (combined.size > 1 && positive.length > 0) {
      statements.push({
        sql: `UPDATE apt_canonical_unit_types
              SET status = 'AMBIGUOUS_MULTI', updated_at = ?
              WHERE complex_id = ? AND exclusive_cents = ? AND supply_cents >= 0`,
        args: [now, complexId, exCents],
      });
    }
    if (prev.has(NO_SUPPLY_CENTS) && combined.size > 0) {
      statements.push({
        sql: `DELETE FROM apt_canonical_unit_types
              WHERE complex_id = ? AND exclusive_cents = ? AND supply_cents = ? AND status = 'NO_SOURCE'`,
        args: [complexId, exCents, NO_SUPPLY_CENTS],
      });
      prev.delete(NO_SUPPLY_CENTS);
    }
    existing.set(exCents, prev);
    statements.push({
      sql: `INSERT INTO apt_unit_exclusive_pairs (
              complex_id, exclusive_cents, exclusive_area, trade_count, trade_count_12m, trade_count_3y,
              latest_trade_date, resolution_status, supply_variant_count, observed_from
            ) VALUES (?, ?, ?, 0, 0, 0, '', ?, ?, 'official_bulk')
            ON CONFLICT(complex_id, exclusive_cents) DO UPDATE SET
              resolution_status = excluded.resolution_status,
              supply_variant_count = excluded.supply_variant_count,
              observed_from = CASE
                WHEN apt_unit_exclusive_pairs.observed_from = '' THEN excluded.observed_from
                WHEN instr(apt_unit_exclusive_pairs.observed_from, 'official_bulk') > 0 THEN apt_unit_exclusive_pairs.observed_from
                ELSE apt_unit_exclusive_pairs.observed_from || '+official_bulk'
              END`,
      args: [complexId, exCents, areaFromCents(exCents), status, combined.size],
    });
  }
  if (statements.length) await batchWrite(db, statements);
}

async function saveCheckpoint(db: Client, complexId: string, status: string, total: number, detail: string) {
  await db.execute({
    sql: `INSERT INTO official_unit_area_checkpoint
            (complex_id, status, page_cursor, total_count, detail, updated_at)
          VALUES (?, ?, 0, ?, ?, ?)
          ON CONFLICT(complex_id) DO UPDATE SET
            status = excluded.status,
            total_count = excluded.total_count,
            detail = excluded.detail,
            updated_at = excluded.updated_at`,
    args: [complexId, status, total, detail.slice(0, 240), new Date().toISOString()],
  });
}

async function processComplex(
  db: Client,
  complexId: string,
  aptName: string,
  pnu: string,
  rows: ExposRow[],
  existing: Map<string, Existing>,
  meta: { checksum: string; sourceMonth: string },
) {
  const now = new Date().toISOString();
  const derived = deriveOfficialSupplies(rows, aptName);
  await writeCache(db, complexId, pnu, derived.units, meta, now);
  const bucket = existing.get(complexId) ?? new Map();
  existing.set(complexId, bucket);
  if (derived.distinguishable) {
    await applySupplies(db, complexId, pnu, derived.supplies, bucket, meta, now);
    stats.distinguishable += 1;
    await saveCheckpoint(db, complexId, "COMPLETE_DATA", rows.length, `BULK supplies=${derived.supplies.length}`);
  } else {
    stats.noDerivable += 1;
    await saveCheckpoint(
      db,
      complexId,
      "COMPLETE_DATA",
      rows.length,
      `BULK SEMANTICS_UNCLEAR ratio=${derived.residentialCommonRatio.toFixed(3)} units=${derived.units.length}`,
    );
  }
  stats.complexesProcessed += 1;
  return derived;
}

async function coverage(db: Client) {
  const national = await db.execute(`
    SELECT
      (SELECT COUNT(*) FROM apt_complex_master) AS complexes,
      (SELECT COUNT(DISTINCT complex_id) FROM apt_canonical_unit_types WHERE supply_cents >= 0) AS supply_complexes,
      (SELECT COUNT(DISTINCT complex_id) FROM apt_unit_exclusive_pairs WHERE resolution_status = 'EXACT_SINGLE') AS exact_complexes,
      (SELECT COUNT(*) FROM apt_unit_exclusive_pairs) AS pairs,
      (SELECT COUNT(*) FROM apt_unit_exclusive_pairs WHERE resolution_status = 'EXACT_SINGLE') AS exact_pairs,
      (SELECT COUNT(*) FROM apt_unit_exclusive_pairs WHERE resolution_status = 'AMBIGUOUS_MULTI') AS ambiguous_pairs,
      (SELECT COUNT(*) FROM apt_unit_exclusive_pairs WHERE resolution_status = 'NO_SOURCE') AS no_source_pairs,
      (SELECT COUNT(*) FROM apt_canonical_unit_types) AS types,
      (SELECT COUNT(*) FROM apt_canonical_unit_types WHERE status = 'EXACT_SINGLE') AS exact_types,
      (SELECT COUNT(*) FROM apt_canonical_unit_types WHERE status = 'AMBIGUOUS_MULTI') AS ambiguous_types,
      (SELECT COUNT(*) FROM apt_canonical_unit_types WHERE status = 'NO_SOURCE') AS no_source_types
  `);
  const trade = await db.execute(`
    SELECT
      SUM(CASE WHEN resolution_status = 'EXACT_SINGLE' THEN trade_count_12m ELSE 0 END) AS exact12,
      SUM(trade_count_12m) AS att12,
      SUM(CASE WHEN resolution_status = 'EXACT_SINGLE' THEN trade_count_3y ELSE 0 END) AS exact3y,
      SUM(trade_count_3y) AS att3y
    FROM apt_unit_exclusive_pairs
  `);
  const regions = await db.execute(`
    SELECT substr(m.lawd_cd,1,2) prefix,
           COUNT(*) pairs,
           SUM(CASE WHEN p.resolution_status='EXACT_SINGLE' THEN 1 ELSE 0 END) exact_pairs,
           SUM(CASE WHEN p.resolution_status='AMBIGUOUS_MULTI' THEN 1 ELSE 0 END) ambiguous,
           SUM(CASE WHEN p.resolution_status='NO_SOURCE' THEN 1 ELSE 0 END) no_source,
           SUM(CASE WHEN p.resolution_status='EXACT_SINGLE' THEN p.trade_count_12m ELSE 0 END) exact12,
           SUM(CASE WHEN p.resolution_status='EXACT_SINGLE' THEN p.trade_count_3y ELSE 0 END) exact3y,
           COUNT(DISTINCT CASE WHEN p.resolution_status='EXACT_SINGLE' THEN p.complex_id END) exact_complexes
    FROM apt_unit_exclusive_pairs p
    JOIN apt_complex_master m ON m.complex_id = p.complex_id
    GROUP BY 1
  `);
  const master = await db.execute(`
    SELECT substr(lawd_cd,1,2) prefix, COUNT(*) complexes
    FROM apt_complex_master GROUP BY 1
  `);
  return { national: national.rows[0], trade: trade.rows[0], regions: regions.rows, master: master.rows };
}

async function main() {
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL!.trim(),
    authToken: process.env.TURSO_AUTH_TOKEN!.trim(),
  });
  const migration = readFileSync(MIGRATION, "utf8");
  const precheck = precheckAdditiveCreateSql(migration);
  if (!precheck.ok) throw new Error(precheck.reason);
  for (const statement of precheck.statements) await db.execute(statement);

  const sourceMeta = JSON.parse(readFileSync(join(ROOT, "source-meta.json"), "utf8")) as {
    sha256: string;
    source_month: string;
  };
  const meta = { checksum: sourceMeta.sha256, sourceMonth: sourceMeta.source_month };
  const manifest = new Map<string, { aptName: string; pnu: string; parcelKey: string | null }>();
  for (const line of readFileSync(join(ROOT, "manifest-parcels.jsonl"), "utf8").split("\n")) {
    if (!line) continue;
    const row = JSON.parse(line) as { complexId: string; aptName: string; pnu: string | null; parcelKey: string | null };
    manifest.set(row.complexId, { aptName: row.aptName, pnu: row.pnu || "", parcelKey: row.parcelKey });
  }

  const existing = new Map<string, Existing>();
  const current = await db.execute(`SELECT complex_id, exclusive_cents, supply_cents, status FROM apt_canonical_unit_types`);
  for (const row of current.rows) {
    const complexId = str(row.complex_id);
    const ex = num(row.exclusive_cents);
    const su = num(row.supply_cents);
    let bucket = existing.get(complexId);
    if (!bucket) {
      bucket = new Map();
      existing.set(complexId, bucket);
    }
    let supplies = bucket.get(ex);
    if (!supplies) {
      supplies = new Map();
      bucket.set(ex, supplies);
    }
    supplies.set(su, str(row.status));
  }

  const shards = listShards();
  const shardByComplex = new Map<string, string>();
  for (const path of shards) {
    const complexId = path.split("/").pop()!.replace(/\.jsonl$/, "");
    shardByComplex.set(complexId, path);
  }

  const pilotNotes: Record<string, unknown> = {};
  for (const [name, complexId] of PILOTS) {
    const path = shardByComplex.get(complexId);
    const info = manifest.get(complexId);
    if (!path || !info) {
      pilotNotes[name] = { complexId, status: "NO_SHARD" };
      continue;
    }
    const rows = loadRows(path);
    const derived = await processComplex(db, complexId, info.aptName, info.pnu, rows, existing, meta);
    const maps = derived.supplies.map((s) => [s.exclusiveCents, s.supplyCents]);
    pilotNotes[name] = {
      complexId,
      rows: rows.length,
      units: derived.units.length,
      distinguishable: derived.distinguishable,
      ratio: derived.residentialCommonRatio,
      supplies: maps,
    };
    if (complexId === JAMSIL) {
      const got = new Set(maps.map(([ex, su]) => `${ex}:${su}`));
      for (const [ex, su] of JAMSIL_REQUIRED) {
        if (!got.has(`${ex}:${su}`)) throw new Error(`jamsil bulk parity failed ${ex}->${su}`);
      }
      console.log("jamsil bulk parity PASS");
    }
  }

  let i = 0;
  for (const [complexId, path] of shardByComplex) {
    if (PILOTS.some(([, id]) => id === complexId)) continue;
    i += 1;
    const info = manifest.get(complexId);
    if (!info) continue;
    const rows = loadRows(path);
    await processComplex(db, complexId, info.aptName, info.pnu, rows, existing, meta);
    if (i % 100 === 0) console.log(JSON.stringify({ i, remaining: shardByComplex.size - PILOTS.length, ...stats }));
  }

  // mark unresolved / no-data from stream summary if present
  if (existsSync(join(ROOT, "complete-no-data.txt"))) {
    for (const complexId of readFileSync(join(ROOT, "complete-no-data.txt"), "utf8").split("\n")) {
      if (!complexId) continue;
      await saveCheckpoint(db, complexId, "COMPLETE_NO_DATA", 0, "BULK_NO_ROWS");
    }
  }
  if (existsSync(join(ROOT, "identity-unresolved.txt"))) {
    for (const complexId of readFileSync(join(ROOT, "identity-unresolved.txt"), "utf8").split("\n")) {
      if (!complexId) continue;
      await saveCheckpoint(db, complexId, "IDENTITY_UNRESOLVED", 0, "BULK_IDENTITY");
    }
  }

  const cov = await coverage(db);
  const seoul = (cov.regions as Array<Record<string, unknown>>).find((row) => row.prefix === "11");
  const seoulExact12 = num(seoul?.exact12);
  // Approximate total Seoul 12M from prior known 71501 if att not region-split; compute from pairs join
  const seoulAtt = await db.execute(`
    SELECT SUM(p.trade_count_12m) att12, SUM(p.trade_count_3y) att3y
    FROM apt_unit_exclusive_pairs p
    JOIN apt_complex_master m ON m.complex_id = p.complex_id
    WHERE m.lawd_cd LIKE '11%'
  `);
  const seoulShare = seoulExact12 / Math.max(1, num(seoulAtt.rows[0]?.att12));
  const gate = seoulShare >= 0.8;

  const report = {
    stats,
    pilots: pilotNotes,
    coverage: cov,
    seoulShare,
    gate,
    sourceMeta,
  };
  writeFileSync(join(ROOT, "ingest-report.json"), JSON.stringify(report));
  console.log(JSON.stringify({ stats, seoulShare, gate, types: cov.national }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

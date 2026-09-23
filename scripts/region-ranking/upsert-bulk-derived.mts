/**
 * Fast Turso upsert from precomputed bulk derived-supplies.jsonl.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, type Client, type InArgs } from "@libsql/client";
import {
  areaFromCents,
  canonicalSupplyPyeong,
  canonicalUnitTypeId,
  NO_SUPPLY_CENTS,
  resolutionStatus,
} from "../../src/lib/unit-type/canonical";
import { supplyPyeongDisplayLabel } from "../../src/lib/unit-type/supply-label";

const ROOT = "/tmp/building-hub-bulk";
const DERIVED = join(ROOT, "derived-supplies.jsonl");
const BATCH = 80;
const JAMSIL = "cx_4c63d9a100973c60";
const JAMSIL_REQUIRED: Array<[number, number]> = [
  [8480, 11152],
  [8488, 10929],
  [8497, 10947],
];

type DerivedRow = {
  complexId: string;
  aptName: string;
  pnu: string;
  distinguishable: boolean;
  residentialCommonRatio: number;
  rawRows: number;
  supplies: Array<{
    exclusiveCents: number;
    supplyCents: number;
    exclusiveArea: number;
    supplyArea: number;
    residentialCommonArea: number;
    householdCount: number;
    formula: string;
  }>;
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
    let last: unknown = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        await db.batch(statements.slice(i, i + BATCH), "write");
        last = null;
        break;
      } catch (error) {
        last = error;
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
    }
    if (last) throw last;
  }
}

async function main() {
  if (!existsSync(DERIVED)) throw new Error(`missing ${DERIVED}`);
  const sourceMeta = JSON.parse(readFileSync(join(ROOT, "source-meta.json"), "utf8")) as {
    sha256: string;
    source_month: string;
  };
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL!.trim(),
    authToken: process.env.TURSO_AUTH_TOKEN!.trim(),
  });
  const now = new Date().toISOString();
  const existing = new Map<string, Map<number, Map<number, string>>>();
  const current = await db.execute(`SELECT complex_id, exclusive_cents, supply_cents, status FROM apt_canonical_unit_types`);
  for (const row of current.rows) {
    const complexId = str(row.complex_id);
    const ex = num(row.exclusive_cents);
    const su = num(row.supply_cents);
    let a = existing.get(complexId);
    if (!a) {
      a = new Map();
      existing.set(complexId, a);
    }
    let b = a.get(ex);
    if (!b) {
      b = new Map();
      a.set(ex, b);
    }
    b.set(su, str(row.status));
  }

  const stats = {
    complexes: 0,
    distinguishable: 0,
    supplyFills: 0,
    variants: 0,
    newTypes: 0,
    cacheRows: 0,
    noDerivable: 0,
  };
  const statements: { sql: string; args: InArgs }[] = [];
  const flush = async () => {
    if (!statements.length) return;
    const chunk = statements.splice(0, statements.length);
    await batchWrite(db, chunk);
  };

  for (const line of readFileSync(DERIVED, "utf8").split("\n")) {
    if (!line) continue;
    const row = JSON.parse(line) as DerivedRow;
    stats.complexes += 1;
    if (row.complexId === JAMSIL) {
      const got = new Set(row.supplies.map((s) => `${s.exclusiveCents}:${s.supplyCents}`));
      for (const [ex, su] of JAMSIL_REQUIRED) {
        if (!got.has(`${ex}:${su}`)) throw new Error(`jamsil bulk parity failed ${ex}->${su}`);
      }
      console.log("jamsil bulk parity PASS");
    }
    if (!row.distinguishable || row.supplies.length === 0) {
      stats.noDerivable += 1;
      statements.push({
        sql: `INSERT INTO official_unit_area_checkpoint
                (complex_id, status, page_cursor, total_count, detail, updated_at)
              VALUES (?, 'COMPLETE_DATA', 0, ?, ?, ?)
              ON CONFLICT(complex_id) DO UPDATE SET
                status=excluded.status, total_count=excluded.total_count, detail=excluded.detail, updated_at=excluded.updated_at`,
        args: [
          row.complexId,
          row.rawRows,
          `BULK SEMANTICS_UNCLEAR ratio=${row.residentialCommonRatio.toFixed(3)}`,
          now,
        ],
      });
      if (statements.length >= 500) await flush();
      continue;
    }
    stats.distinguishable += 1;
    const bucket = existing.get(row.complexId) ?? new Map();
    existing.set(row.complexId, bucket);
    const byExclusive = new Map<number, typeof row.supplies>();
    for (const supply of row.supplies) {
      const list = byExclusive.get(supply.exclusiveCents) ?? [];
      list.push(supply);
      byExclusive.set(supply.exclusiveCents, list);
    }
    for (const [exCents, variants] of byExclusive) {
      const prev = bucket.get(exCents) ?? new Map<number, string>();
      const positive = [...prev.keys()].filter((c) => c >= 0);
      const fresh = variants.filter((v) => !prev.has(v.supplyCents));
      const combined = new Set<number>([...positive, ...variants.map((v) => v.supplyCents)]);
      const status = resolutionStatus(combined.size, false);
      for (const variant of fresh) {
        statements.push({
          sql: `INSERT INTO apt_canonical_unit_types (
                  unit_type_id, complex_id, exclusive_area, exclusive_cents, supply_area, supply_cents,
                  supply_pyeong, display_pyeong_label, type_name, household_count, source, source_key,
                  source_as_of, confidence, status, formula, provenance_json, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(unit_type_id) DO NOTHING`,
          args: [
            canonicalUnitTypeId(row.complexId, exCents, variant.supplyCents),
            row.complexId,
            areaFromCents(exCents),
            exCents,
            variant.supplyArea,
            variant.supplyCents,
            canonicalSupplyPyeong(variant.supplyArea),
            supplyPyeongDisplayLabel(variant.supplyArea),
            null,
            variant.householdCount,
            "BldRgstHubBulk",
            `${row.pnu}:${exCents}:${variant.supplyCents}`,
            sourceMeta.source_month,
            "building_registry_expos",
            status,
            variant.formula,
            JSON.stringify({
              formula: variant.formula,
              acquisition_method: "BULK",
              bulk_source_month: sourceMeta.source_month,
              bulk_checksum: sourceMeta.sha256,
              residential_common_area: variant.residentialCommonArea,
              household_count: variant.householdCount,
            }),
            now,
            now,
          ],
        });
        statements.push({
          sql: `INSERT INTO official_unit_area_cache (
                  complex_id, source_unit_id, source_provider, source_dataset, pnu, source_building_id,
                  dong, floor, ho, exclusive_area, residential_common_area, other_common_area,
                  explicit_supply_area, contract_area, source_key, source_as_of, fetched_at, provenance_json
                ) VALUES (?, ?, 'BuildingHubBulk', 'mart_djy_06', ?, '', '', '', '', ?, ?, NULL, ?, NULL, ?, ?, ?, ?)
                ON CONFLICT(complex_id, source_unit_id) DO NOTHING`,
          args: [
            row.complexId,
            `type:${exCents}:${variant.supplyCents}`,
            row.pnu,
            variant.exclusiveArea,
            variant.residentialCommonArea,
            variant.supplyArea,
            `${row.pnu}:${exCents}:${variant.supplyCents}`,
            sourceMeta.source_month,
            now,
            JSON.stringify({
              acquisition_method: "BULK",
              bulk_source_month: sourceMeta.source_month,
              bulk_checksum: sourceMeta.sha256,
              formula: variant.formula,
              household_count: variant.householdCount,
              local_shard: true,
            }),
          ],
        });
        prev.set(variant.supplyCents, status);
        if (positive.length === 0) stats.supplyFills += 1;
        else stats.variants += 1;
        stats.newTypes += 1;
        stats.cacheRows += 1;
      }
      if (combined.size > 1 && positive.length > 0) {
        statements.push({
          sql: `UPDATE apt_canonical_unit_types SET status='AMBIGUOUS_MULTI', updated_at=?
                WHERE complex_id=? AND exclusive_cents=? AND supply_cents >= 0`,
          args: [now, row.complexId, exCents],
        });
      }
      if (prev.has(NO_SUPPLY_CENTS) && combined.size > 0) {
        statements.push({
          sql: `DELETE FROM apt_canonical_unit_types
                WHERE complex_id=? AND exclusive_cents=? AND supply_cents=? AND status='NO_SOURCE'`,
          args: [row.complexId, exCents, NO_SUPPLY_CENTS],
        });
        prev.delete(NO_SUPPLY_CENTS);
      }
      bucket.set(exCents, prev);
      statements.push({
        sql: `INSERT INTO apt_unit_exclusive_pairs (
                complex_id, exclusive_cents, exclusive_area, trade_count, trade_count_12m, trade_count_3y,
                latest_trade_date, resolution_status, supply_variant_count, observed_from
              ) VALUES (?, ?, ?, 0, 0, 0, '', ?, ?, 'official_bulk')
              ON CONFLICT(complex_id, exclusive_cents) DO UPDATE SET
                resolution_status=excluded.resolution_status,
                supply_variant_count=excluded.supply_variant_count,
                observed_from=CASE
                  WHEN apt_unit_exclusive_pairs.observed_from='' THEN excluded.observed_from
                  WHEN instr(apt_unit_exclusive_pairs.observed_from, 'official_bulk')>0 THEN apt_unit_exclusive_pairs.observed_from
                  ELSE apt_unit_exclusive_pairs.observed_from || '+official_bulk'
                END`,
        args: [row.complexId, exCents, areaFromCents(exCents), status, combined.size],
      });
    }
    statements.push({
      sql: `INSERT INTO official_unit_area_checkpoint
              (complex_id, status, page_cursor, total_count, detail, updated_at)
            VALUES (?, 'COMPLETE_DATA', 0, ?, ?, ?)
            ON CONFLICT(complex_id) DO UPDATE SET
              status=excluded.status, total_count=excluded.total_count, detail=excluded.detail, updated_at=excluded.updated_at`,
      args: [row.complexId, row.rawRows, `BULK supplies=${row.supplies.length}`, now],
    });
    if (statements.length >= 800) {
      await flush();
      if (stats.complexes % 500 === 0) console.log(JSON.stringify(stats));
    }
  }
  await flush();

  // mark stream no-data / unresolved
  if (existsSync(join(ROOT, "complete-no-data.txt"))) {
    for (const complexId of readFileSync(join(ROOT, "complete-no-data.txt"), "utf8").split("\n")) {
      if (!complexId) continue;
      statements.push({
        sql: `INSERT INTO official_unit_area_checkpoint
                (complex_id, status, page_cursor, total_count, detail, updated_at)
              VALUES (?, 'COMPLETE_NO_DATA', 0, 0, 'BULK_NO_ROWS', ?)
              ON CONFLICT(complex_id) DO UPDATE SET status=excluded.status, detail=excluded.detail, updated_at=excluded.updated_at`,
        args: [complexId, now],
      });
    }
  }
  if (existsSync(join(ROOT, "identity-unresolved.txt"))) {
    for (const complexId of readFileSync(join(ROOT, "identity-unresolved.txt"), "utf8").split("\n")) {
      if (!complexId) continue;
      statements.push({
        sql: `INSERT INTO official_unit_area_checkpoint
                (complex_id, status, page_cursor, total_count, detail, updated_at)
              VALUES (?, 'IDENTITY_UNRESOLVED', 0, 0, 'BULK_IDENTITY', ?)
              ON CONFLICT(complex_id) DO UPDATE SET status=excluded.status, detail=excluded.detail, updated_at=excluded.updated_at`,
        args: [complexId, now],
      });
    }
  }
  await flush();

  const national = await db.execute(`
    SELECT
      (SELECT COUNT(*) FROM apt_complex_master) complexes,
      (SELECT COUNT(DISTINCT complex_id) FROM apt_canonical_unit_types WHERE supply_cents >= 0) supply_complexes,
      (SELECT COUNT(DISTINCT complex_id) FROM apt_unit_exclusive_pairs WHERE resolution_status='EXACT_SINGLE') exact_complexes,
      (SELECT COUNT(*) FROM apt_unit_exclusive_pairs) pairs,
      (SELECT COUNT(*) FROM apt_unit_exclusive_pairs WHERE resolution_status='EXACT_SINGLE') exact_pairs,
      (SELECT COUNT(*) FROM apt_unit_exclusive_pairs WHERE resolution_status='AMBIGUOUS_MULTI') ambiguous_pairs,
      (SELECT COUNT(*) FROM apt_unit_exclusive_pairs WHERE resolution_status='NO_SOURCE') no_source_pairs,
      (SELECT COUNT(*) FROM apt_canonical_unit_types) types,
      (SELECT COUNT(*) FROM apt_canonical_unit_types WHERE status='EXACT_SINGLE') exact_types,
      (SELECT COUNT(*) FROM apt_canonical_unit_types WHERE status='AMBIGUOUS_MULTI') ambiguous_types,
      (SELECT COUNT(*) FROM apt_canonical_unit_types WHERE status='NO_SOURCE') no_source_types,
      (SELECT COUNT(*) FROM apt_unit_supply_conflicts) conflicts
  `);
  const trade = await db.execute(`
    SELECT
      SUM(CASE WHEN resolution_status='EXACT_SINGLE' THEN trade_count_12m ELSE 0 END) exact12,
      SUM(trade_count_12m) att12,
      SUM(CASE WHEN resolution_status='EXACT_SINGLE' THEN trade_count_3y ELSE 0 END) exact3y,
      SUM(trade_count_3y) att3y
    FROM apt_unit_exclusive_pairs
  `);
  const regions = await db.execute(`
    SELECT substr(m.lawd_cd,1,2) prefix,
           COUNT(*) pairs,
           SUM(CASE WHEN p.resolution_status='EXACT_SINGLE' THEN 1 ELSE 0 END) exact_pairs,
           SUM(CASE WHEN p.resolution_status='AMBIGUOUS_MULTI' THEN 1 ELSE 0 END) ambiguous,
           SUM(CASE WHEN p.resolution_status='NO_SOURCE' THEN 1 ELSE 0 END) no_source,
           SUM(CASE WHEN p.resolution_status='EXACT_SINGLE' THEN p.trade_count_12m ELSE 0 END) exact12,
           SUM(p.trade_count_12m) att12,
           SUM(CASE WHEN p.resolution_status='EXACT_SINGLE' THEN p.trade_count_3y ELSE 0 END) exact3y,
           COUNT(DISTINCT CASE WHEN p.resolution_status='EXACT_SINGLE' THEN p.complex_id END) exact_complexes,
           COUNT(DISTINCT m.complex_id) complexes_in_pairs
    FROM apt_unit_exclusive_pairs p
    JOIN apt_complex_master m ON m.complex_id=p.complex_id
    GROUP BY 1
  `);
  const master = await db.execute(`SELECT substr(lawd_cd,1,2) prefix, COUNT(*) complexes FROM apt_complex_master GROUP BY 1`);
  const supplyByPrefix = await db.execute(`
    SELECT substr(m.lawd_cd,1,2) prefix, COUNT(DISTINCT u.complex_id) supply_complexes
    FROM apt_canonical_unit_types u
    JOIN apt_complex_master m ON m.complex_id=u.complex_id
    WHERE u.supply_cents >= 0
    GROUP BY 1
  `);
  const report = { stats, national: national.rows[0], trade: trade.rows[0], regions: regions.rows, master: master.rows, supplyByPrefix: supplyByPrefix.rows, sourceMeta };
  writeFileSync(join(ROOT, "ingest-report.json"), JSON.stringify(report));
  console.log(JSON.stringify({ stats, national: national.rows[0], trade: trade.rows[0] }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

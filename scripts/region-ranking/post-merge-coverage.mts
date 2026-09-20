/**
 * Post-merge coverage + selector metrics (no V2 build).
 */
import { createClient } from "@libsql/client";
import { writeFileSync } from "node:fs";
import { selectorSupplyCoverage } from "../../src/lib/unit-type/supply-label";

const PILOTS: Record<string, string> = {
  잠실엘스: "cx_4c63d9a100973c60",
  파크리오: "cx_ed52bf895d064c11",
  리센츠: "cx_caf229b5ac63cfbd",
  헬리오시티: "cx_30d7eea6da810b52",
  반포자이: "cx_1c244e7305d12c44",
  래미안퍼스티지: "cx_3bcf0f87bce7496b",
  은마: "cx_0320fd9e007e1f8c",
  도곡렉슬: "cx_c9ed0235ecca960c",
  마포프레스티지자이: "cx_07caf64c556e85a7",
  포레나노원: "cx_88d05e29df26a0d6",
};

function num(v: unknown): number {
  if (typeof v === "bigint") return Number(v);
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}
function str(v: unknown): string {
  return v == null ? "" : String(v).trim();
}

async function main() {
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL!.trim(),
    authToken: process.env.TURSO_AUTH_TOKEN!.trim(),
  });

  const national = (await db.execute(`
    SELECT
      (SELECT COUNT(*) FROM apt_complex_master) master_complexes,
      (SELECT COUNT(*) FROM apt_unit_acquisition_manifest) manifest,
      (SELECT COUNT(*) FROM apt_canonical_unit_types) types,
      (SELECT COUNT(DISTINCT complex_id) FROM apt_canonical_unit_types WHERE supply_cents>=0) supply_complexes,
      (SELECT COUNT(*) FROM apt_canonical_unit_types WHERE status='EXACT_SINGLE' AND supply_cents>=0) exact_types,
      (SELECT COUNT(*) FROM apt_canonical_unit_types WHERE status='AMBIGUOUS_MULTI' AND supply_cents>=0) amb_types,
      (SELECT COUNT(*) FROM apt_canonical_unit_types WHERE status='NO_SOURCE') no_source_types,
      (SELECT COUNT(*) FROM apt_unit_exclusive_pairs) pairs,
      (SELECT COUNT(*) FROM apt_unit_exclusive_pairs WHERE resolution_status='EXACT_SINGLE') exact_pairs,
      (SELECT COUNT(*) FROM apt_unit_exclusive_pairs WHERE resolution_status='AMBIGUOUS_MULTI') amb_pairs,
      (SELECT COUNT(*) FROM apt_unit_exclusive_pairs WHERE resolution_status='NO_SOURCE') no_source_pairs,
      (SELECT COUNT(DISTINCT complex_id) FROM apt_unit_exclusive_pairs WHERE resolution_status='EXACT_SINGLE') exact_complexes,
      (SELECT COUNT(*) FROM apt_unit_supply_conflicts) conflicts
  `)).rows[0];

  const tradePairs = (await db.execute(`
    SELECT
      SUM(CASE WHEN resolution_status='EXACT_SINGLE' THEN trade_count_12m ELSE 0 END) exact12,
      SUM(trade_count_12m) att12,
      SUM(CASE WHEN resolution_status='EXACT_SINGLE' THEN trade_count_3y ELSE 0 END) exact3y,
      SUM(trade_count_3y) att3y
    FROM apt_unit_exclusive_pairs
  `)).rows[0];

  const regions = (await db.execute(`
    SELECT substr(m.lawd_cd,1,2) prefix,
           COUNT(DISTINCT m.complex_id) complexes,
           COUNT(DISTINCT CASE WHEN p.resolution_status='EXACT_SINGLE' THEN p.complex_id END) exact_complexes,
           COUNT(*) pairs,
           SUM(CASE WHEN p.resolution_status='EXACT_SINGLE' THEN 1 ELSE 0 END) exact_pairs,
           SUM(CASE WHEN p.resolution_status='AMBIGUOUS_MULTI' THEN 1 ELSE 0 END) ambiguous,
           SUM(CASE WHEN p.resolution_status='NO_SOURCE' THEN 1 ELSE 0 END) no_source,
           SUM(CASE WHEN p.resolution_status='EXACT_SINGLE' THEN p.trade_count_12m ELSE 0 END) exact12,
           SUM(p.trade_count_12m) att12,
           SUM(CASE WHEN p.resolution_status='EXACT_SINGLE' THEN p.trade_count_3y ELSE 0 END) exact3y,
           SUM(p.trade_count_3y) att3y
    FROM apt_unit_exclusive_pairs p
    JOIN apt_complex_master m ON m.complex_id=p.complex_id
    GROUP BY 1
  `)).rows;

  // Live Seoul / Gyeonggi transaction exact coverage
  async function regionTx(prefix: string) {
    return (await db.execute({
      sql: `
      WITH tx AS (
        SELECT t.lawd_cd, t.apt_name_norm, t.exclusive_area, t.deal_date,
               m.complex_id,
               CAST(ROUND(t.exclusive_area * 100) AS INTEGER) AS exclusive_cents
        FROM transactions t
        JOIN apt_complex_master m
          ON m.lawd_cd = t.lawd_cd AND m.apt_name_norm = t.apt_name_norm
        WHERE t.lawd_cd LIKE ?
          AND t.deal_type = 'trade'
          AND t.deal_amount > 0 AND t.exclusive_area > 0
          AND t.deal_date <= '2026-09-17' AND t.deal_date >= '2023-09-17'
          AND m.complex_id IN (
            SELECT complex_id FROM apt_complex_master
            GROUP BY lawd_cd, apt_name_norm HAVING COUNT(*) = 1
          )
      )
      SELECT
        SUM(CASE WHEN deal_date >= '2025-09-17' THEN 1 ELSE 0 END) tx12,
        SUM(CASE WHEN deal_date >= '2025-09-17' AND EXISTS (
          SELECT 1 FROM apt_canonical_unit_types u
          WHERE u.complex_id=tx.complex_id AND u.exclusive_cents=tx.exclusive_cents
            AND u.supply_cents>=0 AND u.status='EXACT_SINGLE'
        ) THEN 1 ELSE 0 END) exact12,
        SUM(CASE WHEN deal_date >= '2025-09-17' AND EXISTS (
          SELECT 1 FROM apt_canonical_unit_types u
          WHERE u.complex_id=tx.complex_id AND u.exclusive_cents=tx.exclusive_cents
            AND u.supply_cents>=0 AND u.status='AMBIGUOUS_MULTI'
        ) THEN 1 ELSE 0 END) amb12,
        COUNT(*) tx3y,
        SUM(CASE WHEN EXISTS (
          SELECT 1 FROM apt_canonical_unit_types u
          WHERE u.complex_id=tx.complex_id AND u.exclusive_cents=tx.exclusive_cents
            AND u.supply_cents>=0 AND u.status='EXACT_SINGLE'
        ) THEN 1 ELSE 0 END) exact3y
      FROM tx`,
      args: [`${prefix}%`],
    })).rows[0];
  }

  const seoulTx = await regionTx("11");
  const gyeonggiTx = await regionTx("41");

  const selector = selectorSupplyCoverage({
    supplyReadyComplexes: num(national?.exact_complexes),
    supplyReadyPairs: num(national?.exact_pairs),
  });

  const pilots: Record<string, unknown> = {};
  for (const [name, id] of Object.entries(PILOTS)) {
    const types = await db.execute({
      sql: `SELECT exclusive_area, supply_area, status FROM apt_canonical_unit_types
            WHERE complex_id=? AND supply_cents>=0 ORDER BY exclusive_area, supply_area`,
      args: [id],
    });
    pilots[name] = {
      complexId: id,
      n: types.rows.length,
      supplies: types.rows.map((r) => ({
        e: num(r.exclusive_area),
        s: num(r.supply_area),
        st: str(r.status),
      })),
    };
  }

  const v1 = await db.execute(
    `SELECT COUNT(*) n FROM complex_region_price_position WHERE snapshot_id LIKE 'price-position-v1|%'`,
  );
  const v2 = await db.execute(
    `SELECT COUNT(*) n FROM complex_region_price_position WHERE snapshot_id LIKE 'price-position-v2|%'`,
  );

  const seoulExact12 = num(seoulTx?.exact12);
  const seoulTx12 = num(seoulTx?.tx12);
  const gateShare = seoulTx12 > 0 ? seoulExact12 / seoulTx12 : 0;
  const gatePass = seoulTx12 > 0 && gateShare >= 0.8;

  const report = {
    national,
    tradePairs,
    regions,
    seoulTx,
    gyeonggiTx,
    selector,
    pilots,
    gate: { gatePass, gateShare, seoulExact12, seoulTx12, amb12: num(seoulTx?.amb12) },
    snapshots: { v1: num(v1.rows[0]?.n), v2: num(v2.rows[0]?.n) },
  };
  writeFileSync("/tmp/building-hub-bulk/external-evidence/coverage-report.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    national,
    tradePairs,
    seoulTx,
    gyeonggiTx,
    selector,
    gate: report.gate,
    snapshots: report.snapshots,
    eunma: pilots["은마"],
    banpoSample: (pilots["반포자이"] as { supplies: unknown[] }).supplies.slice(0, 8),
  }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

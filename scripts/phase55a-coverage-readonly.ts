/**
 * Phase 5.5a — read-only coverage snapshot. WRITE=0.
 *   npx tsx scripts/phase55a-coverage-readonly.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) throw new Error("TURSO credentials missing");
  const db = createClient({ url, authToken });

  const groupBy = await db.execute(
    `SELECT complex_key, COUNT(*) AS n,
            SUM(CASE WHEN group_confidence_high = 1 THEN 1 ELSE 0 END) AS high_n
     FROM apt_pyeong_groups GROUP BY complex_key ORDER BY complex_key`,
  );
  const groupTotal = await db.execute(`SELECT COUNT(*) AS n FROM apt_pyeong_groups`);
  const baseBy = await db.execute(
    `SELECT complex_key, COUNT(*) AS n FROM apt_pyeong_group_baselines
     GROUP BY complex_key ORDER BY complex_key`,
  );
  const baseTotal = await db.execute(
    `SELECT COUNT(*) AS n FROM apt_pyeong_group_baselines`,
  );
  const missing = await db.execute(`
    SELECT g.complex_key,
           COUNT(g.group_key) AS groups,
           SUM(CASE WHEN g.group_confidence_high = 1 THEN 1 ELSE 0 END) AS high_groups,
           SUM(CASE WHEN b.group_key IS NULL THEN 1 ELSE 0 END) AS missing_baselines,
           SUM(CASE WHEN g.group_confidence_high = 1 AND b.group_key IS NULL THEN 1 ELSE 0 END) AS missing_high_baselines
    FROM apt_pyeong_groups g
    LEFT JOIN apt_pyeong_group_baselines b ON b.group_key = g.group_key
    GROUP BY g.complex_key ORDER BY g.complex_key`);
  const classes = await db.execute(
    `SELECT complex_key, apt_name_norm, classification, singoga_mode
     FROM apt_complex_classifications ORDER BY complex_key`,
  );
  const sampleGroups = await db.execute(
    `SELECT group_key, complex_key, exclusive_area_min, exclusive_area_max,
            group_confidence_high, market_label, source
     FROM apt_pyeong_groups ORDER BY complex_key, sort_order LIMIT 50`,
  );
  const sampleBases = await db.execute(
    `SELECT group_key, complex_key, baseline_until, prior_max_amount,
            prior_max_deal_date, confidence, completeness, pre_warehouse_trade_count
     FROM apt_pyeong_group_baselines ORDER BY complex_key, group_key`,
  );

  // Top Seoul/Gyeonggi complexes by trade volume (exclude 4 pilots)
  const top = await db.execute(`
    SELECT apt_name_norm,
           lawd_cd,
           COUNT(*) AS trade_n,
           COUNT(DISTINCT ROUND(exclusive_area, 2)) AS area_variants,
           MIN(exclusive_area) AS ex_min,
           MAX(exclusive_area) AS ex_max,
           MIN(deal_date) AS first_deal,
           MAX(deal_date) AS last_deal
    FROM transactions
    WHERE deal_type = 'trade'
      AND (
        lawd_cd LIKE '11%' OR lawd_cd LIKE '41%'
      )
      AND apt_name_norm NOT IN ('한강(대우)', '파크리오', '반포자이', '잠실엘스')
    GROUP BY apt_name_norm, lawd_cd
    HAVING trade_n >= 800
    ORDER BY trade_n DESC
    LIMIT 80`);

  const out = {
    capturedAt: new Date().toISOString(),
    writes: 0,
    groupComplexCount: groupBy.rows.length,
    groupRows: Number((groupTotal.rows[0] as any).n),
    baselineComplexCount: baseBy.rows.length,
    baselineRows: Number((baseTotal.rows[0] as any).n),
    groupsByComplex: groupBy.rows,
    baselinesByComplex: baseBy.rows,
    missingBaselines: missing.rows,
    classifications: classes.rows,
    sampleGroups: sampleGroups.rows,
    sampleBaselines: sampleBases.rows,
    topVolumeCandidates: top.rows,
  };
  const dir = join("data/poc/phase55a");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "coverage-readonly.json"), JSON.stringify(out, null, 2));
  console.log(JSON.stringify({
    groupComplexCount: out.groupComplexCount,
    groupRows: out.groupRows,
    baselineComplexCount: out.baselineComplexCount,
    baselineRows: out.baselineRows,
    missingBaselines: out.missingBaselines,
    classifications: out.classifications,
    top20: out.topVolumeCandidates.slice(0, 20),
  }, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });

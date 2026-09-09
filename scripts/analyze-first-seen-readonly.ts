/**
 * Production READ-only first_seen history analysis.
 * No writes. Prints aggregates only.
 *
 *   npx tsx scripts/analyze-first-seen-readonly.ts
 */
import { config } from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@libsql/client";
import { ALL_REGIONS } from "../src/lib/constants/regions-registry";

for (const p of [".env.local", ".env"]) {
  const abs = resolve(process.cwd(), p);
  if (existsSync(abs)) config({ path: abs, override: false });
}

const url = process.env.TURSO_DATABASE_URL ?? "";
if (!url || url.startsWith("file:")) {
  throw new Error("Need remote TURSO_DATABASE_URL for this analysis");
}

const db = createClient({
  url,
  authToken: process.env.TURSO_AUTH_TOKEN ?? "",
});

const CAPITAL = [
  "11110","11140","11170","11200","11215","11230","11260","11290","11305","11320",
  "11350","11380","11410","11440","11470","11500","11530","11545","11560","11590",
  "11620","11650","11680","11710","11740","41111","41113","41115","41117","41131",
  "41133","41135","41150","41171","41173","41210","41220","41250","41271","41273",
  "41281","41285","41287","41290","41310","41360","41370","41390","41410","41430",
  "41450","41461","41463","41465","41480","41500","41550","41570","41590","41610",
  "41630","41650","41670","41800","41820","41830",
];

const inList = CAPITAL.map((c) => `'${c}'`).join(",");

const lawdName = new Map<string, string>();
for (const region of ALL_REGIONS) {
  for (const d of region.districts) {
    lawdName.set(d.code, `${region.name} ${d.name}`.trim());
  }
}

async function q(sql: string) {
  const t0 = Date.now();
  const res = await db.execute(sql);
  console.error(`[query ${Date.now() - t0}ms] ${sql.slice(0, 80).replace(/\s+/g, " ")}`);
  return res;
}

async function main() {
  console.log("=== FS DATE AXIS (capital 67, first_seen NOT NULL) ===");
  const axis = await q(`
    SELECT
      date(first_seen_at, '+9 hours') AS kst_date,
      COUNT(*) AS n,
      COUNT(DISTINCT lawd_cd) AS lawds,
      MIN(first_seen_at) AS tmin,
      MAX(first_seen_at) AS tmax,
      CAST((julianday(MAX(first_seen_at)) - julianday(MIN(first_seen_at))) * 86400 AS INTEGER) AS span_sec,
      MIN(deal_date) AS dmin,
      MAX(deal_date) AS dmax,
      COUNT(DISTINCT substr(deal_date, 1, 7)) AS months
    FROM transactions
    WHERE lawd_cd IN (${inList}) AND first_seen_at IS NOT NULL AND first_seen_at != ''
    GROUP BY 1
    ORDER BY 1
  `);
  for (const r of axis.rows) console.log(r);

  console.log("\n=== DEAL TYPE MIX ===");
  const types = await q(`
    SELECT deal_type, COUNT(*) AS n
    FROM transactions
    WHERE lawd_cd IN (${inList}) AND first_seen_at IS NOT NULL AND first_seen_at != ''
    GROUP BY 1
  `);
  for (const r of types.rows) console.log(r);

  console.log("\n=== GANGNAM 11680 2026-09-08 ===");
  const gn = await q(`
    SELECT
      COUNT(*) AS row_count,
      SUM(CASE WHEN deal_type = 'trade' THEN 1 ELSE 0 END) AS trades,
      SUM(CASE WHEN deal_type = 'rent' THEN 1 ELSE 0 END) AS rents,
      MIN(first_seen_at) AS fs_min,
      MAX(first_seen_at) AS fs_max,
      CAST((julianday(MAX(first_seen_at)) - julianday(MIN(first_seen_at))) * 86400 AS INTEGER) AS span_sec,
      MIN(deal_date) AS deal_min,
      MAX(deal_date) AS deal_max,
      COUNT(DISTINCT substr(deal_date, 1, 7)) AS distinct_months,
      COUNT(DISTINCT apt_name) AS apt_count,
      SUM(CASE WHEN deal_date = '2026-09-08' THEN 1 ELSE 0 END) AS deal_same_day,
      SUM(CASE WHEN substr(deal_date, 1, 7) = '2026-09' THEN 1 ELSE 0 END) AS deal_sep,
      SUM(CASE WHEN deal_date < '2026-09-01' THEN 1 ELSE 0 END) AS older_than_sep
    FROM transactions
    WHERE lawd_cd = '11680'
      AND first_seen_at IS NOT NULL AND first_seen_at != ''
      AND date(first_seen_at, '+9 hours') = '2026-09-08'
  `);
  console.log(gn.rows[0]);

  const gnMonths = await q(`
    SELECT substr(deal_date, 1, 7) AS ym, deal_type, COUNT(*) AS n
    FROM transactions
    WHERE lawd_cd = '11680'
      AND first_seen_at IS NOT NULL AND first_seen_at != ''
      AND date(first_seen_at, '+9 hours') = '2026-09-08'
    GROUP BY 1, 2
    ORDER BY 1, 2
  `);
  console.log("gangnam months:");
  for (const r of gnMonths.rows) console.log(r);

  const gnSec = await q(`
    SELECT first_seen_at, COUNT(*) AS n
    FROM transactions
    WHERE lawd_cd = '11680'
      AND first_seen_at IS NOT NULL AND first_seen_at != ''
      AND date(first_seen_at, '+9 hours') = '2026-09-08'
    GROUP BY 1
    ORDER BY n DESC
    LIMIT 12
  `);
  console.log("gangnam timestamp concentration:");
  for (const r of gnSec.rows) console.log(r);

  const gnArea = await q(`
    SELECT
      CASE
        WHEN exclusive_area < 60 THEN 'under60'
        WHEN exclusive_area < 85 THEN '60-85'
        WHEN exclusive_area < 102 THEN '85-102'
        ELSE 'over102'
      END AS bucket,
      COUNT(*) AS n
    FROM transactions
    WHERE lawd_cd = '11680'
      AND first_seen_at IS NOT NULL AND first_seen_at != ''
      AND date(first_seen_at, '+9 hours') = '2026-09-08'
      AND deal_type = 'trade'
    GROUP BY 1
    ORDER BY 1
  `);
  console.log("gangnam trade area:");
  for (const r of gnArea.rows) console.log(r);

  console.log("\n=== 2026-09-08 ALL CAPITAL lawd n>=30 ===");
  const d0808 = await q(`
    SELECT lawd_cd,
      COUNT(*) AS n,
      MIN(first_seen_at) AS tmin,
      MAX(first_seen_at) AS tmax,
      CAST((julianday(MAX(first_seen_at)) - julianday(MIN(first_seen_at))) * 86400 AS INTEGER) AS span_sec,
      MIN(deal_date) AS dmin,
      MAX(deal_date) AS dmax,
      COUNT(DISTINCT substr(deal_date, 1, 7)) AS months,
      SUM(CASE WHEN substr(deal_date, 1, 7) = '2026-09' THEN 1 ELSE 0 END) AS cur_month
    FROM transactions
    WHERE lawd_cd IN (${inList})
      AND first_seen_at IS NOT NULL AND first_seen_at != ''
      AND date(first_seen_at, '+9 hours') = '2026-09-08'
    GROUP BY lawd_cd
    ORDER BY n DESC
  `);
  for (const r of d0808.rows) {
    console.log({ ...r, region: lawdName.get(String(r.lawd_cd)) ?? "" });
  }

  console.log("\n=== 2026-09-09 KST ALL CAPITAL ===");
  const d0909 = await q(`
    SELECT lawd_cd,
      COUNT(*) AS n,
      MIN(first_seen_at) AS tmin,
      MAX(first_seen_at) AS tmax,
      CAST((julianday(MAX(first_seen_at)) - julianday(MIN(first_seen_at))) * 86400 AS INTEGER) AS span_sec,
      MIN(deal_date) AS dmin,
      MAX(deal_date) AS dmax,
      COUNT(DISTINCT substr(deal_date, 1, 7)) AS months
    FROM transactions
    WHERE lawd_cd IN (${inList})
      AND first_seen_at IS NOT NULL AND first_seen_at != ''
      AND date(first_seen_at, '+9 hours') = '2026-09-09'
    GROUP BY lawd_cd
    ORDER BY n DESC
  `);
  for (const r of d0909.rows) {
    console.log({ ...r, region: lawdName.get(String(r.lawd_cd)) ?? "" });
  }

  console.log("\n=== TOP 40 lawd-kst-date ===");
  const top = await q(`
    SELECT lawd_cd,
      date(first_seen_at, '+9 hours') AS kst_date,
      COUNT(*) AS n,
      MIN(first_seen_at) AS tmin,
      MAX(first_seen_at) AS tmax,
      CAST((julianday(MAX(first_seen_at)) - julianday(MIN(first_seen_at))) * 86400 AS INTEGER) AS span_sec,
      MIN(deal_date) AS dmin,
      MAX(deal_date) AS dmax,
      COUNT(DISTINCT substr(deal_date, 1, 7)) AS months,
      SUM(CASE WHEN substr(deal_date, 1, 7) >= '2026-06' THEN 1 ELSE 0 END) AS from_jun
    FROM transactions
    WHERE lawd_cd IN (${inList})
      AND first_seen_at IS NOT NULL AND first_seen_at != ''
    GROUP BY lawd_cd, date(first_seen_at, '+9 hours')
    ORDER BY n DESC
    LIMIT 40
  `);
  for (const r of top.rows) {
    console.log({ ...r, region: lawdName.get(String(r.lawd_cd)) ?? "" });
  }

  console.log("\n=== HOUR BUCKETS UTC ===");
  const hours = await q(`
    SELECT substr(first_seen_at, 1, 13) AS hour_utc, COUNT(*) AS n, COUNT(DISTINCT lawd_cd) AS lawds
    FROM transactions
    WHERE lawd_cd IN (${inList}) AND first_seen_at IS NOT NULL AND first_seen_at != ''
    GROUP BY 1
    ORDER BY 1
  `);
  for (const r of hours.rows) console.log(r);

  console.log("\n=== SAME-SECOND CONCENTRATION (n>=50) ===");
  const conc = await q(`
    SELECT first_seen_at, COUNT(*) AS n, COUNT(DISTINCT lawd_cd) AS lawds
    FROM transactions
    WHERE lawd_cd IN (${inList}) AND first_seen_at IS NOT NULL AND first_seen_at != ''
    GROUP BY 1
    HAVING n >= 50
    ORDER BY n DESC
    LIMIT 25
  `);
  for (const r of conc.rows) console.log(r);

  console.log("\n=== FOCUS REGIONS both KST dates ===");
  const focus = ["11680","11710","11170","41131","41133","41135","41111","41113","41115","41117","41360"];
  const focusSql = focus.map((c) => `'${c}'`).join(",");
  const focusRows = await q(`
    SELECT lawd_cd, date(first_seen_at, '+9 hours') AS kst_date, COUNT(*) AS n
    FROM transactions
    WHERE lawd_cd IN (${focusSql})
      AND first_seen_at IS NOT NULL AND first_seen_at != ''
    GROUP BY 1, 2
    ORDER BY 1, 2
  `);
  for (const r of focusRows.rows) {
    console.log({ ...r, region: lawdName.get(String(r.lawd_cd)) ?? "" });
  }

  console.log("\n=== PHASE C window first_seen NULL ===");
  const p = await q(`
    SELECT COUNT(*) AS n,
      MIN(last_seen_at) AS ls_min,
      MAX(last_seen_at) AS ls_max,
      COUNT(DISTINCT lawd_cd) AS lawds,
      SUM(CASE WHEN first_seen_at IS NULL OR first_seen_at = '' THEN 1 ELSE 0 END) AS fs_null
    FROM transactions
    WHERE lawd_cd IN (${inList})
      AND last_seen_at >= '2026-09-09T13:00:00'
      AND last_seen_at < '2026-09-09T14:00:00'
  `);
  console.log(p.rows[0]);

  console.log("\n=== first_seen NULL last_seen vs first_seen set last_seen same window ===");
  const p2 = await q(`
    SELECT
      SUM(CASE WHEN first_seen_at IS NULL OR first_seen_at = '' THEN 1 ELSE 0 END) AS fs_null,
      SUM(CASE WHEN first_seen_at IS NOT NULL AND first_seen_at != '' THEN 1 ELSE 0 END) AS fs_set,
      MIN(last_seen_at) AS ls_min,
      MAX(last_seen_at) AS ls_max
    FROM transactions
    WHERE last_seen_at >= '2026-09-09T13:00:00Z'
      AND last_seen_at < '2026-09-09T14:00:00Z'
  `);
  console.log(p2.rows[0]);

  console.log("\n=== last_seen vs first_seen equality on PHASE C nulls sample ===");
  const p3 = await q(`
    SELECT
      COUNT(*) AS n,
      SUM(CASE WHEN last_seen_at IS NOT NULL THEN 1 ELSE 0 END) AS has_last,
      MIN(last_seen_at) AS ls_min,
      MAX(last_seen_at) AS ls_max,
      CAST((julianday(MAX(last_seen_at)) - julianday(MIN(last_seen_at))) * 86400 AS INTEGER) AS span_sec
    FROM transactions
    WHERE lawd_cd IN (${inList})
      AND (first_seen_at IS NULL OR first_seen_at = '')
      AND last_seen_at >= '2026-09-09T13:00:00'
      AND last_seen_at < '2026-09-09T14:00:00'
  `);
  console.log(p3.rows[0]);

  console.log("\n=== EXPLAIN current Home first_seen day query ===");
  const expl = await db.execute(
    `EXPLAIN QUERY PLAN
     SELECT id FROM transactions
     WHERE deal_type = 'trade'
       AND first_seen_at IS NOT NULL
       AND first_seen_at != ''
       AND first_seen_at >= '2026-09-09T00:00:00.000Z'
       AND first_seen_at < '2026-09-10T00:00:00.000Z'`,
  );
  for (const r of expl.rows) console.log(r);

  console.log("\n=== EXPLAIN lawd + first_seen range ===");
  const expl2 = await db.execute(
    `EXPLAIN QUERY PLAN
     SELECT id FROM transactions
     WHERE lawd_cd = '11680'
       AND first_seen_at IS NOT NULL
       AND first_seen_at >= '2026-09-08T00:00:00.000Z'
       AND first_seen_at < '2026-09-09T00:00:00.000Z'`,
  );
  for (const r of expl2.rows) console.log(r);

  console.log("\n=== PRAGMA index list (read) ===");
  const idx = await q(`PRAGMA index_list(transactions)`);
  for (const r of idx.rows) console.log(r);

  console.log("DONE_READONLY");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

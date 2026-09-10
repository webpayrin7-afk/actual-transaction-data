/**
 * READ-ONLY warehouse inventory. No MOLIT. No writes.
 *   npx tsx scripts/audit-warehouse-inventory.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { getDb } from "../src/lib/db/client";

async function main() {
  const db = getDb();
  if (!db) throw new Error("no db");

  const totals = await db.execute(`
    SELECT deal_type,
           COUNT(*) AS n,
           MIN(deal_date) AS min_d,
           MAX(deal_date) AS max_d
    FROM transactions
    GROUP BY deal_type
  `);
  const yearly = await db.execute(`
    SELECT substr(deal_date,1,4) AS y,
           SUM(CASE WHEN deal_type='trade' THEN 1 ELSE 0 END) AS trade,
           SUM(CASE WHEN deal_type='rent' THEN 1 ELSE 0 END) AS rent,
           COUNT(*) AS n
    FROM transactions
    GROUP BY substr(deal_date,1,4)
    ORDER BY y
  `);
  const monthlyRecent = await db.execute(`
    SELECT year_month,
           SUM(CASE WHEN deal_type='trade' THEN 1 ELSE 0 END) AS trade,
           SUM(CASE WHEN deal_type='rent' THEN 1 ELSE 0 END) AS rent
    FROM transactions
    WHERE year_month >= '202001'
    GROUP BY year_month
    ORDER BY year_month
  `);
  const lawdMonths = await db.execute(`
    SELECT COUNT(*) AS n FROM (
      SELECT lawd_cd, year_month, deal_type
      FROM transactions
      GROUP BY lawd_cd, year_month, deal_type
    )
  `);
  const lawds = await db.execute(`
    SELECT COUNT(DISTINCT lawd_cd) AS n FROM transactions
  `);
  const syncCells = await db.execute(`
    SELECT COUNT(*) AS n, MIN(year_month) AS min_ym, MAX(year_month) AS max_ym
    FROM sync_months
  `);
  const discovery = await db.execute(`
    SELECT COUNT(*) AS n, MIN(discovery_at) AS min_d, MAX(discovery_at) AS max_d
    FROM transactions
    WHERE discovery_at IS NOT NULL AND discovery_at != ''
  `);

  const months = monthlyRecent.rows.map((r) => ({
    ym: String(r.year_month),
    trade: Number(r.trade),
    rent: Number(r.rent),
  }));
  const gaps: string[] = [];
  for (let i = 1; i < months.length; i++) {
    const prev = months[i - 1]!;
    const cur = months[i]!;
    const py = Number(prev.ym.slice(0, 4));
    const pm = Number(prev.ym.slice(4, 6));
    const expected =
      pm === 12 ? `${py + 1}01` : `${py}${String(pm + 1).padStart(2, "0")}`;
    if (cur.ym !== expected) gaps.push(`${prev.ym}->${cur.ym} (expected ${expected})`);
    if (cur.trade === 0) gaps.push(`${cur.ym} trade=0`);
  }

  console.log(
    JSON.stringify(
      {
        totals: totals.rows,
        yearly: yearly.rows,
        lawd_count: Number(lawds.rows[0]?.n),
        lawd_month_cells: Number(lawdMonths.rows[0]?.n),
        sync_months: syncCells.rows[0],
        discovery: discovery.rows[0],
        monthly_from_2020: months,
        gaps_from_2020: gaps,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

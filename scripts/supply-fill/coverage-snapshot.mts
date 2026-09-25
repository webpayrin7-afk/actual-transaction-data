/** Read-only coverage snapshot. */
import { config } from "dotenv";
import { createClient } from "@libsql/client";

config({ path: ".env.local", quiet: true });
const db = createClient({
  url: process.env.TURSO_DATABASE_URL!.trim(),
  authToken: process.env.TURSO_AUTH_TOKEN!.trim(),
});

const coverage = await db.execute(`
  WITH per AS (
    SELECT complex_id,
           SUM(supply_cents >= 0) AS supplied,
           SUM(status = 'NO_SOURCE') AS no_source
    FROM apt_canonical_unit_types GROUP BY complex_id
  ),
  tr AS (
    SELECT complex_id, SUM(trade_count_3y) AS t3y, SUM(trade_count) AS trades
    FROM apt_unit_exclusive_pairs GROUP BY complex_id
  )
  SELECT
    (SELECT COUNT(*) FROM apt_complex_master) AS master,
    SUM(supplied > 0 AND no_source = 0) AS full_supply,
    SUM(supplied = 0) AS only_no_source,
    SUM(CASE WHEN supplied > 0 AND no_source = 0 AND COALESCE(tr.t3y,0) > 0 THEN 1 ELSE 0 END) AS full_supply_3y,
    SUM(CASE WHEN supplied > 0 AND no_source = 0 AND COALESCE(tr.trades,0) > 0 THEN 1 ELSE 0 END) AS full_supply_traded,
    SUM(CASE WHEN COALESCE(tr.trades,0) > 0 THEN 1 ELSE 0 END) AS typed_traded,
    SUM(CASE WHEN COALESCE(tr.t3y,0) > 0 THEN 1 ELSE 0 END) AS typed_with_3y
  FROM per LEFT JOIN tr ON tr.complex_id = per.complex_id
`);
const noTrade = await db.execute(`
  SELECT COUNT(*) AS n
  FROM apt_complex_master m
  WHERE NOT EXISTS (
    SELECT 1 FROM apt_unit_exclusive_pairs p
    WHERE p.complex_id = m.complex_id AND p.trade_count > 0
  )
  AND NOT EXISTS (
    SELECT 1 FROM transactions t
    WHERE t.lawd_cd = m.lawd_cd AND t.apt_name_norm = m.apt_name_norm AND t.dong = m.legal_dong_name
  )
`);
console.log(JSON.stringify({ coverage: coverage.rows[0], noTradeComplexes: noTrade.rows[0]?.n }));

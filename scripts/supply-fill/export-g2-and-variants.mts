/** Export G2 complexes and REAL_VARIANT rows for the local fill. No writes to Turso. */
import { mkdirSync, writeFileSync } from "node:fs";
import { config } from "dotenv";
import { createClient } from "@libsql/client";

config({ path: ".env.local", quiet: true });
const db = createClient({
  url: process.env.TURSO_DATABASE_URL!.trim(),
  authToken: process.env.TURSO_AUTH_TOKEN!.trim(),
});

function num(v: unknown): number {
  return typeof v === "bigint" ? Number(v) : Number(v ?? 0);
}
function str(v: unknown): string {
  return v == null ? "" : String(v).trim();
}

const g2 = await db.execute(`
  WITH per AS (
    SELECT complex_id,
           SUM(CASE WHEN supply_cents >= 0 THEN 1 ELSE 0 END) AS supplied,
           SUM(CASE WHEN status = 'NO_SOURCE' THEN 1 ELSE 0 END) AS ns,
           COUNT(*) AS types
    FROM apt_canonical_unit_types
    GROUP BY complex_id
    HAVING supplied = 0 AND ns > 0
  ),
  tr AS (
    SELECT complex_id,
           SUM(trade_count) AS trades,
           SUM(trade_count_3y) AS t3y
    FROM apt_unit_exclusive_pairs
    GROUP BY complex_id
  )
  SELECT m.complex_id, m.apt_name, m.lawd_cd, m.bjdong_cd, m.jibun, m.legal_dong_name,
         m.sido, m.sigungu, per.types, COALESCE(tr.trades, 0) AS trades, COALESCE(tr.t3y, 0) AS t3y
  FROM per
  JOIN apt_complex_master m ON m.complex_id = per.complex_id
  LEFT JOIN tr ON tr.complex_id = per.complex_id
`);

const lines = g2.rows.map((row) =>
  JSON.stringify({
    complexId: str(row.complex_id),
    aptName: str(row.apt_name),
    lawdCd: str(row.lawd_cd),
    bjdongCd: str(row.bjdong_cd),
    jibun: str(row.jibun),
    dong: str(row.legal_dong_name),
    sido: str(row.sido),
    sigungu: str(row.sigungu),
    types: num(row.types),
    trades: num(row.trades),
    t3y: num(row.t3y),
  }),
);
mkdirSync("data/poc/supply", { recursive: true });
writeFileSync("data/poc/supply/g2-master.jsonl", lines.join("\n") + "\n");
const with3y = g2.rows.filter((r) => num(r.t3y) > 0).length;
const withTrade = g2.rows.filter((r) => num(r.trades) > 0).length;
console.log(JSON.stringify({ g2: g2.rows.length, withTrade, with3y, noTrade: g2.rows.length - withTrade }));

const rv = await db.execute(`
  SELECT c.complex_id, c.exclusive_cents, c.held_supply_cents, c.provenance_json,
         u.household_count AS held_household, u.unit_type_id, u.supply_cents AS canonical_supply
  FROM apt_unit_supply_conflicts c
  JOIN apt_supply_conflict_class k ON k.conflict_id = c.conflict_id
  LEFT JOIN apt_canonical_unit_types u
    ON u.complex_id = c.complex_id AND u.exclusive_cents = c.exclusive_cents AND u.supply_cents = c.held_supply_cents
  WHERE k.class = 'REAL_VARIANT'
`);
writeFileSync(
  "data/poc/supply/real-variant.jsonl",
  rv.rows
    .map((row) =>
      JSON.stringify({
        complexId: str(row.complex_id),
        exclusiveCents: num(row.exclusive_cents),
        heldSupplyCents: num(row.held_supply_cents),
        heldHousehold: row.held_household == null ? null : num(row.held_household),
        unitTypeId: str(row.unit_type_id),
        provenance: str(row.provenance_json),
      }),
    )
    .join("\n") + "\n",
);
console.log(JSON.stringify({ realVariantRows: rv.rows.length }));

/**
 * Export every master complex with identity fields, flagging the no-trade targets.
 * target = no trades (same definition as coverage-snapshot) AND no canonical unit type row.
 * All rows are exported so a PNU shared with any other master complex can be held.
 * Read-only.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { config } from "dotenv";
import { createClient } from "@libsql/client";

config({ path: ".env.local", quiet: true });
const db = createClient({
  url: process.env.TURSO_DATABASE_URL!.trim(),
  authToken: process.env.TURSO_AUTH_TOKEN!.trim(),
});
const str = (v: unknown) => (v == null ? "" : String(v).trim());
const num = (v: unknown) => (typeof v === "bigint" ? Number(v) : Number(v ?? 0));

const res = await db.execute(`
  WITH nt AS (
    SELECT m.complex_id FROM apt_complex_master m
    WHERE NOT EXISTS (SELECT 1 FROM apt_unit_exclusive_pairs p WHERE p.complex_id = m.complex_id AND p.trade_count > 0)
      AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.lawd_cd = m.lawd_cd AND t.apt_name_norm = m.apt_name_norm AND t.dong = m.legal_dong_name)
  ),
  ty AS (SELECT complex_id, COUNT(*) types FROM apt_canonical_unit_types GROUP BY complex_id)
  SELECT m.complex_id, m.apt_name, m.lawd_cd, m.bjdong_cd, m.jibun, m.legal_dong_name, m.sido, m.sigungu,
         (nt.complex_id IS NOT NULL) AS no_trade, COALESCE(ty.types, 0) AS types
  FROM apt_complex_master m
  LEFT JOIN nt ON nt.complex_id = m.complex_id
  LEFT JOIN ty ON ty.complex_id = m.complex_id
`);
const rows = res.rows.map((row) => ({
  complexId: str(row.complex_id),
  aptName: str(row.apt_name),
  lawdCd: str(row.lawd_cd),
  bjdongCd: str(row.bjdong_cd),
  jibun: str(row.jibun),
  dong: str(row.legal_dong_name),
  sido: str(row.sido),
  sigungu: str(row.sigungu),
  noTrade: num(row.no_trade) > 0,
  types: num(row.types),
  target: num(row.no_trade) > 0 && num(row.types) === 0,
}));
mkdirSync("data/poc/supply", { recursive: true });
writeFileSync("data/poc/supply/nt-master.jsonl", rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
console.log(
  JSON.stringify({
    master: rows.length,
    noTrade: rows.filter((r) => r.noTrade).length,
    noTradeWithTypes: rows.filter((r) => r.noTrade && r.types > 0).length,
    targets: rows.filter((r) => r.target).length,
  }),
);

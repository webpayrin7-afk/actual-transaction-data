/** Read-only: lawd codes whose complexes gained supply from the local fills (G2 + no-trade). */
import { writeFileSync } from "node:fs";
import { config } from "dotenv";
import { createClient } from "@libsql/client";

config({ path: ".env.local", quiet: true });
const db = createClient({
  url: process.env.TURSO_DATABASE_URL!.trim(),
  authToken: process.env.TURSO_AUTH_TOKEN!.trim(),
});
const res = await db.execute(`
  SELECT m.lawd_cd, m.sido, m.sigungu,
         COUNT(DISTINCT CASE WHEN u.provenance_json LIKE '%supply_fill_local_g2_2026_09%' THEN u.complex_id END) AS g2,
         COUNT(DISTINCT CASE WHEN u.provenance_json LIKE '%supply_fill_local_nt_2026_09%' THEN u.complex_id END) AS nt
  FROM apt_canonical_unit_types u
  JOIN apt_complex_master m ON m.complex_id = u.complex_id
  WHERE u.provenance_json LIKE '%supply_fill_local_g2_2026_09%' OR u.provenance_json LIKE '%supply_fill_local_nt_2026_09%'
  GROUP BY m.lawd_cd, m.sido, m.sigungu ORDER BY m.lawd_cd
`);
const rows = res.rows.map((r) => ({
  lawdCd: String(r.lawd_cd),
  sido: String(r.sido ?? ""),
  sigungu: String(r.sigungu ?? ""),
  g2: Number(r.g2),
  noTrade: Number(r.nt),
}));
writeFileSync("data/poc/supply/p3-affected-lawd.json", JSON.stringify(rows, null, 1));
console.log(JSON.stringify({
  lawdCodes: rows.length,
  withG2: rows.filter((r) => r.g2 > 0).map((r) => r.lawdCd),
  withNoTradeOnly: rows.filter((r) => r.g2 === 0).length,
}));

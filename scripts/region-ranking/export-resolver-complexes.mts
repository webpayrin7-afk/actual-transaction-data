/**
 * Export complexes that have AMBIGUOUS_MULTI pairs in Seoul/Gyeonggi
 * for local shard floor resolution. No API.
 */
import { writeFileSync } from "node:fs";
import { createClient } from "@libsql/client";

async function main() {
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL!.trim(),
    authToken: process.env.TURSO_AUTH_TOKEN!.trim(),
  });
  const rows = await db.execute(`
    SELECT DISTINCT p.complex_id, m.apt_name
    FROM apt_unit_exclusive_pairs p
    JOIN apt_complex_master m ON m.complex_id = p.complex_id
    WHERE p.resolution_status = 'AMBIGUOUS_MULTI'
      AND (m.lawd_cd LIKE '11%' OR m.lawd_cd LIKE '41%')
  `);
  const lines = rows.rows.map((r) => `${r.complex_id}\t${String(r.apt_name ?? "").replace(/\t/g, " ")}`);
  const path = "/tmp/building-hub-bulk/external-evidence/resolver-complexes.txt";
  writeFileSync(path, lines.join("\n") + "\n");
  console.log(JSON.stringify({ complexes: lines.length, path }));
}
main();

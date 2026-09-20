import { writeFileSync } from "node:fs";
import { createClient } from "@libsql/client";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL!.trim(),
  authToken: process.env.TURSO_AUTH_TOKEN!.trim(),
});
const rows = await db.execute(`
  SELECT m.complex_id, l.source_key
  FROM apt_unit_acquisition_manifest m
  JOIN apt_complex_source_links l ON l.complex_id = m.complex_id AND l.source = 'KAPT'
  WHERE m.jibun = '' OR m.jibun IS NULL
`);
const out = rows.rows.map((row) =>
  JSON.stringify({ complexId: String(row.complex_id), kaptCode: String(row.source_key) }),
);
writeFileSync("/tmp/building-hub-bulk/kapt-links.jsonl", out.join("\n") + "\n");
console.log({ links: out.length });

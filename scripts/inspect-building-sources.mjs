import { createClient } from "@libsql/client";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const tables = await db.execute(
  `SELECT name, type FROM sqlite_master WHERE type IN ('table','view') ORDER BY name`,
);
console.log("TABLES", tables.rows.length);
for (const r of tables.rows) console.log(`${r.type}\t${r.name}`);

async function safe(label, sql, args = []) {
  try {
    const res = await db.execute({ sql, args });
    console.log(`\n=== ${label} ===`);
    for (const row of res.rows) console.log(JSON.stringify(row));
  } catch (e) {
    console.log(`\n=== ${label} ERROR ===`);
    console.log(e.message);
  }
}

await safe("master count", `SELECT COUNT(*) AS n FROM apt_complex_master`);
await safe(
  "master sido",
  `SELECT sido, COUNT(*) AS n FROM apt_complex_master GROUP BY sido ORDER BY n DESC`,
);
await safe(
  "ouac count",
  `SELECT COUNT(*) AS n, COUNT(DISTINCT complex_id) AS complexes FROM official_unit_area_cache`,
);
await safe(
  "ouac provider",
  `SELECT source_provider, source_dataset, COUNT(*) AS n, COUNT(DISTINCT complex_id) AS complexes FROM official_unit_area_cache GROUP BY 1,2`,
);
await safe(
  "canonical count",
  `SELECT COUNT(*) AS n, COUNT(DISTINCT complex_id) AS complexes, status, COUNT(*) FROM apt_canonical_unit_types GROUP BY status`,
);
await safe(
  "canonical status",
  `SELECT status, COUNT(*) AS n, COUNT(DISTINCT complex_id) AS complexes FROM apt_canonical_unit_types GROUP BY status`,
);
await safe(
  "checkpoint",
  `SELECT status, COUNT(*) AS n FROM official_unit_area_checkpoint GROUP BY status`,
);
await safe(
  "source links",
  `SELECT source_kind, COUNT(*) FROM apt_complex_source_links GROUP BY 1`,
);
await safe(
  "profile count",
  `SELECT COUNT(*) AS n FROM apt_complex_profile`,
);
await safe(
  "sqlite_master building-ish",
  `SELECT name FROM sqlite_master WHERE name LIKE '%build%' OR name LIKE '%geom%' OR name LIKE '%pnu%' OR name LIKE '%kapt%' OR name LIKE '%hub%' OR name LIKE '%registry%' OR name LIKE '%dong%' OR name LIKE '%foot%' ORDER BY name`,
);

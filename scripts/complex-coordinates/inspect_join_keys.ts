/**
 * Read-only: Seoul complex join-key coverage + source_links inventory.
 * No Production writes.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@libsql/client";
import { writeFileSync, mkdirSync } from "fs";

async function main() {
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN!,
  });

  const tables = await db.execute(
    `SELECT name FROM sqlite_master WHERE type='table' ORDER BY 1`,
  );
  const names = tables.rows.map((r) => String(r.name));
  console.log(
    "relevant tables",
    names.filter((n) => /source|kapt|enrich|parcel|coord/i.test(n)),
  );

  for (const t of [
    "apt_complex_source_links",
    "apt_complex_enrichment_state",
    "apt_complex_master",
  ]) {
    if (!names.includes(t)) {
      console.log(t, "MISSING");
      continue;
    }
    const cols = await db.execute(`PRAGMA table_info(${t})`);
    console.log(
      t,
      "cols",
      cols.rows.map((r) => r.name),
    );
  }

  if (names.includes("apt_complex_source_links")) {
    const links = await db.execute(
      `SELECT source, COUNT(*) AS c
       FROM apt_complex_source_links
       GROUP BY 1 ORDER BY c DESC LIMIT 30`,
    );
    console.log("sources", links.rows);

    const jamsil = await db.execute(
      `SELECT * FROM apt_complex_source_links
       WHERE complex_id = 'cx_4c63d9a100973c60'`,
    );
    console.log("jamsil_links", jamsil.rows);

    const sample = await db.execute(
      `SELECT * FROM apt_complex_source_links LIMIT 8`,
    );
    console.log("link_sample", sample.rows);

    const kapt = await db.execute(
      `SELECT COUNT(*) AS c FROM apt_complex_source_links
       WHERE source LIKE '%kapt%' OR source_key LIKE 'A%'`,
    );
    console.log("kaptish_links", kapt.rows[0]);

    const seoulKapt = await db.execute(
      `SELECT COUNT(DISTINCT l.complex_id) AS c
       FROM apt_complex_source_links l
       JOIN apt_complex_master m ON m.complex_id = l.complex_id
       WHERE m.sido LIKE '%서울%'
         AND (l.source LIKE '%kapt%' OR l.source_key LIKE 'A%')`,
    );
    console.log("seoul_complexes_with_kaptish", seoulKapt.rows[0]);
  }

  const cov = await db.execute(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN lawd_cd IS NOT NULL AND TRIM(lawd_cd) != '' THEN 1 ELSE 0 END) AS lawd,
      SUM(CASE WHEN legal_dong_name IS NOT NULL AND TRIM(legal_dong_name) != '' THEN 1 ELSE 0 END) AS dong,
      SUM(CASE WHEN jibun IS NOT NULL AND TRIM(jibun) != '' THEN 1 ELSE 0 END) AS jibun,
      SUM(CASE WHEN road_address IS NOT NULL AND TRIM(road_address) != '' THEN 1 ELSE 0 END) AS road,
      SUM(CASE WHEN latitude IS NOT NULL AND longitude IS NOT NULL THEN 1 ELSE 0 END) AS latlng,
      SUM(CASE WHEN identity_status IS NOT NULL THEN 1 ELSE 0 END) AS identity_status
    FROM apt_complex_master
    WHERE sido LIKE '%서울%'
  `);
  console.log("master_coverage", cov.rows[0]);

  // bun/ji parseability from jibun
  const rows = await db.execute(`
    SELECT complex_id, lawd_cd, legal_dong_name, jibun, road_address, apt_name
    FROM apt_complex_master
    WHERE sido LIKE '%서울%'
  `);

  let bunJi = 0;
  let parcelKey = 0; // lawd(5)+??? we need 10-digit bjd — lawd alone insufficient
  const jibunRe = /^(\d+)(?:-(\d+))?$/;
  for (const r of rows.rows) {
    const j = String(r.jibun ?? "").trim();
    const m = jibunRe.exec(j);
    if (m) {
      bunJi += 1;
      if (r.lawd_cd) parcelKey += 1; // provisional: lawd+bun+ji without mountain flag / full bjdong
    }
  }
  console.log({
    bun_ji_parseable: bunJi,
    lawd_plus_bun_ji: parcelKey,
    note: "full 19-digit PNU needs 10-digit bjdong + mountain flag; lawd_cd is 5-digit sigungu",
  });

  mkdirSync("/tmp/coord-source", { recursive: true });
  writeFileSync(
    "/tmp/coord-source/join-key-coverage.json",
    JSON.stringify(
      {
        master_coverage: cov.rows[0],
        bun_ji_parseable: bunJi,
        lawd_plus_bun_ji: parcelKey,
        total_rows: rows.rows.length,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

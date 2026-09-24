import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@libsql/client";
import { writeFileSync, mkdirSync } from "fs";

async function main() {
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN!,
  });

  const seoul = await db.execute({
    sql: `SELECT l.source, COUNT(DISTINCT l.complex_id) AS c
          FROM apt_complex_source_links l
          JOIN apt_complex_master m ON m.complex_id = l.complex_id
          WHERE m.sido LIKE ?
          GROUP BY 1 ORDER BY c DESC`,
    args: ["%서울%"],
  });
  console.log("seoul_by_source", seoul.rows);

  const bjd = await db.execute({
    sql: `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN bjdong_cd IS NOT NULL AND TRIM(bjdong_cd) != '' THEN 1 ELSE 0 END) AS bjdong,
        SUM(CASE WHEN length(trim(bjdong_cd)) = 5 THEN 1 ELSE 0 END) AS bjdong5,
        SUM(CASE WHEN length(trim(bjdong_cd)) = 10 THEN 1 ELSE 0 END) AS bjdong10
      FROM apt_complex_master WHERE sido LIKE ?`,
    args: ["%서울%"],
  });
  console.log("bjdong", bjd.rows[0]);

  const samp = await db.execute({
    sql: `SELECT complex_id, apt_name, lawd_cd, bjdong_cd, jibun, identity_status
          FROM apt_complex_master WHERE sido LIKE ? LIMIT 10`,
    args: ["%서울%"],
  });
  console.log("sample", samp.rows);

  const hub = await db.execute({
    sql: `SELECT l.complex_id, m.apt_name, m.sigungu, m.legal_dong_name, m.jibun,
                 m.bjdong_cd, m.lawd_cd, l.source_key, l.source_meta_json
          FROM apt_complex_source_links l
          JOIN apt_complex_master m ON m.complex_id = l.complex_id
          WHERE m.sido LIKE ? AND l.source = ?
          LIMIT 20`,
    args: ["%서울%", "BUILDING_HUB_PARCEL"],
  });
  console.log("hub_parcel", hub.rows);

  const kapt = await db.execute({
    sql: `SELECT l.complex_id, m.apt_name, l.source_key
          FROM apt_complex_source_links l
          JOIN apt_complex_master m ON m.complex_id = l.complex_id
          WHERE m.sido LIKE ? AND l.source = ?`,
    args: ["%서울%", "KAPT"],
  });
  console.log("kapt_links", kapt.rows);

  mkdirSync("/tmp/coord-source", { recursive: true });
  writeFileSync(
    "/tmp/coord-source/source-link-coverage.json",
    JSON.stringify(
      {
        seoul_by_source: seoul.rows,
        bjdong: bjd.rows[0],
        hub_parcel_sample: hub.rows,
        kapt_links: kapt.rows,
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

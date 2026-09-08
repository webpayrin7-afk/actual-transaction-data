import { config } from "dotenv";
config({ path: ".env.local" });
import { getDb, ensureSchema } from "../src/lib/db/client";

async function main() {
  await ensureSchema();
  const db = getDb();
  if (!db) throw new Error("no db");

  const coverage = await db.execute({
    sql: `SELECT
      SUM(CASE WHEN trim(coalesce(jibun,'')) = '' THEN 1 ELSE 0 END) AS empty_jibun,
      SUM(CASE WHEN trim(coalesce(dong,'')) = '' THEN 1 ELSE 0 END) AS empty_dong,
      SUM(CASE WHEN build_year IS NULL THEN 1 ELSE 0 END) AS empty_by,
      COUNT(*) AS total
      FROM transactions WHERE deal_type = ?`,
    args: ["trade"],
  });
  console.log("coverage", coverage.rows[0]);

  const daewoo = await db.execute({
    sql: `SELECT apt_name, lawd_cd, gu, dong, jibun, build_year, COUNT(*) AS c,
                 MIN(deal_amount) AS min_a, MAX(deal_amount) AS max_a
          FROM transactions WHERE deal_type = ? AND apt_name_norm = ?
          GROUP BY lawd_cd, gu, dong, jibun, build_year
          ORDER BY c DESC LIMIT 20`,
    args: ["trade", "대우"],
  });
  console.log("대우 groups", daewoo.rows);

  const multiGu = await db.execute({
    sql: `SELECT COUNT(*) AS pairs FROM (
      SELECT apt_name_norm, gu FROM transactions WHERE deal_type = ?
      GROUP BY apt_name_norm, gu HAVING COUNT(DISTINCT dong) > 1
    )`,
    args: ["trade"],
  });
  console.log("name+gu multi-dong", multiGu.rows[0]);

  const multiLawdDong = await db.execute({
    sql: `SELECT COUNT(*) AS pairs FROM (
      SELECT apt_name_norm, lawd_cd FROM transactions WHERE deal_type = ?
      GROUP BY apt_name_norm, lawd_cd HAVING COUNT(DISTINCT dong) > 1
    )`,
    args: ["trade"],
  });
  console.log("name+lawd multi-dong", multiLawdDong.rows[0]);

  const multiJibun = await db.execute({
    sql: `SELECT COUNT(*) AS pairs FROM (
      SELECT apt_name_norm, lawd_cd, dong FROM transactions WHERE deal_type = ?
      GROUP BY apt_name_norm, lawd_cd, dong HAVING COUNT(DISTINCT jibun) > 1
    )`,
    args: ["trade"],
  });
  console.log("name+lawd+dong multi-jibun", multiJibun.rows[0]);

  const multiBy = await db.execute({
    sql: `SELECT COUNT(*) AS pairs FROM (
      SELECT apt_name_norm, lawd_cd, dong FROM transactions WHERE deal_type = ?
      GROUP BY apt_name_norm, lawd_cd, dong HAVING COUNT(DISTINCT coalesce(build_year,-1)) > 1
    )`,
    args: ["trade"],
  });
  console.log("name+lawd+dong multi-buildYear", multiBy.rows[0]);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

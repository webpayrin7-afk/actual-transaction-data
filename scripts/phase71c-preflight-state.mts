#!/usr/bin/env npx tsx
import { createClient } from "@libsql/client";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const OUT = join(process.cwd(), "data/poc/phase71c");
mkdirSync(OUT, { recursive: true });

async function main() {
  const cohort = JSON.parse(
    readFileSync("data/poc/phase71/sample-cohort.json", "utf8"),
  ) as { complexes: Array<{ complex_id: string; apt_name: string; kapt_code: string | null }> };
  const ids = cohort.complexes.map((c) => c.complex_id);
  const ph = ids.map(() => "?").join(",");
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });

  // Discover master columns
  const cols = await db.execute(`PRAGMA table_info(apt_complex_master)`);
  const colNames = cols.rows.map((r) => String(r.name));
  const enrichCols = (await db.execute(`PRAGMA table_info(apt_complex_enrichment_state)`)).rows.map((r) => String(r.name));
  const linkCols = (await db.execute(`PRAGMA table_info(apt_complex_source_links)`)).rows.map((r) => String(r.name));
  const feeCols = (await db.execute(`PRAGMA table_info(apt_complex_mgmt_fee_monthly)`)).rows.map((r) => String(r.name));
  const profileCols = (await db.execute(`PRAGMA table_info(apt_complex_profile)`)).rows.map((r) => String(r.name));

  const masterSelect = [
    "complex_id",
    colNames.includes("apt_name") ? "apt_name" : "NULL AS apt_name",
    colNames.includes("apt_name_norm") ? "apt_name_norm" : colNames.includes("apt_name_norm") ? "apt_name_norm" : "NULL AS apt_name_norm",
    colNames.includes("lawd_cd") ? "lawd_cd" : colNames.includes("lawd_cd") ? "lawd_cd" : "NULL AS lawd_cd",
    colNames.includes("bjdong_cd") ? "bjdong_cd" : colNames.includes("bjdong_cd") ? "bjdong_cd" : "NULL AS bjdong_cd",
    colNames.includes("jibun") ? "jibun" : "NULL AS jibun",
  ].join(", ");

  const masters = await db.execute({
    sql: `SELECT ${masterSelect} FROM apt_complex_master WHERE complex_id IN (${ph})`,
    args: ids,
  });
  const counts = await db.execute({
    sql: `SELECT domain, status, COUNT(*) AS n FROM apt_complex_enrichment_state WHERE complex_id IN (${ph}) GROUP BY 1,2 ORDER BY 1,2`,
    args: ids,
  });
  const links = await db.execute({
    sql: `SELECT complex_id, source, source_key FROM apt_complex_source_links WHERE complex_id IN (${ph}) ORDER BY 1,2`,
    args: ids,
  });
  const fees = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM apt_complex_mgmt_fee_monthly WHERE complex_id IN (${ph})`,
    args: ids,
  });
  const profiles = await db.execute({
    sql: `SELECT complex_id, source, household_count, heating_type, management_type FROM apt_complex_profile WHERE complex_id IN (${ph})`,
    args: ids,
  });

  const report = {
    colNames: { master: colNames, enrich: enrichCols, link: linkCols, fee: feeCols, profile: profileCols },
    counts: counts.rows,
    masters: masters.rows,
    links: links.rows,
    fee_rows: fees.rows[0],
    profiles: profiles.rows,
    cohort,
  };
  writeFileSync(join(OUT, "preflight-state.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    counts: counts.rows,
    fee_rows: fees.rows[0],
    kapt_links: links.rows.filter((r) => String(r.source) === "KAPT"),
    master_cols: colNames,
    fee_cols: feeCols,
    enrich_cols: enrichCols,
  }, null, 2));
  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * Create empty ranking tables after the static precheck passes.
 * Does not insert feature rows or ranking rows.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@libsql/client";
import {
  FEATURE_COLUMNS,
  FEATURE_TABLE,
  RANKING_COLUMNS,
  RANKING_INDEXES,
  RANKING_TABLE,
  precheckRankingMigrationSql,
} from "../../src/lib/region-ranking/migration-precheck";

const SQL_PATH = "src/lib/db/migrations/20260919_region_ranking_foundation.sql";
const OUT_PATH = "data/poc/region-ranking/schema-apply-result.json";
const SENTINEL_TABLES = ["apt_complex_master", "apt_complex_profile", "transactions"] as const;

function countCell(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error("bad count");
  return n;
}

async function tableNames(db: { execute: (sql: string) => Promise<{ rows: Array<Record<string, unknown>> }> }) {
  const result = await db.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  return result.rows.map((row) => String(row.name));
}

async function rowCount(
  db: { execute: (args: { sql: string; args: string[] }) => Promise<{ rows: Array<Record<string, unknown>> }> },
  table: string,
) {
  if (!/^[a-z_]+$/.test(table)) throw new Error("bad table");
  const result = await db.execute({ sql: `SELECT COUNT(*) AS c FROM ${table}`, args: [] });
  return countCell(result.rows[0]?.c);
}

async function columnsOf(
  db: { execute: (args: { sql: string; args: string[] }) => Promise<{ rows: Array<Record<string, unknown>> }> },
  table: string,
) {
  const result = await db.execute({ sql: `PRAGMA table_info(${table})`, args: [] });
  return result.rows.map((row) => String(row.name));
}

async function main() {
  const sql = readFileSync(SQL_PATH, "utf8");
  const precheck = precheckRankingMigrationSql(sql);
  if (!precheck.ok) {
    console.log(JSON.stringify({ precheck: "FAIL", reason: precheck.reason }));
    process.exit(2);
  }
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
  const beforeTables = await tableNames(db);
  const beforeCounts: Record<string, number> = {};
  for (const table of SENTINEL_TABLES) {
    if (!beforeTables.includes(table)) throw new Error(`missing sentinel ${table}`);
    beforeCounts[table] = await rowCount(db, table);
  }
  const already = beforeTables.includes(FEATURE_TABLE) && beforeTables.includes(RANKING_TABLE);
  if (already) {
    const featureCols = await columnsOf(db, FEATURE_TABLE);
    const rankingCols = await columnsOf(db, RANKING_TABLE);
    if (featureCols.join(",") !== FEATURE_COLUMNS.join(",") || rankingCols.join(",") !== RANKING_COLUMNS.join(",")) {
      throw new Error("existing ranking schema does not match the contract");
    }
    const featureRows = await rowCount(db, FEATURE_TABLE);
    const rankingRows = await rowCount(db, RANKING_TABLE);
    if (featureRows !== 0 || rankingRows !== 0) throw new Error("ranking tables are not empty");
  } else if (beforeTables.includes(FEATURE_TABLE) || beforeTables.includes(RANKING_TABLE)) {
    throw new Error("partial ranking schema present");
  } else {
    const tx = await db.transaction("write");
    try {
      for (const statement of precheck.statements) {
        await tx.execute(statement);
      }
      const featureRows = countCell((await tx.execute(`SELECT COUNT(*) AS c FROM ${FEATURE_TABLE}`)).rows[0]?.c);
      const rankingRows = countCell((await tx.execute(`SELECT COUNT(*) AS c FROM ${RANKING_TABLE}`)).rows[0]?.c);
      if (featureRows !== 0 || rankingRows !== 0) throw new Error("new tables are not empty");
      for (const table of SENTINEL_TABLES) {
        const after = countCell((await tx.execute(`SELECT COUNT(*) AS c FROM ${table}`)).rows[0]?.c);
        if (after !== beforeCounts[table]) throw new Error(`sentinel changed ${table}`);
      }
      await tx.commit();
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  }
  const afterTables = await tableNames(db);
  const afterCounts: Record<string, number> = {};
  for (const table of SENTINEL_TABLES) afterCounts[table] = await rowCount(db, table);
  for (const table of SENTINEL_TABLES) {
    if (afterCounts[table] !== beforeCounts[table]) throw new Error(`sentinel changed ${table}`);
  }
  const added = afterTables.filter((name) => !beforeTables.includes(name));
  if (!already && added.sort().join(",") !== [FEATURE_TABLE, RANKING_TABLE].sort().join(",")) {
    throw new Error(`unexpected tables ${added.join(",")}`);
  }
  const featureCols = await columnsOf(db, FEATURE_TABLE);
  const rankingCols = await columnsOf(db, RANKING_TABLE);
  if (featureCols.join(",") !== FEATURE_COLUMNS.join(",")) throw new Error("feature columns mismatch");
  if (rankingCols.join(",") !== RANKING_COLUMNS.join(",")) throw new Error("ranking columns mismatch");
  const indexRows = await db.execute(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  const indexes = indexRows.rows.map((row) => String(row.name));
  for (const name of RANKING_INDEXES) {
    if (!indexes.includes(name)) throw new Error(`missing index ${name}`);
  }
  const featureRows = await rowCount(db, FEATURE_TABLE);
  const rankingRows = await rowCount(db, RANKING_TABLE);
  if (featureRows !== 0 || rankingRows !== 0) throw new Error("row count is not zero");
  const doc = {
    status: already ? "SCHEMA_ALREADY_PRESENT" : "SCHEMA_APPLIED",
    precheck: "PASS",
    production_schema_write: !already,
    feature_data_write: false,
    ranking_data_write: false,
    tables: [FEATURE_TABLE, RANKING_TABLE],
    indexes: RANKING_INDEXES,
    feature_rows: featureRows,
    ranking_rows: rankingRows,
    unrelated_data_changed: false,
  };
  writeFileSync(OUT_PATH, JSON.stringify(doc, null, 2) + "\n");
  console.log(JSON.stringify(doc));
  db.close();
}

main();

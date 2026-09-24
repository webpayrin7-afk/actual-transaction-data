/**
 * Copy a local living snapshot SQLite into Turso.
 * Touches only complex_living_* and living_category_rules.
 * Same source_version + snapshot_version rerun is an upsert that no-ops
 * when every stored field already matches.
 */
import { createClient, type Client, type InArgs } from "@libsql/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SNAPSHOT_INSERT = `
INSERT INTO complex_living_snapshots (
  complex_id, radius_m, product_category, product_subcategory, facility_count,
  quality_status, coordinate_semantics, distance_metric,
  source_provider, source_dataset, source_version, source_as_of,
  rule_version, snapshot_version, built_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(
  complex_id, radius_m, product_category, product_subcategory, source_version, snapshot_version
) DO UPDATE SET
  facility_count = excluded.facility_count,
  quality_status = excluded.quality_status,
  coordinate_semantics = excluded.coordinate_semantics,
  distance_metric = excluded.distance_metric,
  source_provider = excluded.source_provider,
  source_dataset = excluded.source_dataset,
  source_as_of = excluded.source_as_of,
  rule_version = excluded.rule_version,
  built_at = excluded.built_at
WHERE complex_living_snapshots.facility_count IS NOT excluded.facility_count
   OR complex_living_snapshots.quality_status IS NOT excluded.quality_status
   OR complex_living_snapshots.coordinate_semantics IS NOT excluded.coordinate_semantics
   OR complex_living_snapshots.distance_metric IS NOT excluded.distance_metric
   OR complex_living_snapshots.source_provider IS NOT excluded.source_provider
   OR complex_living_snapshots.source_dataset IS NOT excluded.source_dataset
   OR complex_living_snapshots.source_as_of IS NOT excluded.source_as_of
   OR complex_living_snapshots.rule_version IS NOT excluded.rule_version
`;

const READINESS_INSERT = `
INSERT INTO complex_living_readiness (
  complex_id, source_version, snapshot_version, quality_status, coordinate_semantics, built_at
) VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(complex_id, source_version, snapshot_version) DO UPDATE SET
  quality_status = excluded.quality_status,
  coordinate_semantics = excluded.coordinate_semantics,
  built_at = excluded.built_at
WHERE complex_living_readiness.quality_status IS NOT excluded.quality_status
   OR IFNULL(complex_living_readiness.coordinate_semantics, '') IS NOT IFNULL(excluded.coordinate_semantics, '')
`;

const RULE_INSERT = `
INSERT INTO living_category_rules (
  rule_version, source_provider, source_category_code, source_category_name,
  product_category, product_subcategory
) VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(rule_version, source_provider, source_category_code) DO UPDATE SET
  source_category_name = excluded.source_category_name,
  product_category = excluded.product_category,
  product_subcategory = excluded.product_subcategory
WHERE living_category_rules.source_category_name IS NOT excluded.source_category_name
   OR living_category_rules.product_category IS NOT excluded.product_category
   OR living_category_rules.product_subcategory IS NOT excluded.product_subcategory
`;

const PUBLICATION_INSERT = `
INSERT INTO complex_living_publications (
  source_version, snapshot_version, rule_version, source_provider, source_dataset,
  source_as_of, is_current, built_at, complex_count, note
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(source_version, snapshot_version) DO UPDATE SET
  rule_version = excluded.rule_version,
  source_provider = excluded.source_provider,
  source_dataset = excluded.source_dataset,
  source_as_of = excluded.source_as_of,
  is_current = excluded.is_current,
  complex_count = excluded.complex_count,
  note = excluded.note,
  built_at = complex_living_publications.built_at
WHERE complex_living_publications.rule_version IS NOT excluded.rule_version
   OR complex_living_publications.source_provider IS NOT excluded.source_provider
   OR complex_living_publications.source_dataset IS NOT excluded.source_dataset
   OR complex_living_publications.source_as_of IS NOT excluded.source_as_of
   OR complex_living_publications.is_current IS NOT excluded.is_current
   OR complex_living_publications.complex_count IS NOT excluded.complex_count
   OR IFNULL(complex_living_publications.note, '') IS NOT IFNULL(excluded.note, '')
`;

const ALLOWED_SQL_TABLES = [
  "complex_living_snapshots",
  "complex_living_readiness",
  "complex_living_publications",
  "living_category_rules",
];

export type ApplyStats = {
  snapshotInserts: number;
  snapshotUpdates: number;
  readinessInserts: number;
  readinessUpdates: number;
  ruleInserts: number;
  ruleUpdates: number;
  publicationInserts: number;
  publicationUpdates: number;
  pointerClears: number;
};

function assertAllowed(sql: string) {
  const names = sql.match(/[a-z_]+/g) ?? [];
  for (const name of names) {
    if (name.endsWith("_snapshots") || name.endsWith("_readiness") || name.endsWith("_publications") || name.endsWith("_rules")) {
      if (!ALLOWED_SQL_TABLES.includes(name)) {
        throw new Error(`refusing SQL touching ${name}`);
      }
    }
  }
}

async function count(db: Client, table: string, where = "", args: InArgs = []) {
  assertAllowed(`SELECT ${table}`);
  const rs = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM ${table} ${where}`,
    args,
  });
  return Number(rs.rows[0].n);
}

async function applyStatements(
  db: Client,
  table: string,
  sql: string,
  rows: InArgs[],
  batchSize: number,
): Promise<{ inserts: number; updates: number }> {
  assertAllowed(sql);
  const before = await count(db, table);
  let affected = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize);
    const statements = chunk.map((args) => ({ sql, args }));
    let rs = null;
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        rs = await db.batch(statements, "write");
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        const message = String(error?.cause?.code || error?.message || error);
        console.error(`[apply] retry ${attempt} ${table} ${i} ${message}`);
        if (attempt === 3) break;
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }
    if (!rs) throw lastError;
    for (const result of rs) affected += result.rowsAffected;
    if (i > 0 && i % (batchSize * 20) === 0) {
      console.error(`[apply] ${table} ${i}/${rows.length}`);
    }
  }
  const after = await count(db, table);
  const inserts = after - before;
  return { inserts, updates: affected - inserts };
}

export async function applyLivingDatabase(local: Client, remote: Client, batchSize = 40): Promise<ApplyStats> {
  const schema = readFileSync(
    resolve("src/lib/db/migrations/20260920_complex_living_snapshots.sql"),
    "utf8",
  );
  await remote.executeMultiple(schema);

  const snapshots = await local.execute("SELECT * FROM complex_living_snapshots");
  const readiness = await local.execute("SELECT * FROM complex_living_readiness");
  const rules = await local.execute("SELECT * FROM living_category_rules");
  const publications = await local.execute("SELECT * FROM complex_living_publications");

  const snapStats = await applyStatements(
    remote,
    "complex_living_snapshots",
    SNAPSHOT_INSERT,
    snapshots.rows.map((row) => [
      row.complex_id,
      row.radius_m,
      row.product_category,
      row.product_subcategory,
      row.facility_count,
      row.quality_status,
      row.coordinate_semantics,
      row.distance_metric,
      row.source_provider,
      row.source_dataset,
      row.source_version,
      row.source_as_of,
      row.rule_version,
      row.snapshot_version,
      row.built_at,
    ]),
    batchSize,
  );
  const readyStats = await applyStatements(
    remote,
    "complex_living_readiness",
    READINESS_INSERT,
    readiness.rows.map((row) => [
      row.complex_id,
      row.source_version,
      row.snapshot_version,
      row.quality_status,
      row.coordinate_semantics,
      row.built_at,
    ]),
    batchSize,
  );
  const ruleStats = await applyStatements(
    remote,
    "living_category_rules",
    RULE_INSERT,
    rules.rows.map((row) => [
      row.rule_version,
      row.source_provider,
      row.source_category_code,
      row.source_category_name,
      row.product_category,
      row.product_subcategory,
    ]),
    batchSize,
  );
  const pubStats = await applyStatements(
    remote,
    "complex_living_publications",
    PUBLICATION_INSERT,
    publications.rows.map((row) => [
      row.source_version,
      row.snapshot_version,
      row.rule_version,
      row.source_provider,
      row.source_dataset,
      row.source_as_of,
      row.is_current,
      row.built_at,
      row.complex_count,
      row.note,
    ]),
    batchSize,
  );

  const currents = publications.rows.filter((row) => Number(row.is_current) === 1);
  if (currents.length !== 1) {
    throw new Error(`expected one current publication, found ${currents.length}`);
  }
  const current = currents[0];
  const cleared = await remote.execute({
    sql: `UPDATE complex_living_publications
          SET is_current = 0
          WHERE is_current = 1
            AND NOT (source_version = ? AND snapshot_version = ?)`,
    args: [current.source_version, current.snapshot_version],
  });
  const pointerClears = cleared.rowsAffected;

  return {
    snapshotInserts: snapStats.inserts,
    snapshotUpdates: snapStats.updates,
    readinessInserts: readyStats.inserts,
    readinessUpdates: readyStats.updates,
    ruleInserts: ruleStats.inserts,
    ruleUpdates: ruleStats.updates,
    publicationInserts: pubStats.inserts,
    publicationUpdates: pubStats.updates,
    pointerClears,
  };
}

async function main() {
  const commit = process.argv.includes("--commit");
  const localPath = process.argv.find((arg) => arg.startsWith("--local="))?.slice("--local=".length);
  if (!localPath) throw new Error("--local=path required");
  const local = createClient({ url: `file:${resolve(localPath)}` });
  if (!commit) {
    const n = await count(local, "complex_living_snapshots");
    const r = await count(local, "complex_living_readiness");
    console.log(JSON.stringify({ dryRun: true, snapshots: n, readiness: r }));
    return;
  }
  const batchArg = process.argv.find((arg) => arg.startsWith("--batch="));
  const batchSize = batchArg ? Number(batchArg.slice("--batch=".length)) : 40;
  if (!Number.isFinite(batchSize) || batchSize < 1) throw new Error("bad --batch");
  const url = process.env.TURSO_DATABASE_URL?.trim();
  const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
  if (!url || url.startsWith("file:") || !authToken) {
    throw new Error("refusing apply without remote TURSO");
  }
  const remote = createClient({ url, authToken });
  const stats = await applyLivingDatabase(local, remote, batchSize);
  console.log(JSON.stringify(stats));
}

const invoked = process.argv[1]?.includes("apply-living-snapshots");
if (invoked) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

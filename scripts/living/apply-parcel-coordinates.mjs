/**
 * Fill NULL apt_complex_master coordinates from a SAFE parcel-point file.
 *
 * Writes latitude/longitude only where both are NULL, plus
 * complex_parcel_coordinates provenance. Does not touch living category
 * rules, school, supply, ranking, price-position, or building tables.
 *
 * Usage: node scripts/living/apply-parcel-coordinates.mjs --commit
 * Without --commit, prints the planned fill count and writes nothing.
 */
import { createClient } from "@libsql/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const commit = process.argv.includes("--commit");
const safePath =
  process.argv.find((arg) => arg.startsWith("--safe="))?.slice("--safe=".length) ||
  "data/cache/parcels/parcel-coordinates-safe.jsonl";
const rows = readFileSync(resolve(safePath), "utf8")
  .split("\n")
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line));

const ids = rows.map((row) => row.complex_id);
if (ids.length !== new Set(ids).size) throw new Error("duplicate complex_id");
for (const row of rows) {
  if (row.semantics !== "PARCEL_REPRESENTATIVE_POINT") throw new Error(`semantics ${row.complex_id}`);
  if (row.resolution_status !== "EXACT_PRIMARY_PARCEL") throw new Error(`status ${row.complex_id}`);
  if (!/^\d{19}$/.test(row.pnu) || !["1", "2"].includes(row.pnu[10])) throw new Error(`pnu ${row.complex_id}`);
  if (row.source_object_id !== row.pnu) throw new Error(`source object ${row.complex_id}`);
  const lat = Number(row.latitude_text);
  const lng = Number(row.longitude_text);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error(`coord ${row.complex_id}`);
  if (lat < 33 || lat > 39.6 || lng < 124 || lng > 132.2) throw new Error(`bounds ${row.complex_id}`);
}

const url = process.env.TURSO_DATABASE_URL?.trim();
const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
if (!url || url.startsWith("file:") || !authToken) throw new Error("refusing without remote TURSO");

const db = createClient({ url, authToken });
const schema = readFileSync(
  resolve("src/lib/db/migrations/20260920_complex_parcel_coordinates.sql"),
  "utf8",
);

function num(value) {
  return Number(value);
}

async function scalar(executor, sql, args = []) {
  const rs = await executor.execute({ sql, args });
  return num(rs.rows[0].n);
}

async function census(executor) {
  const rs = await executor.execute(
    `SELECT sido_code, COUNT(*) AS n
     FROM apt_complex_master
     WHERE latitude IS NOT NULL AND longitude IS NOT NULL
     GROUP BY sido_code
     ORDER BY sido_code`,
  );
  const out = {};
  for (const row of rs.rows) out[String(row.sido_code)] = num(row.n);
  return out;
}

const GUARD_TABLES = [
  "apt_complex_master",
  "complex_buildings",
  "complex_building_geometry",
  "complex_nearby_schools",
  "complex_region_price_position",
  "region_complex_rankings",
  "apt_complex_mgmt_fee_monthly",
  "transactions",
];

async function tableCounts(executor) {
  const out = {};
  for (const table of GUARD_TABLES) {
    out[table] = await scalar(executor, `SELECT COUNT(*) AS n FROM ${table}`);
  }
  return out;
}

async function fetchExisting(executor, chunkIds) {
  const found = new Map();
  for (let i = 0; i < chunkIds.length; i += 80) {
    const chunk = chunkIds.slice(i, i + 80);
    const ph = chunk.map(() => "?").join(",");
    const rs = await executor.execute({
      sql: `SELECT complex_id, latitude, longitude, sido_code
            FROM apt_complex_master
            WHERE complex_id IN (${ph})`,
      args: chunk,
    });
    for (const row of rs.rows) found.set(String(row.complex_id), row);
  }
  return found;
}

const beforeCounts = await tableCounts(db);
const beforeCensus = await census(db);
const existing = await fetchExisting(db, ids);
let planned = 0;
let already = 0;
const conflicts = [];
for (const row of rows) {
  const current = existing.get(row.complex_id);
  if (!current) throw new Error(`missing master ${row.complex_id}`);
  if (String(current.sido_code) !== row.sido_code) throw new Error(`sido ${row.complex_id}`);
  const hasLat = current.latitude != null;
  const hasLng = current.longitude != null;
  if (!hasLat && !hasLng) {
    planned += 1;
    continue;
  }
  if (hasLat && hasLng) {
    const same =
      Math.abs(Number(current.latitude) - Number(row.latitude_text)) < 1e-7 &&
      Math.abs(Number(current.longitude) - Number(row.longitude_text)) < 1e-7;
    if (same) {
      already += 1;
      continue;
    }
    conflicts.push(row.complex_id);
    continue;
  }
  conflicts.push(row.complex_id);
}

const plan = {
  mode: commit ? "commit" : "precheck",
  safe_rows: rows.length,
  planned_fills: planned,
  already_equal: already,
  conflicts: conflicts.length,
  conflict_ids: conflicts.slice(0, 20),
  beforeCensus,
};
process.stdout.write(`${JSON.stringify(plan)}\n`);
if (!commit) {
  db.close();
  process.exit(conflicts.length ? 2 : 0);
}
if (conflicts.length) throw new Error("COORDINATE_SOURCE_CONFLICT");

if (commit) {
  await db.executeMultiple(schema);
}

const stampRows = rows.filter((row) => {
  const current = existing.get(row.complex_id);
  return current.latitude == null && current.longitude == null;
});

let filled = 0;
let provenance = 0;
const batchSize = 100;
for (let i = 0; i < stampRows.length; i += batchSize) {
  const batch = stampRows.slice(i, i + batchSize);
  const tx = await db.transaction("write");
  try {
    const inside = await fetchExisting(
      tx,
      batch.map((row) => row.complex_id),
    );
    for (const row of batch) {
      const current = inside.get(row.complex_id);
      if (!current || current.latitude != null || current.longitude != null) {
        throw new Error(`race ${row.complex_id}`);
      }
      const updated = await tx.execute({
        sql: `UPDATE apt_complex_master
              SET latitude = ?, longitude = ?, updated_at = ?
              WHERE complex_id = ?
                AND sido_code = ?
                AND latitude IS NULL
                AND longitude IS NULL`,
        args: [row.latitude_text, row.longitude_text, row.generated_at, row.complex_id, row.sido_code],
      });
      if (num(updated.rowsAffected) !== 1) throw new Error(`fill ${row.complex_id}`);
      const inserted = await tx.execute({
        sql: `INSERT INTO complex_parcel_coordinates (
                complex_id, pnu, latitude, longitude, coordinate_semantics, resolution_status,
                coordinate_source, source_object_id, source_version, source_dataset, generated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          row.complex_id,
          row.pnu,
          row.latitude_text,
          row.longitude_text,
          row.semantics,
          row.resolution_status,
          row.coordinate_source,
          row.source_object_id,
          row.source_version,
          row.source_dataset,
          row.generated_at,
        ],
      });
      if (num(inserted.rowsAffected) !== 1) throw new Error(`provenance ${row.complex_id}`);
    }
    await tx.commit();
    filled += batch.length;
    provenance += batch.length;
  } catch (error) {
    await tx.rollback().catch(() => undefined);
    throw error;
  }
  tx.close();
  if (i > 0 && i % 1000 === 0) process.stderr.write(`[parcel] ${i}/${stampRows.length}\n`);
}

const afterCounts = await tableCounts(db);
const afterCensus = await census(db);
const unrelated = {};
for (const table of GUARD_TABLES) {
  if (table === "apt_complex_master") {
    if (afterCounts[table] !== beforeCounts[table]) throw new Error("master count changed");
    continue;
  }
  const delta = afterCounts[table] - beforeCounts[table];
  if (delta !== 0) unrelated[table] = delta;
}
const seoulDelta = (afterCensus["11"] ?? 0) - (beforeCensus["11"] ?? 0);
const daeguDelta = (afterCensus["27"] ?? 0) - (beforeCensus["27"] ?? 0);
if (seoulDelta !== stampRows.filter((row) => row.sido_code === "11").length) {
  throw new Error(`seoul census ${seoulDelta}`);
}
if (daeguDelta !== stampRows.filter((row) => row.sido_code === "27").length) {
  throw new Error(`daegu census ${daeguDelta}`);
}
db.close();
process.stdout.write(
  `${JSON.stringify({ filled, provenance, conflicts: 0, afterCensus, unrelated })}\n`,
);

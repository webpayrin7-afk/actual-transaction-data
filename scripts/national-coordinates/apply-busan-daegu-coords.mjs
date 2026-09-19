/**
 * Apply a PASS Busan/Daegu coordinate dry-run.
 *
 * Writes apt_complex_master.latitude/longitude only, and only where both are NULL.
 * One transaction per sido. Rolls that sido back when the affected count drifts.
 * Does not insert source links or enrichment domains.
 *
 * Usage: node scripts/national-coordinates/apply-busan-daegu-coords.mjs --commit
 * Without --commit, prints the fixed expected counts and writes nothing.
 */
import { createClient } from "@libsql/client";
import { readFileSync, writeFileSync } from "node:fs";

const commit = process.argv.includes("--commit");
const root = new URL("../../", import.meta.url);
const dryPath = new URL("data/poc/national-coordinates/busan-daegu-coordinate-dry-run.json", root);
const resultPath = new URL("data/poc/national-coordinates/busan-daegu-coordinate-result.json", root);
const dry = JSON.parse(readFileSync(dryPath, "utf8"));

if (dry.decision !== "PASS" || dry.semantics !== "PARCEL_REPRESENTATIVE_POINT") {
  throw new Error("dry-run is not PASS");
}
if (dry.provenance?.new_source !== false || dry.provenance?.new_enrichment_domain !== false) {
  throw new Error("refusing new provenance convention");
}
if (dry.provenance?.storage !== "apt_complex_master.latitude/longitude") {
  throw new Error("refusing unknown coordinate storage");
}

const order = ["26", "27"];
for (const code of order) {
  const region = dry.regions[code];
  if (!region || region.safe !== region.safe_rows.length) {
    throw new Error(`safe drift ${code}`);
  }
  if (region.coordinate_semantics !== "PARCEL_REPRESENTATIVE_POINT") {
    throw new Error(`semantics ${code}`);
  }
  const ids = new Set();
  for (const row of region.safe_rows) {
    if (ids.has(row.complex_id)) throw new Error(`duplicate complex_id ${code}`);
    ids.add(row.complex_id);
    if (row.sido_code !== code || row.pnu !== row.expected_pnu || row.classification !== "MATCHED_EXACT") {
      throw new Error(`row contract ${row.complex_id}`);
    }
    if (row.latitude_text == null || row.longitude_text == null) {
      throw new Error(`null text ${row.complex_id}`);
    }
  }
}

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

function num(value) {
  return Number(value);
}

async function scalar(executor, sql, args = []) {
  const rs = await executor.execute({ sql, args });
  return num(rs.rows[0].n);
}

async function rowsOf(executor, sql, args = []) {
  const rs = await executor.execute({ sql, args });
  return rs.rows;
}

async function coordCensus(executor) {
  const rows = await rowsOf(
    executor,
    `SELECT sido_code, COUNT(*) AS n
     FROM apt_complex_master
     WHERE latitude IS NOT NULL OR longitude IS NOT NULL
     GROUP BY sido_code
     ORDER BY sido_code`,
  );
  const out = {};
  for (const row of rows) out[String(row.sido_code)] = num(row.n);
  return out;
}

async function fetchExisting(executor, ids) {
  const found = new Map();
  for (let i = 0; i < ids.length; i += 80) {
    const chunk = ids.slice(i, i + 80);
    const ph = chunk.map(() => "?").join(",");
    const rows = await rowsOf(
      executor,
      `SELECT complex_id, latitude, longitude, sido_code
       FROM apt_complex_master
       WHERE complex_id IN (${ph})`,
      chunk,
    );
    for (const row of rows) found.set(String(row.complex_id), row);
  }
  return found;
}

function planRegion(region, existing) {
  const write = [];
  const skipped = [];
  const missing = [];
  for (const row of region.safe_rows) {
    const current = existing.get(row.complex_id);
    if (!current) {
      missing.push(row.complex_id);
      continue;
    }
    if (String(current.sido_code) !== region.sido_code) {
      throw new Error(`sido mismatch ${row.complex_id}`);
    }
    if (current.latitude != null || current.longitude != null) {
      skipped.push(row.complex_id);
      continue;
    }
    write.push(row);
  }
  if (missing.length) {
    throw new Error(`missing master rows ${region.sido_code} ${missing.length}`);
  }
  return { write, skipped };
}

const precheck = {};
for (const code of order) {
  const region = dry.regions[code];
  const existing = await fetchExisting(
    db,
    region.safe_rows.map((row) => row.complex_id),
  );
  precheck[code] = planRegion(region, existing);
}

const beforeCensus = await coordCensus(db);
const beforeDup = await scalar(
  db,
  "SELECT COUNT(*) AS n FROM (SELECT complex_id FROM apt_complex_master GROUP BY complex_id HAVING COUNT(*) > 1)",
);
const beforeMaster = await scalar(db, "SELECT COUNT(*) AS n FROM apt_complex_master");

const expected = Object.fromEntries(
  order.map((code) => [code, precheck[code].write.length]),
);
process.stdout.write(
  `${JSON.stringify({
    mode: commit ? "commit" : "precheck",
    expected,
    skipped: Object.fromEntries(order.map((code) => [code, precheck[code].skipped.length])),
    beforeCensus,
    beforeDup,
  })}\n`,
);

if (!commit) {
  db.close();
  process.exit(0);
}

if (beforeDup !== 0) throw new Error("duplicate complex_id before write");

const stamp = new Date().toISOString();
const written = {};

for (const code of order) {
  const region = dry.regions[code];
  const fixed = expected[code];
  const rows = precheck[code].write;
  if (rows.length !== fixed) throw new Error(`expected drift ${code}`);
  const tx = await db.transaction("write");
  try {
    const inside = await fetchExisting(
      tx,
      region.safe_rows.map((row) => row.complex_id),
    );
    const again = planRegion(region, inside);
    if (again.write.length !== fixed || again.skipped.length !== precheck[code].skipped.length) {
      throw new Error(`expected mismatch inside ${code}`);
    }
    const censusBefore = await coordCensus(tx);
    let affected = 0;
    for (const row of rows) {
      const rs = await tx.execute({
        sql: `UPDATE apt_complex_master
              SET latitude = ?, longitude = ?, updated_at = ?
              WHERE complex_id = ?
                AND sido_code = ?
                AND latitude IS NULL
                AND longitude IS NULL`,
        args: [row.latitude_text, row.longitude_text, stamp, row.complex_id, code],
      });
      affected += num(rs.rowsAffected ?? 0);
    }
    if (affected !== fixed) throw new Error(`affected ${affected} expected ${fixed} ${code}`);
    const censusAfter = await coordCensus(tx);
    for (const key of new Set([...Object.keys(censusBefore), ...Object.keys(censusAfter)])) {
      const delta = (censusAfter[key] ?? 0) - (censusBefore[key] ?? 0);
      if (key === code) {
        if (delta !== fixed) throw new Error(`census delta ${code} ${delta}`);
      } else if (delta !== 0) {
        throw new Error(`other sido changed ${key}`);
      }
    }
    const dup = await scalar(
      tx,
      "SELECT COUNT(*) AS n FROM (SELECT complex_id FROM apt_complex_master GROUP BY complex_id HAVING COUNT(*) > 1)",
    );
    if (dup !== 0) throw new Error("duplicate complex_id inside transaction");
    const master = await scalar(tx, "SELECT COUNT(*) AS n FROM apt_complex_master");
    if (master !== beforeMaster) throw new Error("master count changed");
    const nullWritten = await scalar(
      tx,
      `SELECT COUNT(*) AS n FROM apt_complex_master
       WHERE complex_id IN (${rows.map(() => "?").join(",") || "NULL"})
         AND (latitude IS NULL OR longitude IS NULL)`,
      rows.map((row) => row.complex_id),
    );
    if (rows.length && nullWritten !== 0) throw new Error("null coordinate after write");
    await tx.commit();
    written[code] = fixed;
  } catch (error) {
    await tx.rollback().catch(() => undefined);
    tx.close();
    const partial = {
      status: "ROLLBACK",
      failed_sido_code: code,
      error: String(error.message || error),
      written_before_failure: written,
      expected,
    };
    writeFileSync(resultPath, JSON.stringify(partial, null, 2) + "\n");
    throw error;
  }
  tx.close();
  process.stdout.write(`PASS ${code} ${fixed}\n`);
}

const afterCensus = await coordCensus(db);
const afterDup = await scalar(
  db,
  "SELECT COUNT(*) AS n FROM (SELECT complex_id FROM apt_complex_master GROUP BY complex_id HAVING COUNT(*) > 1)",
);
const result = {
  status: "PASS",
  stamp,
  semantics: "PARCEL_REPRESENTATIVE_POINT",
  production_write: true,
  source_link_write: false,
  enrichment_domain_write: false,
  written: {
    "26": written["26"],
    "27": written["27"],
  },
  skipped_existing: {
    "26": precheck["26"].skipped.length,
    "27": precheck["27"].skipped.length,
  },
  expected,
  duplicate_complex_id: afterDup,
  null_coordinates_in_written: 0,
  out_of_region_in_written: 0,
  other_sido_changed: Object.keys({ ...beforeCensus, ...afterCensus }).filter((key) => {
    if (key === "26" || key === "27") return false;
    return (afterCensus[key] ?? 0) !== (beforeCensus[key] ?? 0);
  }).length,
  before_census: beforeCensus,
  after_census: afterCensus,
  school_ready: {
    "26": written["26"],
    "27": written["27"],
  },
};
writeFileSync(resultPath, JSON.stringify(result, null, 2) + "\n");
process.stdout.write(`${JSON.stringify({ status: "PASS", written: result.written, skipped: result.skipped_existing })}\n`);
db.close();

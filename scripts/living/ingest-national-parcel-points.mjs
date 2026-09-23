/**
 * Classify an official AL_D002 representative-point package and fill
 * apt_complex_master coordinates only where both latitude and longitude are NULL.
 *
 * Existing positive coordinates are never overwritten.
 * Usage:
 *   node scripts/living/ingest-national-parcel-points.mjs --input=path.csv.gz
 *   node scripts/living/ingest-national-parcel-points.mjs --input=path.csv.gz --package=residual --commit
 *
 * Packages pin expected sha/row counts so prior ingest artifacts stay reproducible.
 */
import { createClient } from "@libsql/client";
import { createReadStream, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { resolve, dirname } from "node:path";

const commit = process.argv.includes("--commit");
const inputArg = process.argv.find((arg) => arg.startsWith("--input="));
if (!inputArg) throw new Error("--input= required");
const inputPath = resolve(inputArg.slice("--input=".length));
const packageArg = process.argv.find((arg) => arg.startsWith("--package="));
const packageName = packageArg ? packageArg.slice("--package=".length) : "national";
const PACKAGES = {
  national: {
    sha256: "30e622d790569a601160d143586646f0d2f98fbb6f2fe2be680df1e562ea83a7",
    rows: 17708,
    gzipBytes: 532155,
    requireJamsil: true,
    reportPrefix: "national-parcel-ingest",
  },
  residual: {
    sha256: "2246e15e37a9e2ff8827956198cd4bd9fd09aa19c533e49800e4671d0be0cb46",
    rows: 3058,
    gzipBytes: 83567,
    requireJamsil: false,
    reportPrefix: "national-parcel-residual-ingest",
  },
};
const pkg = PACKAGES[packageName];
if (!pkg) throw new Error(`unknown package ${packageName}`);
const outDir = resolve("data/poc/living");
mkdirSync(outDir, { recursive: true });

const JAMSIL = "cx_4c63d9a100973c60";
const JAMSIL_PNU = "1171010100100190000";
const SAME_POINT_M = 1;

function num(value) {
  return Number(value);
}

function haversineM(lat1, lng1, lat2, lng2) {
  const radius = 6_371_000;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dlat = ((lat2 - lat1) * Math.PI) / 180;
  const dlng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dlat / 2) ** 2 +
    Math.cos(p1) * Math.cos(p2) * Math.sin(dlng / 2) ** 2;
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(a)));
}

function splitCsv(line) {
  const out = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

async function loadRows() {
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256");
  const bytes = await new Promise((resolvePromise, reject) => {
    const chunks = [];
    const stream = createReadStream(inputPath);
    stream.on("data", (chunk) => {
      hash.update(chunk);
      chunks.push(chunk);
    });
    stream.on("error", reject);
    stream.on("end", () => resolvePromise(Buffer.concat(chunks)));
  });
  const sha256 = hash.digest("hex");
  if (sha256 !== pkg.sha256) throw new Error(`sha256 mismatch ${sha256}`);
  if (bytes.length !== pkg.gzipBytes) throw new Error(`gzip bytes ${bytes.length}`);
  const rows = [];
  const { Readable } = await import("node:stream");
  const lineReader = createInterface({ input: Readable.from(bytes).pipe(createGunzip()) });
  let header = null;
  for await (const line of lineReader) {
    if (!header) {
      header = line;
      if (header !== "complex_id,pnu,lat,lon,source_region,source_filename,source_version,source_crs,coordinate_semantics,resolution_status") {
        throw new Error(`header ${header}`);
      }
      continue;
    }
    if (!line) continue;
    const cols = splitCsv(line);
    if (cols.length !== 10) throw new Error(`columns ${cols.length}`);
    const [complex_id, pnu, lat, lon, source_region, , source_version, source_crs, semantics, resolution_status] = cols;
    rows.push({
      complex_id,
      pnu,
      latitude_text: lat,
      longitude_text: lon,
      sido_code: source_region,
      source_version,
      source_crs,
      semantics,
      resolution_status,
    });
  }
  if (rows.length !== pkg.rows) throw new Error(`rows ${rows.length}`);
  return { rows, sha256, gzipBytes: bytes.length };
}

function inputProblems(row) {
  const problems = [];
  if (!row.complex_id) problems.push("complex_id");
  if (!/^\d{19}$/.test(row.pnu) || !["1", "2"].includes(row.pnu[10])) problems.push("pnu");
  if (row.semantics !== "PARCEL_REPRESENTATIVE_POINT") problems.push("semantics");
  if (row.resolution_status !== "EXACT_PNU") problems.push("resolution");
  if (row.source_version !== "20260908") problems.push("version");
  if (row.source_crs !== "EPSG:5186") problems.push("crs");
  const lat = Number(row.latitude_text);
  const lng = Number(row.longitude_text);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) problems.push("number");
  else {
    if (lat === 0 && lng === 0) problems.push("zero");
    if (!(lat >= 33 && lat <= 39.6 && lng >= 124 && lng <= 132.2)) problems.push("bbox");
    if (lat >= 124 && lat <= 132.2 && lng >= 33 && lng <= 39.6) problems.push("inverted");
  }
  return problems;
}

const url = process.env.TURSO_DATABASE_URL?.trim();
const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
if (!url || url.startsWith("file:") || !authToken) throw new Error("refusing without remote TURSO");
const db = createClient({ url, authToken });

async function scalar(sql, args = []) {
  const rs = await db.execute({ sql, args });
  return num(rs.rows[0].n);
}

async function fetchMaster(ids) {
  const found = new Map();
  for (let i = 0; i < ids.length; i += 80) {
    const chunk = ids.slice(i, i + 80);
    const ph = chunk.map(() => "?").join(",");
    const rs = await db.execute({
      sql: `SELECT m.complex_id, m.latitude, m.longitude, m.sido_code, m.sido, m.apt_name, p.pnu AS stored_pnu
            FROM apt_complex_master m
            LEFT JOIN complex_parcel_coordinates p ON p.complex_id = m.complex_id
            WHERE m.complex_id IN (${ph})`,
      args: chunk,
    });
    for (const row of rs.rows) found.set(String(row.complex_id), row);
  }
  return found;
}

function classify(row, current) {
  const problems = inputProblems(row);
  if (problems.length) return { klass: "INVALID_INPUT", problems };
  if (!current) return { klass: "COMPLEX_NOT_FOUND" };
  if (String(current.sido_code) !== row.sido_code) return { klass: "INVALID_INPUT", problems: ["sido"] };
  const hasLat = current.latitude != null && current.latitude !== "";
  const hasLng = current.longitude != null && current.longitude !== "";
  if (!hasLat && !hasLng) return { klass: "NULL_SAFE_FILL" };
  if (hasLat !== hasLng) return { klass: "EXISTING_DIFFERENT_PNU_CONFLICT", problems: ["partial_coordinate"] };
  const storedPnu = current.stored_pnu == null ? null : String(current.stored_pnu);
  const deltaM = haversineM(
    Number(current.latitude),
    Number(current.longitude),
    Number(row.latitude_text),
    Number(row.longitude_text),
  );
  const samePoint = deltaM <= SAME_POINT_M;
  if (storedPnu && storedPnu !== row.pnu) {
    return { klass: "EXISTING_DIFFERENT_PNU_CONFLICT", deltaM, storedPnu };
  }
  if (storedPnu === row.pnu || storedPnu == null) {
    if (samePoint) return { klass: "EXISTING_SAME_PNU_SAME_POINT", deltaM, storedPnu };
    if (storedPnu === row.pnu) return { klass: "EXISTING_SAME_PNU_POINT_DIFFERENCE", deltaM, storedPnu };
    return { klass: "EXISTING_SAME_PNU_POINT_DIFFERENCE", deltaM, storedPnu: null, problems: ["no_stored_pnu"] };
  }
  return { klass: "EXISTING_DIFFERENT_PNU_CONFLICT", deltaM, storedPnu };
}

const started = Date.now();
const { rows, sha256, gzipBytes } = await loadRows();
const ids = rows.map((row) => row.complex_id);
if (ids.length !== new Set(ids).size) throw new Error("duplicate complex_id");
const master = await fetchMaster(ids);
const classified = rows.map((row) => {
  const result = classify(row, master.get(row.complex_id));
  return { ...row, ...result, apt_name: master.get(row.complex_id)?.apt_name ?? null, sido: master.get(row.complex_id)?.sido ?? null };
});
const counts = {};
for (const row of classified) counts[row.klass] = (counts[row.klass] ?? 0) + 1;
const jamsil = classified.find((row) => row.complex_id === JAMSIL);
if (pkg.requireJamsil) {
  if (!jamsil || jamsil.pnu !== JAMSIL_PNU || jamsil.klass !== "EXISTING_SAME_PNU_SAME_POINT") {
    throw new Error(`jamsil classification ${JSON.stringify(jamsil && { klass: jamsil.klass, pnu: jamsil.pnu, lat: jamsil.latitude_text })}`);
  }
}

const masterCensus = await db.execute(
  `SELECT sido_code, sido,
          COUNT(*) AS n,
          SUM(CASE WHEN latitude IS NOT NULL AND longitude IS NOT NULL THEN 1 ELSE 0 END) AS ready
   FROM apt_complex_master
   GROUP BY sido_code, sido
   ORDER BY sido_code`,
);
const beforeReady = masterCensus.rows.reduce((sum, row) => sum + num(row.ready), 0);
const fills = classified.filter((row) => row.klass === "NULL_SAFE_FILL");
const bySidoFill = {};
for (const row of fills) bySidoFill[row.sido_code] = (bySidoFill[row.sido_code] ?? 0) + 1;

const regionRows = masterCensus.rows.map((row) => {
  const code = String(row.sido_code);
  const ready = num(row.ready);
  const filled = bySidoFill[code] ?? 0;
  const masterN = num(row.n);
  const resulting = ready + filled;
  return {
    sido_code: code,
    sido: String(row.sido),
    master: masterN,
    ready_before: ready,
    newly_filled: filled,
    resulting_ready: resulting,
    coverage_pct: Number(((resulting / masterN) * 100).toFixed(2)),
  };
});

const plan = {
  mode: commit ? "commit" : "dry-run",
  package: packageName,
  sha256,
  gzipBytes,
  incoming: rows.length,
  counts,
  beforeReady,
  expectedReady: beforeReady + fills.length,
  expectedCoverage: Number((((beforeReady + fills.length) / 27524) * 100).toFixed(2)),
  regions: regionRows,
  jamsil: jamsil
    ? { klass: jamsil.klass, pnu: jamsil.pnu, lat: jamsil.latitude_text, lon: jamsil.longitude_text, deltaM: jamsil.deltaM }
    : null,
  pointDifferenceSamples: classified
    .filter((row) => row.klass === "EXISTING_SAME_PNU_POINT_DIFFERENCE")
    .slice(0, 10)
    .map((row) => ({ complex_id: row.complex_id, deltaM: Number(row.deltaM.toFixed(2)), pnu: row.pnu, storedPnu: row.storedPnu })),
  conflictSamples: classified
    .filter((row) => row.klass === "EXISTING_DIFFERENT_PNU_CONFLICT")
    .slice(0, 10)
    .map((row) => ({ complex_id: row.complex_id, pnu: row.pnu, storedPnu: row.storedPnu })),
  validationSeconds: Number(((Date.now() - started) / 1000).toFixed(3)),
};
writeFileSync(resolve(outDir, `${pkg.reportPrefix}-plan.json`), JSON.stringify(plan, null, 2) + "\n");
process.stdout.write(`${JSON.stringify(plan)}\n`);

if (!commit) {
  db.close();
  process.exit(0);
}
if ((counts.INVALID_INPUT ?? 0) > 0) throw new Error("invalid input");

const schema = readFileSync(resolve("src/lib/db/migrations/20260920_complex_parcel_coordinates.sql"), "utf8");
await db.executeMultiple(schema);
const generatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const guardTables = [
  "apt_complex_master",
  "complex_buildings",
  "complex_building_geometry",
  "complex_nearby_schools",
  "complex_region_price_position",
  "region_complex_rankings",
  "apt_complex_mgmt_fee_monthly",
  "transactions",
  "complex_living_snapshots",
];
const beforeCounts = {};
for (const table of guardTables) beforeCounts[table] = await scalar(`SELECT COUNT(*) AS n FROM ${table}`);

let filled = 0;
const batchSize = 40;
const applyStarted = Date.now();
for (let i = 0; i < fills.length; i += batchSize) {
  const batch = fills.slice(i, i + batchSize);
  const inside = await fetchMaster(batch.map((row) => row.complex_id));
  const statements = [];
  for (const row of batch) {
    const current = inside.get(row.complex_id);
    if (!current || current.latitude != null || current.longitude != null) throw new Error(`race ${row.complex_id}`);
    if (String(current.sido_code) !== row.sido_code) throw new Error(`sido ${row.complex_id}`);
    statements.push({
      sql: `UPDATE apt_complex_master
            SET latitude = ?, longitude = ?, updated_at = ?
            WHERE complex_id = ? AND sido_code = ? AND latitude IS NULL AND longitude IS NULL`,
      args: [row.latitude_text, row.longitude_text, generatedAt, row.complex_id, row.sido_code],
    });
    statements.push({
      sql: `INSERT INTO complex_parcel_coordinates (
              complex_id, pnu, latitude, longitude, coordinate_semantics, resolution_status,
              coordinate_source, source_object_id, source_version, source_dataset, generated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        row.complex_id,
        row.pnu,
        row.latitude_text,
        row.longitude_text,
        "PARCEL_REPRESENTATIVE_POINT",
        "EXACT_PNU",
        "국토교통부 일별연속지적도형정보 AL_D002",
        row.pnu,
        "20260908",
        "국토교통부 일별연속지적도형정보",
        generatedAt,
      ],
    });
  }
  const rs = await db.batch(statements, "write");
  for (const result of rs) {
    if (num(result.rowsAffected) !== 1) throw new Error("batch row was not applied");
  }
  filled += batch.length;
  if ((i + batch.length) % 1000 < batchSize) process.stderr.write(`[ingest] ${i + batch.length}/${fills.length}\n`);
}

const afterCounts = {};
for (const table of guardTables) afterCounts[table] = await scalar(`SELECT COUNT(*) AS n FROM ${table}`);
if (afterCounts.apt_complex_master !== beforeCounts.apt_complex_master) throw new Error("master count changed");
const unrelated = {};
for (const table of guardTables) {
  if (table === "apt_complex_master") continue;
  const delta = afterCounts[table] - beforeCounts[table];
  if (delta !== 0) unrelated[table] = delta;
}
const afterReady = await scalar(
  "SELECT COUNT(*) AS n FROM apt_complex_master WHERE latitude IS NOT NULL AND longitude IS NOT NULL",
);
if (afterReady !== beforeReady + filled) throw new Error(`ready ${afterReady} expected ${beforeReady + filled}`);

if (fills.length > 0) {
  const schoolIds = fills.map((row) => row.complex_id);
  const schoolPath = resolve(outDir, "school-delta-newly-coordinate-ready.json");
  writeFileSync(
    schoolPath,
    JSON.stringify({ purpose: "SCHOOL_NEARBY_DELTA_ONLY", count: schoolIds.length, complex_ids: schoolIds }, null, 2) + "\n",
  );
  const materializePath = resolve("data/cache/living/national-new-complexes.jsonl");
  mkdirSync(dirname(materializePath), { recursive: true });
  writeFileSync(
    materializePath,
    fills
      .map((row) =>
        JSON.stringify({
          complex_id: row.complex_id,
          apt_name: row.apt_name,
          sido: row.sido,
          sido_code: row.sido_code,
          latitude: row.latitude_text,
          longitude: row.longitude_text,
        }),
      )
      .join("\n") + "\n",
  );
}
const result = {
  filled,
  updates: 0,
  held: (counts.EXISTING_SAME_PNU_POINT_DIFFERENCE ?? 0) + (counts.EXISTING_DIFFERENT_PNU_CONFLICT ?? 0) + (counts.COMPLEX_NOT_FOUND ?? 0) + (counts.INVALID_INPUT ?? 0),
  resultingReady: afterReady,
  unrelated,
  applySeconds: Number(((Date.now() - applyStarted) / 1000).toFixed(3)),
  schoolArtifact: "data/poc/living/school-delta-newly-coordinate-ready.json",
  schoolCount: fills.length,
};
writeFileSync(resolve(outDir, `${pkg.reportPrefix}-result.json`), JSON.stringify(result, null, 2) + "\n");
process.stdout.write(`${JSON.stringify(result)}\n`);
db.close();

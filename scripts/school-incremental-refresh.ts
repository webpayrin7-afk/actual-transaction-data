/**
 * Incremental school refresh, identity/coordinate audit, and nearby delta.
 *
 * Does not rerun the national SchoolInfo backfill.
 * Does not write complex coordinates.
 *
 *   npx tsx scripts/school-incremental-refresh.ts --write
 *   npx tsx scripts/school-incremental-refresh.ts --write --skip-nearby
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "dotenv";
import { createClient, type Client, type InStatement } from "@libsql/client";
import { ASSIGNMENT_PRODUCTION_WRITES, ASSIGNMENT_SOURCE_AUDIT } from "../src/lib/school-national/assignment-audit";
import {
  BASELINE_LOADED_YEAR,
  EXCLUDED_IDENTITY_INCOMPLETE,
  REGION_ALIAS_SGG,
  SCHOOL_CATEGORIES,
  classifyHoldScope,
  discoveryScopeKey,
  shouldRefetchScope,
} from "../src/lib/school-national/incremental";
import {
  buildSchoolGrid,
  isSafeParcelPoint,
  linksWithinRadius,
  nearbyDeltaAction,
  parcelCoordVersion,
  schoolsNearCell,
  type NearbySchoolPoint,
} from "../src/lib/school-national/nearby-delta";
import { isDatasetAbsent } from "../src/lib/school-national/parse";
import { readNearbySchools, readSchoolDetail } from "../src/lib/school-national/read";

config({ path: ".env.local" });

const WRITE_TABLES = [
  "school_master",
  "school_snapshot_current",
  "school_category_year",
  "school_identity_hold_audit",
  "school_identity_exclusions",
  "school_fetch_checkpoint",
  "complex_nearby_schools",
  "complex_nearby_materialization",
  "school_detail_snapshots",
];

const stats = {
  masterIdentityWrites: 0,
  coordStatusFills: 0,
  snapshotInserts: 0,
  pointerWrites: 0,
  auditWrites: 0,
  exclusionWrites: 0,
  nearbyInserts: 0,
  nearbyDeletes: 0,
  materializationInserts: 0,
  materializationUpdates: 0,
  reusedComplexes: 0,
  newlyMaterialized: 0,
  rebuiltComplexes: 0,
  discoveryCalls: 0,
};

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function nowIso(): string {
  return new Date().toISOString();
}

function assertSchoolWrite(sql: string): void {
  const compact = sql.replace(/\s+/g, " ").trim().toLowerCase();
  const ok =
    compact.startsWith("insert") ||
    compact.startsWith("update") ||
    compact.startsWith("create") ||
    compact.startsWith("alter table school_master") ||
    compact.startsWith("delete from complex_nearby_schools where complex_id");
  if (!ok) throw new Error(`refusing SQL: ${compact.slice(0, 120)}`);
  if (!WRITE_TABLES.some((table) => compact.includes(table))) {
    throw new Error("refusing write outside school tables");
  }
  const banned = ["transactions", "apt_", "ranking", "mgmt_fee", "complex_building", "market_"];
  for (const token of banned) {
    if (compact.includes(token)) throw new Error(`refusing unrelated write (${token})`);
  }
}

function dbClient(): Client {
  const url = process.env.TURSO_DATABASE_URL?.trim();
  const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
  if (!url || !authToken) throw new Error("TURSO_DATABASE_URL / TURSO_AUTH_TOKEN missing");
  return createClient({ url, authToken });
}

async function applyIncrementalSchema(db: Client): Promise<void> {
  const sqlPath = path.join(process.cwd(), "src/lib/db/migrations/20260920_school_incremental_v1.sql");
  const sql = readFileSync(sqlPath, "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  for (const statement of sql.split(";").map((part) => part.trim()).filter(Boolean)) {
    assertSchoolWrite(statement);
    try {
      await db.execute(statement);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.toLowerCase().includes("duplicate column")) throw error;
    }
  }
}

async function seedCategoryYears(db: Client, at: string): Promise<void> {
  for (const category of SCHOOL_CATEGORIES) {
    await db.execute({
      sql: `INSERT INTO school_category_year (category, loaded_year, candidate_year, candidate_status, probed_scope, updated_at)
            VALUES (?, ?, NULL, NULL, 'baseline-v1', ?)
            ON CONFLICT(category) DO NOTHING`,
      args: [category, BASELINE_LOADED_YEAR[category], at],
    });
  }
}

function execWrite(db: Client, sql: string, args: Array<string | number | null> = []) {
  assertSchoolWrite(sql);
  return db.execute({ sql, args });
}

async function fillCoordinateStatus(db: Client): Promise<void> {
  const result = await execWrite(db, `
    UPDATE school_master
    SET coord_status = CASE
          WHEN lat IS NOT NULL AND lng IS NOT NULL THEN 'OFFICIAL_SCHOOLINFO'
          ELSE 'SCHOOL_COORDINATE_MISSING'
        END,
        coord_source = 'schoolinfo',
        coord_source_version = source_as_of
    WHERE coord_status IS NULL
  `);
  stats.coordStatusFills += Number(result.rowsAffected ?? 0);
}

async function refreshCurrentPointers(db: Client, at: string): Promise<void> {
  const result = await execWrite(db, `INSERT INTO school_snapshot_current (
            school_code, category, disclosure_year, source, snapshot_status, resolved_at
          )
          SELECT school_code, category, disclosure_year, source, status, ?
          FROM (
            SELECT school_code, category, disclosure_year, source, status,
              ROW_NUMBER() OVER (
                PARTITION BY school_code, category
                ORDER BY CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END, disclosure_year DESC, source
              ) AS rn
            FROM school_detail_snapshots
          )
          WHERE rn = 1
          ON CONFLICT(school_code, category) DO UPDATE SET
            disclosure_year = excluded.disclosure_year,
            source = excluded.source,
            snapshot_status = excluded.snapshot_status,
            resolved_at = excluded.resolved_at
          WHERE school_snapshot_current.disclosure_year <> excluded.disclosure_year
             OR school_snapshot_current.source <> excluded.source
             OR school_snapshot_current.snapshot_status <> excluded.snapshot_status`,
    [at],
  );
  stats.pointerWrites += Number(result.rowsAffected ?? 0);
}

async function auditIdentityHolds(db: Client, at: string): Promise<Array<Record<string, unknown>>> {
  const placeholders = REGION_ALIAS_SGG.map(() => "?").join(",");
  const feed = await db.execute({
    sql: `SELECT substr(scope_key, 6, 5) AS sgg, SUM(row_count) AS rows
          FROM school_fetch_checkpoint
          WHERE category = 'BASIC' AND disclosure_year = '2026' AND status = 'complete'
            AND substr(scope_key, 6, 5) IN (${placeholders})
          GROUP BY 1`,
    args: [...REGION_ALIAS_SGG],
  });
  const stored = await db.execute({
    sql: `SELECT sgg_code AS sgg, COUNT(*) AS n
          FROM school_master
          WHERE sgg_code IN (${placeholders})
          GROUP BY 1`,
    args: [...REGION_ALIAS_SGG],
  });
  const storedCount = new Map(stored.rows.map((row) => [String(row.sgg), Number(row.n)]));
  const rows: Array<Record<string, unknown>> = [];
  for (const row of feed.rows) {
    const sgg = String(row.sgg);
    const feedRows = Number(row.rows ?? 0);
    const alreadyStored = storedCount.get(sgg) ?? 0;
    const holds = feedRows - alreadyStored;
    const classification = classifyHoldScope(sgg, holds);
    if (holds <= 0) continue;
    const detail = sgg.startsWith("12")
      ? "2026 BASIC rows from 전남광주통합특별시 (prefix 12) matched an existing school_code/year stored under 광주 or 전남. Same code, different region fingerprint. Not merged and not overwritten."
      : "2026 BASIC rows from a reorganized Incheon district matched an existing school_code/year stored under the previous district code. Same code, different region fingerprint. Not merged and not overwritten.";
    rows.push({ sgg, feedRows, alreadyStored, holds, classification, detail });
    const result = await execWrite(db, `INSERT INTO school_identity_hold_audit (
              scope_key, school_code, disclosure_year, classification, hold_count, detail, audited_at
            ) VALUES (?, '*', '2026', ?, ?, ?, ?)
            ON CONFLICT(scope_key, school_code, classification) DO UPDATE SET
              hold_count = excluded.hold_count,
              detail = excluded.detail,
              audited_at = excluded.audited_at
            WHERE school_identity_hold_audit.hold_count <> excluded.hold_count
               OR school_identity_hold_audit.detail <> excluded.detail`,
      [`2026|${sgg}|*|BASIC`, classification, holds, detail, at],
    );
    stats.auditWrites += Number(result.rowsAffected ?? 0);
  }
  return rows;
}

async function auditExclusions(db: Client, at: string): Promise<number> {
  let recovered = 0;
  for (const exclusion of EXCLUDED_IDENTITY_INCOMPLETE) {
    const master = await db.execute({
      sql: "SELECT school_code FROM school_master WHERE school_code = ?",
      args: [exclusion.schoolCode],
    });
    if (master.rows.length > 0) {
      recovered += 1;
      continue;
    }
    const result = await execWrite(db, `INSERT INTO school_identity_exclusions (school_code, school_name, reason, detail, audited_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(school_code) DO UPDATE SET
              school_name = excluded.school_name,
              reason = excluded.reason,
              detail = excluded.detail,
              audited_at = excluded.audited_at
            WHERE school_identity_exclusions.detail <> excluded.detail
               OR school_identity_exclusions.reason <> excluded.reason`,
      [exclusion.schoolCode, exclusion.schoolName, exclusion.reason, exclusion.detail, at],
    );
    stats.exclusionWrites += Number(result.rowsAffected ?? 0);
  }
  return recovered;
}

async function checkpointStatus(db: Client, key: string): Promise<string | null> {
  const res = await db.execute({
    sql: "SELECT status FROM school_fetch_checkpoint WHERE scope_key = ?",
    args: [key],
  });
  return res.rows[0] ? String(res.rows[0].status) : null;
}

async function discoverLatestYears(db: Client, at: string): Promise<Record<string, unknown>> {
  const probes: Array<{ category: "BASIC" | "GRADUATE_PATH"; year: string; sgg: string; kind: string; url: string }> = [];
  const key = process.env.SCHOOLINFO_API_KEY?.trim();
  if (!key) throw new Error("SCHOOLINFO_API_KEY missing");
  const basic = new URL("https://www.schoolinfo.go.kr/openApi.do");
  basic.searchParams.set("apiKey", key);
  basic.searchParams.set("apiType", "0");
  basic.searchParams.set("schulKndCode", "03");
  basic.searchParams.set("sidoCode", "11");
  basic.searchParams.set("sggCode", "11710");
  basic.searchParams.set("pbanYr", "2027");
  probes.push({
    category: "BASIC",
    year: "2027",
    sgg: "11710",
    kind: "03",
    url: basic.toString(),
  });
  for (const kind of ["03", "04"]) {
    const graduate = new URL("https://www.schoolinfo.go.kr/openData.do");
    graduate.searchParams.set("openDataType", "json");
    graduate.searchParams.set("apiType", "52");
    graduate.searchParams.set("pbanYr", "2026");
    graduate.searchParams.set("schulKndCode", kind);
    graduate.searchParams.set("sidoCode", "11");
    probes.push({ category: "GRADUATE_PATH", year: "2026", sgg: "*", kind, url: graduate.toString() });
  }

  const found: Record<string, unknown> = {};
  for (const probe of probes) {
    const scope = discoveryScopeKey(probe.category, probe.year, probe.sgg, probe.kind);
    const prior = await checkpointStatus(db, scope);
    if (!shouldRefetchScope(prior, true)) {
      found[scope] = { reused: true, status: prior };
      continue;
    }
    stats.discoveryCalls += 1;
    try {
      const res = await fetch(probe.url, {
        headers: { Accept: "application/json", "User-Agent": "ziplab-school-detail/1.0" },
        signal: AbortSignal.timeout(90_000),
      });
      const body = (await res.json()) as { resultCode?: string; resultMsg?: string; list?: unknown[] };
      const list = Array.isArray(body.list) ? body.list : [];
      const absent = isDatasetAbsent(body.resultCode ?? null, body.resultMsg ?? null);
      const status = !absent && list.length > 0 ? "available" : "empty";
      await execWrite(
        db,
        `INSERT INTO school_fetch_checkpoint (
              scope_key, status, disclosure_year, category, http_status, result_code, row_count,
              attempts, retries, rate_limits, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 0, ?)
            ON CONFLICT(scope_key) DO UPDATE SET
              status = excluded.status,
              row_count = excluded.row_count,
              http_status = excluded.http_status,
              result_code = excluded.result_code,
              updated_at = excluded.updated_at
            WHERE school_fetch_checkpoint.status <> excluded.status
               OR IFNULL(school_fetch_checkpoint.row_count, -1) <> IFNULL(excluded.row_count, -1)`,
        [scope, status, probe.year, probe.category, res.status, body.resultCode ?? null, list.length, at],
      );
      if (status === "available") {
        await execWrite(
          db,
          `UPDATE school_category_year
              SET candidate_year = ?, candidate_status = 'available', probed_scope = ?, updated_at = ?
              WHERE category = ?
                AND (candidate_year IS NULL OR candidate_year <> ? OR candidate_status IS NULL OR candidate_status <> 'available')`,
          [probe.year, scope, at, probe.category, probe.year],
        );
      }
      found[scope] = { status, rows: list.length, http: res.status };
    } catch {
      await execWrite(
        db,
        `INSERT INTO school_fetch_checkpoint (
              scope_key, status, disclosure_year, category, http_status, result_code, row_count,
              attempts, retries, rate_limits, updated_at
            ) VALUES (?, 'failed', ?, ?, NULL, NULL, NULL, 1, 0, 0, ?)
            ON CONFLICT(scope_key) DO NOTHING`,
        [scope, probe.year, probe.category, at],
      );
      found[scope] = { status: "failed" };
    }
  }
  return found;
}

async function materializeNearbyDelta(db: Client, at: string): Promise<void> {
  const schools = await db.execute(`
    SELECT school_code, school_level, lat, lng, source_as_of
    FROM school_master
    WHERE status = 'operating' AND lat IS NOT NULL AND lng IS NOT NULL
  `);
  const points: NearbySchoolPoint[] = schools.rows.map((row) => ({
    code: String(row.school_code),
    level: String(row.school_level),
    lat: Number(row.lat),
    lng: Number(row.lng),
    sourceAsOf: String(row.source_as_of),
  }));
  const grid = buildSchoolGrid(points);
  const complexes = await db.execute(`
    SELECT complex_id, latitude, longitude, identity_status, updated_at
    FROM apt_complex_master
    WHERE latitude IS NOT NULL AND longitude IS NOT NULL
  `);
  const existingLinks = await db.execute(`
    SELECT complex_id, COUNT(*) AS n FROM complex_nearby_schools GROUP BY complex_id
  `);
  const linkCount = new Map(existingLinks.rows.map((row) => [String(row.complex_id), Number(row.n)]));
  const stored = await db.execute(`
    SELECT complex_id, coord_version, status FROM complex_nearby_materialization
  `);
  const storedVersion = new Map(stored.rows.map((row) => [String(row.complex_id), {
    version: String(row.coord_version),
    status: String(row.status),
  }]));

  const rows = complexes.rows;
  for (let offset = 0; offset < rows.length; offset += 8) {
    await Promise.all(rows.slice(offset, offset + 8).map(async (complex) => {
    const complexId = String(complex.complex_id);
    const lat = Number(complex.latitude);
    const lng = Number(complex.longitude);
    const identity = complex.identity_status == null ? null : String(complex.identity_status);
    const safe = isSafeParcelPoint(lat, lng, identity);
    const version = safe ? parcelCoordVersion(lat, lng) : null;
    const prior = storedVersion.get(complexId) ?? null;
    let action = nearbyDeltaAction({
      safe,
      coordVersion: version,
      storedVersion: prior?.version ?? null,
      storedStatus: prior?.status ?? null,
    });
    const updatedAt = String(complex.updated_at ?? "");
    const baselineCohort = updatedAt < "2026-09-20T00:00:00Z" && (linkCount.get(complexId) ?? 0) > 0;
    if (action === "materialize" && baselineCohort && prior == null) action = "reuse";
    if (!safe || !version) return;
    if (action === "reuse" && prior?.version === version && prior.status !== "BUILDING") {
      stats.reusedComplexes += 1;
      return;
    }
    if (action === "reuse" && prior == null) {
      const count = linkCount.get(complexId) ?? 0;
      const result = await db.execute({
        sql: `INSERT INTO complex_nearby_materialization (
                complex_id, coord_version, latitude, longitude, link_count, status, materialized_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(complex_id) DO NOTHING`,
        args: [complexId, version, lat, lng, count, count > 0 ? "READY" : "NO_SCHOOLS_WITHIN_RADIUS", at],
      });
      stats.materializationInserts += Number(result.rowsAffected ?? 0);
      stats.reusedComplexes += 1;
      return;
    }

    const links = linksWithinRadius({ lat, lng }, schoolsNearCell(grid, lat, lng));
    const status = links.length > 0 ? "READY" : "NO_SCHOOLS_WITHIN_RADIUS";
    const statements: InStatement[] = [];
    if (action === "rebuild" || prior?.status === "BUILDING") {
      statements.push({
        sql: "DELETE FROM complex_nearby_schools WHERE complex_id = ?",
        args: [complexId],
      });
    }
    for (const link of links) {
      statements.push({
        sql: `INSERT INTO complex_nearby_schools (
                complex_id, school_code, distance_m, school_level, rank_by_distance,
                source_as_of, distance_basis, classification
              ) VALUES (?, ?, ?, ?, ?, ?, 'PARCEL_REPRESENTATIVE_POINT', 'NEARBY_SCHOOL')
              ON CONFLICT(complex_id, school_code) DO NOTHING`,
        args: [complexId, link.code, link.distanceM, link.level, link.rank, link.sourceAsOf],
      });
    }
    statements.push({
      sql: `INSERT INTO complex_nearby_materialization (
              complex_id, coord_version, latitude, longitude, link_count, status, materialized_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(complex_id) DO UPDATE SET
              coord_version = excluded.coord_version,
              latitude = excluded.latitude,
              longitude = excluded.longitude,
              link_count = excluded.link_count,
              status = excluded.status,
              materialized_at = excluded.materialized_at
            WHERE complex_nearby_materialization.coord_version <> excluded.coord_version
               OR complex_nearby_materialization.status <> excluded.status
               OR complex_nearby_materialization.link_count <> excluded.link_count`,
      args: [complexId, version, lat, lng, links.length, status, at],
    });
    for (const statement of statements) assertSchoolWrite(statement.sql);
    const results = await db.batch(statements, "write");
    results.forEach((result, index) => {
      const sql = statements[index]!.sql;
      const affected = Number(result.rowsAffected ?? 0);
      if (sql.startsWith("DELETE")) stats.nearbyDeletes += affected;
      else if (sql.includes("INSERT INTO complex_nearby_schools")) stats.nearbyInserts += affected;
      else if (sql.includes("INSERT INTO complex_nearby_materialization")) {
        if (prior) stats.materializationUpdates += affected;
        else stats.materializationInserts += affected;
      }
    });
    if (action === "rebuild") stats.rebuiltComplexes += 1;
    else stats.newlyMaterialized += 1;
    }));
    if (offset % 400 === 0) {
      console.log(`nearby progress=${offset} new=${stats.newlyMaterialized} inserts=${stats.nearbyInserts} reused=${stats.reusedComplexes}`);
    }
  }
}

async function measureReads(db: Client): Promise<Record<string, unknown>> {
  const gyeonggi = await db.execute(`
    SELECT complex_id FROM apt_complex_master
    WHERE sido LIKE '경기%' AND (latitude IS NULL OR longitude IS NULL)
    LIMIT 1
  `);
  const seoul = await db.execute(`
    SELECT m.complex_id
    FROM complex_nearby_materialization m
    JOIN apt_complex_master c ON c.complex_id = m.complex_id
    WHERE c.sido LIKE '서울%' AND m.status = 'READY'
    LIMIT 1
  `);
  async function time<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
    const started = performance.now();
    const value = await fn();
    return { ms: Math.round(performance.now() - started), value };
  }
  const detail = await time(() => readSchoolDetail(db, "S010000888"));
  const nearbyReady = seoul.rows[0]
    ? await time(() => readNearbySchools(db, String(seoul.rows[0]!.complex_id)))
    : null;
  const nearbyMissing = gyeonggi.rows[0]
    ? await time(() => readNearbySchools(db, String(gyeonggi.rows[0]!.complex_id)))
    : null;
  return {
    school_detail_ms: detail.ms,
    school_detail_live_calls: detail.value.liveSourceCalls,
    school_detail_categories: Object.fromEntries(
      Object.entries(detail.value.categories).map(([key, value]) => [key, value.status]),
    ),
    nearby_ready_ms: nearbyReady?.ms ?? null,
    nearby_ready_state: nearbyReady?.value.state ?? null,
    nearby_ready_live_calls: nearbyReady?.value.liveSourceCalls ?? 0,
    nearby_no_coordinate_ms: nearbyMissing?.ms ?? null,
    nearby_no_coordinate_state: nearbyMissing?.value.state ?? null,
    nearby_no_coordinate_schools: nearbyMissing?.value.schools ?? null,
  };
}

async function coverage(db: Client): Promise<Record<string, unknown>> {
  const master = await db.execute(`
    SELECT COUNT(*) AS schools,
      SUM(CASE WHEN lat IS NOT NULL AND lng IS NOT NULL THEN 1 ELSE 0 END) AS with_coord,
      SUM(CASE WHEN coord_status = 'SCHOOL_COORDINATE_MISSING' THEN 1 ELSE 0 END) AS missing_status
    FROM school_master
  `);
  const pointers = await db.execute("SELECT COUNT(*) AS n FROM school_snapshot_current");
  const holds = await db.execute(`
    SELECT classification, SUM(hold_count) AS n
    FROM school_identity_hold_audit GROUP BY classification
  `);
  const exclusions = await db.execute("SELECT COUNT(*) AS n FROM school_identity_exclusions");
  const nearby = await db.execute(`
    SELECT
      CASE WHEN c.sido LIKE '서울%' THEN 'seoul' WHEN c.sido LIKE '경기%' THEN 'gyeonggi' ELSE 'other' END AS region,
      COUNT(DISTINCT m.complex_id) AS materialized,
      SUM(CASE WHEN m.link_count > 0 THEN 1 ELSE 0 END) AS with_links
    FROM complex_nearby_materialization m
    JOIN apt_complex_master c ON c.complex_id = m.complex_id
    GROUP BY 1
  `);
  const noCoord = await db.execute(`
    SELECT
      CASE WHEN sido LIKE '서울%' THEN 'seoul' WHEN sido LIKE '경기%' THEN 'gyeonggi' ELSE 'other' END AS region,
      SUM(CASE WHEN latitude IS NULL OR longitude IS NULL THEN 1 ELSE 0 END) AS no_coordinate,
      COUNT(*) AS complexes
    FROM apt_complex_master
    GROUP BY 1
  `);
  const dupNearby = await db.execute(`
    SELECT COUNT(*) AS n FROM (
      SELECT complex_id, school_code, COUNT(*) c FROM complex_nearby_schools GROUP BY 1, 2 HAVING c > 1
    )
  `);
  const dupSnapshots = await db.execute(`
    SELECT COUNT(*) AS n FROM (
      SELECT school_code, category, disclosure_year, source, COUNT(*) c
      FROM school_detail_snapshots GROUP BY 1, 2, 3, 4 HAVING c > 1
    )
  `);
  const dupMaster = await db.execute(`
    SELECT COUNT(*) AS n FROM (
      SELECT school_code, COUNT(*) c FROM school_master GROUP BY 1 HAVING c > 1
    )
  `);
  return {
    master: master.rows[0],
    pointers: Number(pointers.rows[0]?.n ?? 0),
    holds: holds.rows,
    exclusions: Number(exclusions.rows[0]?.n ?? 0),
    nearby: nearby.rows,
    complexes: noCoord.rows,
    duplicate_master: Number(dupMaster.rows[0]?.n ?? 0),
    duplicate_snapshots: Number(dupSnapshots.rows[0]?.n ?? 0),
    duplicate_nearby: Number(dupNearby.rows[0]?.n ?? 0),
  };
}

async function main(): Promise<void> {
  if (!hasFlag("write")) {
    console.log(JSON.stringify({ write: false, note: "pass --write to apply incremental school metadata" }));
    return;
  }
  const db = dbClient();
  const at = nowIso();
  await applyIncrementalSchema(db);
  await seedCategoryYears(db, at);
  await fillCoordinateStatus(db);
  await refreshCurrentPointers(db, at);
  const holds = await auditIdentityHolds(db, at);
  const recovered = await auditExclusions(db, at);
  const discovery = await discoverLatestYears(db, at);
  if (!hasFlag("skip-nearby")) await materializeNearbyDelta(db, at);
  const reads = await measureReads(db);
  const report = {
    generated_at: at,
    assignment: ASSIGNMENT_SOURCE_AUDIT,
    assignment_production_writes: ASSIGNMENT_PRODUCTION_WRITES,
    holds,
    recovered_exclusions: recovered,
    discovery,
    reads,
    coverage: await coverage(db),
    run_stats: stats,
  };
  const outDir = path.join(process.cwd(), "data/poc/school-national");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "incremental-audit.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    holds: holds.reduce((sum, row) => sum + Number(row.holds), 0),
    recovered,
    discoveryCalls: stats.discoveryCalls,
    coordStatusFills: stats.coordStatusFills,
    pointerWrites: stats.pointerWrites,
    nearbyInserts: stats.nearbyInserts,
    nearbyDeletes: stats.nearbyDeletes,
    newlyMaterialized: stats.newlyMaterialized,
    reusedComplexes: stats.reusedComplexes,
    reads,
  }));
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message.replace(/apiKey=[^&\s]+/gi, "apiKey=redacted"));
  process.exit(1);
});

/**
 * Nearby-school delta for complexes that newly gained canonical parcel coordinates.
 *
 * Scope: only the complex_ids listed in
 * data/poc/living/school-delta-newly-coordinate-ready.json
 *
 * Does not touch school master/detail or assignment tables.
 *
 *   npx tsx scripts/school-nearby-delta-8505.ts --dry-run
 *   npx tsx scripts/school-nearby-delta-8505.ts --write
 *   npx tsx scripts/school-nearby-delta-8505.ts --write --idempotent-check
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createClient, type Client, type InStatement } from "@libsql/client";
import {
  buildSchoolGrid,
  isSafeParcelPoint,
  linksWithinRadius,
  nearbyDeltaAction,
  parcelCoordVersion,
  schoolsNearCell,
  type NearbySchoolPoint,
} from "../src/lib/school-national/nearby-delta";

const artifactArg = process.argv.find((arg) => arg.startsWith("--artifact="));
const ARTIFACT = artifactArg ? artifactArg.slice("--artifact=".length) : "data/poc/living/school-delta-newly-coordinate-ready.json";
const labelArg = process.argv.find((arg) => arg.startsWith("--label="));
const REPORT_LABEL = labelArg ? labelArg.slice("--label=".length) : "8505";
const WRITE_TABLES = ["complex_nearby_schools", "complex_nearby_materialization"];
const KOREA_LAT = { min: 33, max: 39.5 };
const KOREA_LNG = { min: 124, max: 132.5 };

const stats = {
  nearbyInserts: 0,
  nearbyDeletes: 0,
  materializationInserts: 0,
  materializationUpdates: 0,
  newlyMaterialized: 0,
  reusedComplexes: 0,
  rebuiltComplexes: 0,
  noSchoolsWithinRadius: 0,
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
    compact.startsWith("delete from complex_nearby_schools where complex_id");
  if (!ok) throw new Error(`refusing SQL: ${compact.slice(0, 120)}`);
  if (!WRITE_TABLES.some((table) => compact.includes(table))) {
    throw new Error("refusing write outside nearby school tables");
  }
  const banned = [
    "school_master",
    "school_detail",
    "school_data_status",
    "school_snapshot",
    "assignment",
    "transactions",
    "apt_",
    "ranking",
    "mgmt_fee",
    "complex_building",
    "market_",
    "living",
  ];
  for (const token of banned) {
    if (compact.includes(token) && !compact.includes("complex_nearby")) {
      throw new Error(`refusing unrelated write (${token})`);
    }
  }
  // apt_complex_master must never appear as a write target.
  if (compact.includes("apt_complex_master") && !compact.startsWith("select")) {
    throw new Error("refusing apt_complex_master write");
  }
}

function dbClient(): Client {
  const url = process.env.TURSO_DATABASE_URL?.trim();
  const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
  if (!url || !authToken) throw new Error("TURSO_DATABASE_URL / TURSO_AUTH_TOKEN missing");
  return createClient({ url, authToken });
}

function loadTargetIds(): string[] {
  const artifact = JSON.parse(readFileSync(ARTIFACT, "utf8")) as {
    purpose?: string;
    count?: number;
    complex_ids: string[];
  };
  if (artifact.purpose !== "SCHOOL_NEARBY_DELTA_ONLY") {
    throw new Error(`unexpected purpose: ${artifact.purpose}`);
  }
  const ids = artifact.complex_ids;
  const expected = artifact.count ?? ids.length;
  if (expected !== ids.length || artifact.count !== ids.length) {
    throw new Error(`artifact count mismatch: count=${artifact.count} len=${ids.length}`);
  }
  if (new Set(ids).size !== ids.length) {
    throw new Error("duplicate complex_id in artifact");
  }
  return ids;
}

type TargetRow = {
  complex_id: string;
  apt_name: string;
  sido: string;
  latitude: number;
  longitude: number;
  identity_status: string;
  stored_version: string | null;
  stored_status: string | null;
  existing_link_count: number;
};

async function loadTargets(db: Client, ids: string[]): Promise<{
  rows: TargetRow[];
  invalid: Array<Record<string, unknown>>;
  conflicts: Array<Record<string, unknown>>;
  alreadyComplete: number;
  needMaterialization: number;
}> {
  const byId = new Map<string, TargetRow>();
  const invalid: Array<Record<string, unknown>> = [];
  const conflicts: Array<Record<string, unknown>> = [];

  for (let i = 0; i < ids.length; i += 150) {
    const chunk = ids.slice(i, i + 150);
    const placeholders = chunk.map(() => "?").join(",");
    const res = await db.execute({
      sql: `SELECT c.complex_id, c.apt_name, c.sido, c.latitude, c.longitude, c.identity_status,
              m.coord_version AS stored_version, m.status AS stored_status,
              (SELECT COUNT(*) FROM complex_nearby_schools n WHERE n.complex_id = c.complex_id) AS existing_link_count
            FROM apt_complex_master c
            LEFT JOIN complex_nearby_materialization m ON m.complex_id = c.complex_id
            WHERE c.complex_id IN (${placeholders})`,
      args: chunk,
    });
    for (const row of res.rows) {
      const complexId = String(row.complex_id);
      const lat = row.latitude == null ? null : Number(row.latitude);
      const lng = row.longitude == null ? null : Number(row.longitude);
      const identity = row.identity_status == null ? null : String(row.identity_status);
      const safe = isSafeParcelPoint(lat, lng, identity);
      if (!safe || lat == null || lng == null) {
        invalid.push({
          complex_id: complexId,
          latitude: lat,
          longitude: lng,
          identity_status: identity,
          reason: "UNSAFE_OR_MISSING_PARCEL_POINT",
        });
        continue;
      }
      if (lat === 0 && lng === 0) {
        invalid.push({ complex_id: complexId, reason: "ZERO_ZERO" });
        continue;
      }
      if (lat < KOREA_LAT.min || lat > KOREA_LAT.max || lng < KOREA_LNG.min || lng > KOREA_LNG.max) {
        invalid.push({ complex_id: complexId, reason: "OUT_OF_KOREA_BBOX", lat, lng });
        continue;
      }
      byId.set(complexId, {
        complex_id: complexId,
        apt_name: String(row.apt_name ?? ""),
        sido: String(row.sido ?? ""),
        latitude: lat,
        longitude: lng,
        identity_status: String(identity),
        stored_version: row.stored_version == null ? null : String(row.stored_version),
        stored_status: row.stored_status == null ? null : String(row.stored_status),
        existing_link_count: Number(row.existing_link_count ?? 0),
      });
    }
  }

  const missing = ids.filter((id) => !byId.has(id) && !invalid.some((row) => row.complex_id === id));
  for (const id of missing) invalid.push({ complex_id: id, reason: "MISSING_FROM_MASTER" });

  let alreadyComplete = 0;
  let needMaterialization = 0;
  const rows: TargetRow[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) continue;
    const version = parcelCoordVersion(row.latitude, row.longitude);
    const action = nearbyDeltaAction({
      safe: true,
      coordVersion: version,
      storedVersion: row.stored_version,
      storedStatus: row.stored_status,
    });
    if (action === "reuse") {
      alreadyComplete += 1;
      // Existing valid nearby for this exact coord version: reuse, do not rewrite.
      continue;
    }
    if (action === "rebuild") {
      conflicts.push({
        complex_id: id,
        stored_version: row.stored_version,
        current_version: version,
        existing_link_count: row.existing_link_count,
        note: "coord version changed; rebuild only this complex",
      });
    }
    needMaterialization += 1;
    rows.push(row);
  }

  return { rows, invalid, conflicts, alreadyComplete, needMaterialization };
}

async function loadSchoolGrid(db: Client) {
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
  return { points, grid: buildSchoolGrid(points), schoolCount: points.length };
}

type PlannedComplex = {
  complex_id: string;
  sido: string;
  apt_name: string;
  action: "materialize" | "rebuild";
  link_count: number;
  levels: Record<string, number>;
};

async function planMaterialization(
  targets: TargetRow[],
  grid: ReturnType<typeof buildSchoolGrid>,
): Promise<{ planned: PlannedComplex[]; relationInserts: number; relationDeletes: number }> {
  const planned: PlannedComplex[] = [];
  let relationInserts = 0;
  let relationDeletes = 0;
  for (const target of targets) {
    const version = parcelCoordVersion(target.latitude, target.longitude);
    const action = nearbyDeltaAction({
      safe: true,
      coordVersion: version,
      storedVersion: target.stored_version,
      storedStatus: target.stored_status,
    });
    if (action !== "materialize" && action !== "rebuild") continue;
    const links = linksWithinRadius(
      { lat: target.latitude, lng: target.longitude },
      schoolsNearCell(grid, target.latitude, target.longitude),
    );
    const levels: Record<string, number> = {};
    for (const link of links) levels[link.level] = (levels[link.level] ?? 0) + 1;
    if (action === "rebuild") relationDeletes += target.existing_link_count;
    relationInserts += links.length;
    planned.push({
      complex_id: target.complex_id,
      sido: target.sido,
      apt_name: target.apt_name,
      action,
      link_count: links.length,
      levels,
    });
  }
  return { planned, relationInserts, relationDeletes };
}

async function applyMaterialization(
  db: Client,
  targets: TargetRow[],
  grid: ReturnType<typeof buildSchoolGrid>,
  at: string,
): Promise<void> {
  for (let offset = 0; offset < targets.length; offset += 8) {
    const chunk = targets.slice(offset, offset + 8);
    await Promise.all(
      chunk.map(async (target) => {
        const version = parcelCoordVersion(target.latitude, target.longitude);
        const action = nearbyDeltaAction({
          safe: true,
          coordVersion: version,
          storedVersion: target.stored_version,
          storedStatus: target.stored_status,
        });
        if (action !== "materialize" && action !== "rebuild") {
          stats.reusedComplexes += 1;
          return;
        }
        const links = linksWithinRadius(
          { lat: target.latitude, lng: target.longitude },
          schoolsNearCell(grid, target.latitude, target.longitude),
        );
        const status = links.length > 0 ? "READY" : "NO_SCHOOLS_WITHIN_RADIUS";
        if (links.length === 0) stats.noSchoolsWithinRadius += 1;
        const statements: InStatement[] = [];
        if (action === "rebuild") {
          statements.push({
            sql: "DELETE FROM complex_nearby_schools WHERE complex_id = ?",
            args: [target.complex_id],
          });
        }
        for (const link of links) {
          statements.push({
            sql: `INSERT INTO complex_nearby_schools (
                    complex_id, school_code, distance_m, school_level, rank_by_distance,
                    source_as_of, distance_basis, classification
                  ) VALUES (?, ?, ?, ?, ?, ?, 'PARCEL_REPRESENTATIVE_POINT', 'NEARBY_SCHOOL')
                  ON CONFLICT(complex_id, school_code) DO NOTHING`,
            args: [
              target.complex_id,
              link.code,
              link.distanceM,
              link.level,
              link.rank,
              link.sourceAsOf,
            ],
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
          args: [
            target.complex_id,
            version,
            target.latitude,
            target.longitude,
            links.length,
            status,
            at,
          ],
        });
        for (const statement of statements) assertSchoolWrite(statement.sql);
        const results = await db.batch(statements, "write");
        results.forEach((result, index) => {
          const sql = statements[index]!.sql;
          const affected = Number(result.rowsAffected ?? 0);
          if (sql.startsWith("DELETE")) stats.nearbyDeletes += affected;
          else if (sql.includes("INSERT INTO complex_nearby_schools")) stats.nearbyInserts += affected;
          else if (sql.includes("INSERT INTO complex_nearby_materialization")) {
            if (target.stored_version) stats.materializationUpdates += affected;
            else stats.materializationInserts += affected;
          }
        });
        if (action === "rebuild") stats.rebuiltComplexes += 1;
        else stats.newlyMaterialized += 1;
      }),
    );
    if (offset % 400 === 0) {
      console.log(
        `progress=${offset}/${targets.length} new=${stats.newlyMaterialized} inserts=${stats.nearbyInserts}`,
      );
    }
  }
}

function regionBucket(sido: string): string {
  if (sido.startsWith("서울")) return "서울";
  if (sido.startsWith("경기")) return "경기";
  if (sido.startsWith("인천")) return "인천";
  if (sido.startsWith("부산")) return "부산";
  if (sido.startsWith("대구")) return "대구";
  if (sido.startsWith("대전")) return "대전";
  if (sido.startsWith("광주") || sido.startsWith("전남광주")) return "광주/combined";
  if (sido.startsWith("울산")) return "울산";
  if (sido.startsWith("세종")) return "세종";
  if (sido.startsWith("강원")) return "강원";
  if (sido.startsWith("충북") || sido.startsWith("충청북")) return "충북";
  if (sido.startsWith("충남") || sido.startsWith("충청남")) return "충남";
  if (sido.startsWith("전북") || sido.startsWith("전라북")) return "전북";
  if (sido.startsWith("전남") || sido.startsWith("전라남")) return "전남";
  if (sido.startsWith("경북") || sido.startsWith("경상북")) return "경북";
  if (sido.startsWith("경남") || sido.startsWith("경상남")) return "경남";
  if (sido.startsWith("제주")) return "제주";
  return "other";
}

async function coverage(db: Client): Promise<Record<string, unknown>> {
  const totals = await db.execute(`
    SELECT
      (SELECT COUNT(*) FROM apt_complex_master
        WHERE latitude IS NOT NULL AND longitude IS NOT NULL AND identity_status = 'IDENTITY-READY') AS coord_ready,
      (SELECT COUNT(*) FROM complex_nearby_materialization) AS materialized,
      (SELECT COUNT(*) FROM complex_nearby_materialization WHERE link_count > 0 OR status = 'READY' OR status = 'NO_SCHOOLS_WITHIN_RADIUS') AS nearby_ready,
      (SELECT COUNT(*) FROM complex_nearby_schools) AS nearby_links,
      (SELECT COUNT(*) FROM school_master) AS schools,
      (SELECT COUNT(*) FROM school_detail_snapshots) AS snapshots
  `);
  const regions = await db.execute(`
    SELECT
      CASE
        WHEN c.sido LIKE '서울%' THEN '서울'
        WHEN c.sido LIKE '경기%' THEN '경기'
        WHEN c.sido LIKE '인천%' THEN '인천'
        WHEN c.sido LIKE '부산%' THEN '부산'
        WHEN c.sido LIKE '대구%' THEN '대구'
        WHEN c.sido LIKE '대전%' THEN '대전'
        WHEN c.sido LIKE '광주%' OR c.sido LIKE '전남광주%' THEN '광주/combined'
        WHEN c.sido LIKE '울산%' THEN '울산'
        WHEN c.sido LIKE '세종%' THEN '세종'
        WHEN c.sido LIKE '강원%' THEN '강원'
        WHEN c.sido LIKE '충북%' OR c.sido LIKE '충청북%' THEN '충북'
        WHEN c.sido LIKE '충남%' OR c.sido LIKE '충청남%' THEN '충남'
        WHEN c.sido LIKE '전북%' OR c.sido LIKE '전라북%' THEN '전북'
        WHEN c.sido LIKE '전남%' OR c.sido LIKE '전라남%' THEN '전남'
        WHEN c.sido LIKE '경북%' OR c.sido LIKE '경상북%' THEN '경북'
        WHEN c.sido LIKE '경남%' OR c.sido LIKE '경상남%' THEN '경남'
        WHEN c.sido LIKE '제주%' THEN '제주'
        ELSE 'other'
      END AS region,
      COUNT(*) AS materialized,
      SUM(CASE WHEN m.link_count > 0 THEN 1 ELSE 0 END) AS with_links
    FROM complex_nearby_materialization m
    JOIN apt_complex_master c ON c.complex_id = m.complex_id
    GROUP BY 1
    ORDER BY 1
  `);
  const dups = await db.execute(`
    SELECT COUNT(*) AS n FROM (
      SELECT complex_id, school_code, COUNT(*) c FROM complex_nearby_schools GROUP BY 1, 2 HAVING c > 1
    )
  `);
  return {
    totals: totals.rows[0],
    regions: regions.rows,
    duplicate_nearby: Number(dups.rows[0]?.n ?? 0),
  };
}

async function validatePilots(db: Client, newlyIds: Set<string>): Promise<Record<string, unknown>> {
  async function one(name: string) {
    const found = await db.execute({
      sql: `SELECT complex_id, apt_name, latitude, longitude FROM apt_complex_master
            WHERE apt_name = ? LIMIT 1`,
      args: [name],
    });
    const row = found.rows[0];
    if (!row) return { name, status: "NOT_FOUND" };
    const complexId = String(row.complex_id);
    const mat = await db.execute({
      sql: `SELECT coord_version, link_count, status, materialized_at
            FROM complex_nearby_materialization WHERE complex_id = ?`,
      args: [complexId],
    });
    const links = await db.execute({
      sql: `SELECT school_level, COUNT(*) AS n FROM complex_nearby_schools
            WHERE complex_id = ? GROUP BY school_level`,
      args: [complexId],
    });
    return {
      name,
      complex_id: complexId,
      in_delta_list: newlyIds.has(complexId),
      materialization: mat.rows[0] ?? null,
      links_by_level: links.rows,
      expectation: newlyIds.has(complexId) ? "should_not_be_pilot_reuse" : "reused_unchanged",
    };
  }

  const pilots = {
    잠실엘스: await one("잠실엘스"),
    파크리오: await one("파크리오"),
    리센츠: await one("리센츠"),
  };

  const samples: Array<Record<string, unknown>> = [];
  const want = ["경기", "인천", "대전", "충북", "충남", "경북", "경남", "제주"];
  for (const region of want) {
    const like =
      region === "경기"
        ? "경기%"
        : region === "인천"
          ? "인천%"
          : region === "대전"
            ? "대전%"
            : region === "충북"
              ? "충북%"
              : region === "충남"
                ? "충남%"
                : region === "경북"
                  ? "경북%"
                  : region === "경남"
                    ? "경남%"
                    : "제주%";
    const res = await db.execute({
      sql: `SELECT c.complex_id, c.apt_name, c.sido, m.link_count, m.status
            FROM complex_nearby_materialization m
            JOIN apt_complex_master c ON c.complex_id = m.complex_id
            WHERE c.sido LIKE ? AND m.materialized_at >= datetime('now', '-1 day')
            ORDER BY m.link_count DESC
            LIMIT 1`,
      args: [like],
    });
    if (res.rows[0]) samples.push({ region, ...res.rows[0] });
  }
  return { pilots, new_region_samples: samples };
}

async function main(): Promise<void> {
  const dryRun = hasFlag("dry-run") || !hasFlag("write");
  const write = hasFlag("write");
  const idempotentCheck = hasFlag("idempotent-check");
  const at = nowIso();
  const ids = loadTargetIds();
  const db = dbClient();

  const before = await coverage(db);
  const loaded = await loadTargets(db, ids);
  if (loaded.invalid.length > 0) {
    console.error(JSON.stringify({ stop: true, invalid: loaded.invalid.slice(0, 20) }, null, 2));
    process.exit(2);
  }

  const { grid, schoolCount } = await loadSchoolGrid(db);
  const plan = await planMaterialization(loaded.rows, grid);

  const dry = {
    generated_at: at,
    mode: dryRun && !write ? "dry-run" : write ? (idempotentCheck ? "idempotent-check" : "write") : "dry-run",
    input: {
      artifact: ARTIFACT,
      target_complexes: ids.length,
      unique: new Set(ids).size,
      coordinate_verified: ids.length - loaded.invalid.length,
    },
    baseline_before: before.totals,
    precheck: {
      already_complete: loaded.alreadyComplete,
      need_materialization: loaded.needMaterialization,
      invalid: loaded.invalid.length,
      conflicts: loaded.conflicts.length,
      conflict_samples: loaded.conflicts.slice(0, 10),
      school_master_operating_with_coord: schoolCount,
    },
    dry_run: {
      complexes: plan.planned.length,
      inserts: plan.relationInserts,
      updates: 0,
      deletes: plan.relationDeletes,
      duplicates: 0,
      missing_school_identities: 0,
      no_schools_within_radius: plan.planned.filter((p) => p.link_count === 0).length,
      by_region: Object.fromEntries(
        [...plan.planned.reduce((map, row) => {
          const key = regionBucket(row.sido);
          map.set(key, (map.get(key) ?? 0) + 1);
          return map;
        }, new Map<string, number>())].sort(),
      ),
    },
  };

  const outDir = path.join(process.cwd(), "data/poc/school-national");
  mkdirSync(outDir, { recursive: true });

  if (!write) {
    writeFileSync(path.join(outDir, `nearby-delta-${REPORT_LABEL}-dryrun.json`), JSON.stringify(dry, null, 2));
    console.log(JSON.stringify(dry, null, 2));
    return;
  }

  if (loaded.invalid.length > 0) throw new Error("refusing write with invalid targets");

  // Snapshot pilot materialization timestamps before write for reuse proof.
  const pilotBefore = await validatePilots(db, new Set(ids));

  await applyMaterialization(db, loaded.rows, grid, at);
  const after = await coverage(db);
  const pilots = await validatePilots(db, new Set(ids));

  const report = {
    ...dry,
    production: {
      newly_materialized_complexes: stats.newlyMaterialized,
      relation_inserts: stats.nearbyInserts,
      updates: stats.materializationUpdates,
      deletes: stats.nearbyDeletes,
      materialization_inserts: stats.materializationInserts,
      rebuilt_complexes: stats.rebuiltComplexes,
      no_schools_within_radius: stats.noSchoolsWithinRadius,
      unrelated_writes: 0,
      run_stats: stats,
    },
    coverage_after: after,
    pilots_before: pilotBefore,
    pilots_after: pilots,
  };
  writeFileSync(path.join(outDir, `nearby-delta-${REPORT_LABEL}-apply.json`), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      {
        mode: report.mode,
        precheck: report.precheck,
        dry_run: report.dry_run,
        production: report.production,
        coverage_after: after.totals,
        duplicate_nearby: after.duplicate_nearby,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

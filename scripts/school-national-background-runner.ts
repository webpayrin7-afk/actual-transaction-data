#!/usr/bin/env npx tsx
/**
 * National SCHOOL nearby background runner (missing-only + LIVING follow).
 *
 * Detached usage:
 *   bash scripts/school-national-background-start.sh
 *
 * Foreground / resume (same command):
 *   npx tsx scripts/school-national-background-runner.ts --write
 *
 * Status:
 *   npx tsx scripts/school-national-background-runner.ts --status
 *
 * Ownership: writes only complex_nearby_schools + complex_nearby_materialization.
 * Does not touch LIVING coordinates, school master/detail, assignment, UI.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient, type Client, type InStatement } from "@libsql/client";
import {
  BATCH_SIZE,
  DEPENDENCY_POLL_MS,
  HEARTBEAT_EVERY_N,
  buildOperatingSchoolGrid,
  classifyComplex,
  compareTargets,
  emptyProgress,
  materializeNearbyLinks,
  nearbyDeltaAction,
  parcelCoordVersion,
  regionFromSido,
  type ManifestTarget,
  type RegionCode,
  type RunnerLock,
  type RunnerProgress,
} from "../src/lib/school-national/national-runner";
import type { NearbySchoolPoint as SchoolPoint } from "../src/lib/school-national/nearby-delta";

const ROOT = path.resolve(process.cwd());
const RUNNER_DIR = path.join(ROOT, "data/poc/school-national/runner");
const LOCK_PATH = path.join(RUNNER_DIR, "runner.lock.json");
const PROGRESS_PATH = path.join(RUNNER_DIR, "progress.json");
const CHECKPOINT_PATH = path.join(RUNNER_DIR, "checkpoint.json");
const MANIFEST_PATH = path.join(RUNNER_DIR, "target-manifest.json");
const LOG_PATH = path.join(RUNNER_DIR, "runner.log.jsonl");
const FAILED_PATH = path.join(RUNNER_DIR, "failed.jsonl");
const LIVING_DONE_FLAG = path.join(ROOT, "data/poc/living/runner-terminal.json");
/** Ongoing LIVING handoff only — not the historical one-shot 8505 delta artifact. */
const LIVING_MANIFEST_CANDIDATES = [
  path.join(ROOT, "data/poc/living/school-coordinate-ready-manifest.json"),
];

const WRITE_TABLES = ["complex_nearby_schools", "complex_nearby_materialization"];

type Checkpoint = {
  version: number;
  completed_ids: string[];
  retry_ids: string[];
  seen_coord_versions: Record<string, string>;
  last_living_ids: string[];
};

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function nowIso(): string {
  return new Date().toISOString();
}

function ensureDir(): void {
  mkdirSync(RUNNER_DIR, { recursive: true });
}

function atomicWrite(filePath: string, data: unknown): void {
  const tmp = `${filePath}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, filePath);
}

function appendLog(event: string, payload: Record<string, unknown> = {}): void {
  appendFileSync(
    LOG_PATH,
    `${JSON.stringify({ ts: nowIso(), event, pid: process.pid, ...payload })}\n`,
  );
}

function appendFailed(row: Record<string, unknown>): void {
  appendFileSync(FAILED_PATH, `${JSON.stringify({ ts: nowIso(), ...row })}\n`);
}

function assertNearbyWrite(sql: string): void {
  const compact = sql.replace(/\s+/g, " ").trim().toLowerCase();
  const ok =
    compact.startsWith("insert") ||
    compact.startsWith("update") ||
    compact.startsWith("delete from complex_nearby_schools where complex_id");
  if (!ok) throw new Error(`refusing SQL: ${compact.slice(0, 120)}`);
  if (!WRITE_TABLES.some((t) => compact.includes(t))) {
    throw new Error("refusing write outside nearby school tables");
  }
  const banned = [
    "school_master",
    "school_detail",
    "assignment",
    "transactions",
    "ranking",
    "mgmt_fee",
    "complex_building",
    "market_",
    "living",
    "apt_complex_master",
  ];
  for (const token of banned) {
    if (compact.includes(token) && !compact.includes("complex_nearby")) {
      throw new Error(`refusing unrelated write (${token})`);
    }
  }
}

function dbClient(): Client {
  const url = process.env.TURSO_DATABASE_URL?.trim();
  const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
  if (!url || !authToken) throw new Error("TURSO_DATABASE_URL / TURSO_AUTH_TOKEN missing");
  return createClient({ url, authToken });
}

function loadProgress(): RunnerProgress | null {
  if (!existsSync(PROGRESS_PATH)) return null;
  return JSON.parse(readFileSync(PROGRESS_PATH, "utf8")) as RunnerProgress;
}

function loadCheckpoint(): Checkpoint {
  if (!existsSync(CHECKPOINT_PATH)) {
    return {
      version: 1,
      completed_ids: [],
      retry_ids: [],
      seen_coord_versions: {},
      last_living_ids: [],
    };
  }
  return JSON.parse(readFileSync(CHECKPOINT_PATH, "utf8")) as Checkpoint;
}

function saveCheckpoint(cp: Checkpoint): void {
  atomicWrite(CHECKPOINT_PATH, cp);
}

function saveProgress(p: RunnerProgress): void {
  p.updated_at = nowIso();
  atomicWrite(PROGRESS_PATH, p);
}

function acquireLock(): RunnerLock {
  ensureDir();
  if (existsSync(LOCK_PATH)) {
    const existing = JSON.parse(readFileSync(LOCK_PATH, "utf8")) as RunnerLock;
    try {
      process.kill(existing.pid, 0);
      throw new Error(`runner already locked by pid=${existing.pid} started=${existing.started_at}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        if (String(error).includes("already locked")) throw error;
      }
      appendLog("stale_lock_cleared", { previous_pid: existing.pid });
    }
  }
  const lock: RunnerLock = {
    pid: process.pid,
    started_at: nowIso(),
    hostname: os.hostname(),
    command: process.argv.join(" "),
  };
  atomicWrite(LOCK_PATH, lock);
  return lock;
}

function releaseLock(): void {
  if (!existsSync(LOCK_PATH)) return;
  try {
    const existing = JSON.parse(readFileSync(LOCK_PATH, "utf8")) as RunnerLock;
    if (existing.pid === process.pid) unlinkSync(LOCK_PATH);
  } catch {
    /* ignore */
  }
}

async function loadCoverage(db: Client) {
  const row = (
    await db.execute(`
      SELECT
        (SELECT COUNT(*) FROM apt_complex_master) AS canonical_total,
        (SELECT COUNT(*) FROM apt_complex_master
          WHERE latitude IS NOT NULL AND longitude IS NOT NULL
            AND identity_status = 'IDENTITY-READY'
            AND NOT (ABS(latitude) < 0.0001 AND ABS(longitude) < 0.0001)) AS coord_ready,
        (SELECT COUNT(*) FROM complex_nearby_materialization) AS national_nearby,
        (SELECT COUNT(*) FROM apt_complex_master c
          JOIN complex_nearby_materialization m ON m.complex_id = c.complex_id
          WHERE c.sido LIKE '서울%') AS seoul_nearby,
        (SELECT COUNT(*) FROM apt_complex_master c
          JOIN complex_nearby_materialization m ON m.complex_id = c.complex_id
          WHERE c.sido LIKE '경기%') AS gyeonggi_nearby,
        (SELECT COUNT(*) FROM school_master) AS schools,
        (SELECT COUNT(*) FROM school_detail_snapshots) AS snapshots
    `)
  ).rows[0];
  return {
    canonical_total: Number(row?.canonical_total ?? 0),
    coord_ready: Number(row?.coord_ready ?? 0),
    national_nearby: Number(row?.national_nearby ?? 0),
    seoul_nearby: Number(row?.seoul_nearby ?? 0),
    gyeonggi_nearby: Number(row?.gyeonggi_nearby ?? 0),
    schools: Number(row?.schools ?? 0),
    snapshots: Number(row?.snapshots ?? 0),
  };
}

async function buildManifest(db: Client): Promise<{
  targets: ManifestTarget[];
  existingReady: ManifestTarget[];
  livingWait: ManifestTarget[];
  complete: number;
}> {
  const res = await db.execute(`
    SELECT c.complex_id, c.sido, c.latitude, c.longitude, c.identity_status,
           m.coord_version AS stored_version, m.status AS stored_status,
           COALESCE(m.link_count, 0) AS link_count
    FROM apt_complex_master c
    LEFT JOIN complex_nearby_materialization m ON m.complex_id = c.complex_id
  `);
  const targets: ManifestTarget[] = [];
  for (const row of res.rows) {
    targets.push(
      classifyComplex({
        complex_id: String(row.complex_id),
        sido: row.sido == null ? null : String(row.sido),
        lat: row.latitude == null ? null : Number(row.latitude),
        lng: row.longitude == null ? null : Number(row.longitude),
        identity_status: row.identity_status == null ? null : String(row.identity_status),
        stored_version: row.stored_version == null ? null : String(row.stored_version),
        stored_status: row.stored_status == null ? null : String(row.stored_status),
        link_count: Number(row.link_count ?? 0),
      }),
    );
  }
  targets.sort(compareTargets);
  atomicWrite(MANIFEST_PATH, {
    generated_at: nowIso(),
    count: targets.length,
    targets,
  });
  const existingReady = targets.filter((t) => t.status === "READY_NEARBY" && t.source === "EXISTING_READY");
  const livingWait = targets.filter((t) => t.status === "WAIT_COORDINATE");
  const complete = targets.filter((t) => t.status === "COMPLETE" || t.status === "NO_NEARBY_SCHOOL").length;
  return { targets, existingReady, livingWait, complete };
}

async function loadSchoolGrid(db: Client) {
  const schools = await db.execute(`
    SELECT school_code, school_level, lat, lng, source_as_of
    FROM school_master
    WHERE status = 'operating' AND lat IS NOT NULL AND lng IS NOT NULL
  `);
  const points: SchoolPoint[] = schools.rows.map((row) => ({
    code: String(row.school_code),
    level: String(row.school_level),
    lat: Number(row.lat),
    lng: Number(row.lng),
    sourceAsOf: String(row.source_as_of),
  }));
  return { points, grid: buildOperatingSchoolGrid(points), schoolCount: points.length };
}

type WorkRow = {
  complex_id: string;
  sido: string;
  latitude: number;
  longitude: number;
  identity_status: string;
  stored_version: string | null;
  stored_status: string | null;
  existing_link_count: number;
  region: RegionCode;
  source: "EXISTING_READY" | "LIVING_FOLLOW";
};

async function loadWorkRows(db: Client, ids: string[]): Promise<WorkRow[]> {
  const out: WorkRow[] = [];
  for (let i = 0; i < ids.length; i += 150) {
    const chunk = ids.slice(i, i + 150);
    const placeholders = chunk.map(() => "?").join(",");
    const res = await db.execute({
      sql: `SELECT c.complex_id, c.sido, c.latitude, c.longitude, c.identity_status,
              m.coord_version AS stored_version, m.status AS stored_status,
              (SELECT COUNT(*) FROM complex_nearby_schools n WHERE n.complex_id = c.complex_id) AS existing_link_count
            FROM apt_complex_master c
            LEFT JOIN complex_nearby_materialization m ON m.complex_id = c.complex_id
            WHERE c.complex_id IN (${placeholders})`,
      args: chunk,
    });
    for (const row of res.rows) {
      const lat = row.latitude == null ? null : Number(row.latitude);
      const lng = row.longitude == null ? null : Number(row.longitude);
      const identity = row.identity_status == null ? null : String(row.identity_status);
      if (lat == null || lng == null) continue;
      const storedVersion = row.stored_version == null ? null : String(row.stored_version);
      const storedStatus = row.stored_status == null ? null : String(row.stored_status);
      const version = parcelCoordVersion(lat, lng);
      const action = nearbyDeltaAction({
        safe: true,
        coordVersion: version,
        storedVersion,
        storedStatus,
      });
      // Missing-only: skip already-materialized exact coord versions.
      if (action === "reuse" || action === "skip_no_coordinate") continue;
      out.push({
        complex_id: String(row.complex_id),
        sido: String(row.sido ?? ""),
        latitude: lat,
        longitude: lng,
        identity_status: String(identity ?? ""),
        stored_version: storedVersion,
        stored_status: storedStatus,
        existing_link_count: Number(row.existing_link_count ?? 0),
        region: regionFromSido(String(row.sido ?? "")),
        source: "EXISTING_READY",
      });
    }
  }
  return out;
}

async function applyOne(
  db: Client,
  target: WorkRow,
  grid: Map<string, SchoolPoint[]>,
  at: string,
): Promise<{ inserts: number; status: "READY" | "NO_SCHOOLS_WITHIN_RADIUS" | "REUSED"; matInsert: number }> {
  const version = parcelCoordVersion(target.latitude, target.longitude);
  const action = nearbyDeltaAction({
    safe: true,
    coordVersion: version,
    storedVersion: target.stored_version,
    storedStatus: target.stored_status,
  });
  if (action === "reuse") return { inserts: 0, status: "REUSED", matInsert: 0 };
  if (action !== "materialize" && action !== "rebuild") {
    return { inserts: 0, status: "REUSED", matInsert: 0 };
  }
  const links = materializeNearbyLinks({ lat: target.latitude, lng: target.longitude, grid });
  const status = links.length > 0 ? "READY" : "NO_SCHOOLS_WITHIN_RADIUS";
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
      args: [target.complex_id, link.code, link.distanceM, link.level, link.rank, link.sourceAsOf],
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
    args: [target.complex_id, version, target.latitude, target.longitude, links.length, status, at],
  });
  for (const statement of statements) {
    assertNearbyWrite(typeof statement === "string" ? statement : statement.sql);
  }
  const results = await db.batch(statements, "write");
  let inserts = 0;
  let matInsert = 0;
  results.forEach((result, index) => {
    const statement = statements[index]!;
    const sql = typeof statement === "string" ? statement : statement.sql;
    const affected = Number(result.rowsAffected ?? 0);
    if (sql.includes("INSERT INTO complex_nearby_schools")) inserts += affected;
    if (sql.includes("INSERT INTO complex_nearby_materialization") && !target.stored_version) {
      matInsert += affected;
    }
  });
  return { inserts, status, matInsert };
}

async function discoverLivingFollow(db: Client, completed: Set<string>): Promise<WorkRow[]> {
  const res = await db.execute(`
    SELECT c.complex_id, c.sido, c.latitude, c.longitude, c.identity_status,
           m.coord_version AS stored_version, m.status AS stored_status,
           (SELECT COUNT(*) FROM complex_nearby_schools n WHERE n.complex_id = c.complex_id) AS existing_link_count
    FROM apt_complex_master c
    LEFT JOIN complex_nearby_materialization m ON m.complex_id = c.complex_id
    WHERE c.latitude IS NOT NULL AND c.longitude IS NOT NULL
      AND c.identity_status = 'IDENTITY-READY'
      AND NOT (ABS(c.latitude) < 0.0001 AND ABS(c.longitude) < 0.0001)
      AND m.complex_id IS NULL
  `);
  const rows: WorkRow[] = [];
  for (const row of res.rows) {
    const id = String(row.complex_id);
    if (completed.has(id)) continue;
    rows.push({
      complex_id: id,
      sido: String(row.sido ?? ""),
      latitude: Number(row.latitude),
      longitude: Number(row.longitude),
      identity_status: String(row.identity_status ?? ""),
      stored_version: row.stored_version == null ? null : String(row.stored_version),
      stored_status: row.stored_status == null ? null : String(row.stored_status),
      existing_link_count: Number(row.existing_link_count ?? 0),
      region: regionFromSido(String(row.sido ?? "")),
      source: "LIVING_FOLLOW",
    });
  }
  rows.sort((a, b) => {
    const pa = a.region === "SEOUL" ? 0 : a.region === "GYEONGGI" ? 1 : 2;
    const pb = b.region === "SEOUL" ? 0 : b.region === "GYEONGGI" ? 1 : 2;
    if (pa !== pb) return pa - pb;
    return a.complex_id < b.complex_id ? -1 : a.complex_id > b.complex_id ? 1 : 0;
  });
  return rows;
}

function readLivingManifestIds(): string[] {
  for (const candidate of LIVING_MANIFEST_CANDIDATES) {
    if (!existsSync(candidate)) continue;
    try {
      const raw = JSON.parse(readFileSync(candidate, "utf8")) as {
        complex_ids?: string[];
        targets?: Array<{ complex_id: string }>;
      };
      if (Array.isArray(raw.complex_ids)) return raw.complex_ids.map(String);
      if (Array.isArray(raw.targets)) return raw.targets.map((t) => String(t.complex_id));
    } catch {
      /* ignore bad file */
    }
  }
  return [];
}

function livingRunnerTerminal(): boolean {
  if (!existsSync(LIVING_DONE_FLAG)) return false;
  try {
    const raw = JSON.parse(readFileSync(LIVING_DONE_FLAG, "utf8")) as { status?: string };
    return raw.status === "COMPLETE" || raw.status === "TERMINAL";
  } catch {
    return false;
  }
}

async function processBatch(
  db: Client,
  rows: WorkRow[],
  grid: Map<string, SchoolPoint[]>,
  progress: RunnerProgress,
  checkpoint: Checkpoint,
): Promise<number> {
  const completed = new Set(checkpoint.completed_ids);
  let processed = 0;
  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    const chunk = rows.slice(offset, offset + BATCH_SIZE);
    const at = nowIso();
    await Promise.all(
      chunk.map(async (row) => {
        if (completed.has(row.complex_id)) return;
        progress.current_complex_id = row.complex_id;
        progress.current_region = row.region;
        try {
          const result = await applyOne(db, row, grid, at);
          progress.nearby_processed += 1;
          progress.relation_inserts += result.inserts;
          progress.materialization_inserts += result.matInsert;
          if (result.status === "REUSED") {
            /* no-op */
          } else if (result.status === "NO_SCHOOLS_WITHIN_RADIUS") {
            progress.nearby_no_result += 1;
          } else {
            progress.nearby_success += 1;
          }
          if (row.source === "LIVING_FOLLOW") progress.living_handoff_received += 1;
          checkpoint.completed_ids.push(row.complex_id);
          checkpoint.seen_coord_versions[row.complex_id] = parcelCoordVersion(row.latitude, row.longitude);
          completed.add(row.complex_id);
          processed += 1;
        } catch (error) {
          progress.failed += 1;
          progress.retryable += 1;
          checkpoint.retry_ids.push(row.complex_id);
          appendFailed({
            complex_id: row.complex_id,
            region: row.region,
            error: String(error),
          });
          appendLog("complex_failed", { complex_id: row.complex_id, error: String(error) });
        }
      }),
    );
    progress.batches_completed += 1;
    if (progress.nearby_processed % HEARTBEAT_EVERY_N === 0 || offset + BATCH_SIZE >= rows.length) {
      progress.last_heartbeat_at = nowIso();
      const cov = await loadCoverage(db);
      progress.coverage = {
        national_nearby: cov.national_nearby,
        seoul_nearby: cov.seoul_nearby,
        gyeonggi_nearby: cov.gyeonggi_nearby,
        coord_ready: cov.coord_ready,
      };
      saveCheckpoint(checkpoint);
      saveProgress(progress);
      appendLog("heartbeat", {
        nearby_processed: progress.nearby_processed,
        relation_inserts: progress.relation_inserts,
        wave: progress.wave,
      });
    }
  }
  return processed;
}

async function printStatus(): Promise<void> {
  ensureDir();
  const progress = loadProgress();
  const lock = existsSync(LOCK_PATH)
    ? (JSON.parse(readFileSync(LOCK_PATH, "utf8")) as RunnerLock)
    : null;
  let lockAlive = false;
  if (lock) {
    try {
      process.kill(lock.pid, 0);
      lockAlive = true;
    } catch {
      lockAlive = false;
    }
  }
  console.log(
    JSON.stringify(
      {
        lock,
        lock_alive: lockAlive,
        progress,
        paths: {
          lock: LOCK_PATH,
          progress: PROGRESS_PATH,
          checkpoint: CHECKPOINT_PATH,
          log: LOG_PATH,
          manifest: MANIFEST_PATH,
        },
      },
      null,
      2,
    ),
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWrite(): Promise<void> {
  ensureDir();
  const lock = acquireLock();
  appendLog("runner_start", { lock });

  let progress = loadProgress();
  const checkpoint = loadCheckpoint();
  const db = dbClient();
  const coverage = await loadCoverage(db);
  const now = nowIso();

  if (!progress || progress.terminal_state !== "RUNNING") {
    progress = emptyProgress(now, {
      canonical_total: coverage.canonical_total,
      existing_ready_total: 0,
      living_wait_total: coverage.canonical_total - coverage.coord_ready,
      restarts: progress ? (progress.restarts ?? 0) + 1 : 0,
      coverage: {
        national_nearby: coverage.national_nearby,
        seoul_nearby: coverage.seoul_nearby,
        gyeonggi_nearby: coverage.gyeonggi_nearby,
        coord_ready: coverage.coord_ready,
      },
    });
  } else {
    progress.restarts = (progress.restarts ?? 0) + (existsSync(LOCK_PATH) ? 0 : 1);
  }

  const shuttingDown = { value: false };
  const onSignal = (signal: string) => {
    shuttingDown.value = true;
    progress.terminal_state = "STOPPED";
    saveProgress(progress);
    saveCheckpoint(checkpoint);
    appendLog("signal", { signal });
    releaseLock();
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  const { existingReady, livingWait } = await buildManifest(db);
  progress.canonical_total = coverage.canonical_total;
  progress.existing_ready_total = existingReady.length;
  progress.living_wait_total = livingWait.length;
  progress.coverage = {
    national_nearby: coverage.national_nearby,
    seoul_nearby: coverage.seoul_nearby,
    gyeonggi_nearby: coverage.gyeonggi_nearby,
    coord_ready: coverage.coord_ready,
  };
  saveProgress(progress);
  saveCheckpoint(checkpoint);
  appendLog("manifest_built", {
    existing_ready: existingReady.length,
    living_wait: livingWait.length,
    schools: coverage.schools,
    snapshots: coverage.snapshots,
  });

  const { grid } = await loadSchoolGrid(db);
  const completed = new Set(checkpoint.completed_ids);

  // QUEUE A — EXISTING_READY first
  progress.wave = "EXISTING_READY";
  saveProgress(progress);
  const existingIds = existingReady.map((t) => t.complex_id).filter((id) => !completed.has(id));
  const existingRows = await loadWorkRows(db, existingIds);
  for (const row of existingRows) row.source = "EXISTING_READY";
  const firstBatchProcessed = await processBatch(db, existingRows, grid, progress, checkpoint);
  appendLog("existing_ready_batch_done", { processed: firstBatchProcessed, queued: existingRows.length });

  // QUEUE B — LIVING_FOLLOW poll loop
  progress.wave = "LIVING_FOLLOW";
  saveProgress(progress);

  const maxIdleCycles = Number(process.env.SCHOOL_RUNNER_MAX_IDLE_CYCLES ?? "0"); // 0 = unlimited
  let idleCycles = 0;

  while (!shuttingDown.value) {
    progress.last_dependency_check_at = nowIso();
    progress.wave = "LIVING_FOLLOW";
    saveProgress(progress);
    appendLog("dependency_check", { idle_cycles: idleCycles });

    const manifestIds = readLivingManifestIds();
    const discovered = await discoverLivingFollow(db, new Set(checkpoint.completed_ids));
    // Prefer DB discovery; manifest ids used as supplemental handoff signal
    const supplemental = manifestIds.filter(
      (id) => !checkpoint.completed_ids.includes(id) && !discovered.some((d) => d.complex_id === id),
    );
    let work = discovered;
    if (supplemental.length > 0) {
      const extra = await loadWorkRows(db, supplemental);
      for (const row of extra) row.source = "LIVING_FOLLOW";
      work = [...discovered, ...extra];
    }

    if (work.length > 0) {
      idleCycles = 0;
      appendLog("living_handoff_batch", { count: work.length });
      await processBatch(db, work, grid, progress, checkpoint);
      const cov = await loadCoverage(db);
      progress.living_wait_total = cov.canonical_total - cov.coord_ready;
      progress.coverage = {
        national_nearby: cov.national_nearby,
        seoul_nearby: cov.seoul_nearby,
        gyeonggi_nearby: cov.gyeonggi_nearby,
        coord_ready: cov.coord_ready,
      };
      saveProgress(progress);
    } else {
      idleCycles += 1;
      progress.wave = "IDLE_WAIT";
      progress.last_heartbeat_at = nowIso();
      saveProgress(progress);
      appendLog("idle_wait", { idle_cycles: idleCycles, poll_ms: DEPENDENCY_POLL_MS });

      if (livingRunnerTerminal()) {
        progress.wave = "FINAL_SWEEP";
        saveProgress(progress);
        appendLog("final_sweep_start", {});
        const sweep = await discoverLivingFollow(db, new Set(checkpoint.completed_ids));
        if (sweep.length > 0) {
          await processBatch(db, sweep, grid, progress, checkpoint);
        }
        progress.final_sweep_done = true;
        progress.terminal_state = "COMPLETE";
        const cov = await loadCoverage(db);
        progress.coverage = {
          national_nearby: cov.national_nearby,
          seoul_nearby: cov.seoul_nearby,
          gyeonggi_nearby: cov.gyeonggi_nearby,
          coord_ready: cov.coord_ready,
        };
        progress.living_wait_total = cov.canonical_total - cov.coord_ready;
        saveProgress(progress);
        saveCheckpoint(checkpoint);
        appendLog("runner_complete", { coverage: progress.coverage });
        releaseLock();
        return;
      }

      if (maxIdleCycles > 0 && idleCycles >= maxIdleCycles) {
        progress.terminal_state = "STOPPED";
        saveProgress(progress);
        appendLog("max_idle_stop", { idle_cycles: idleCycles });
        releaseLock();
        return;
      }

      await sleep(DEPENDENCY_POLL_MS);
    }
  }
}

async function main(): Promise<void> {
  if (hasFlag("status")) {
    await printStatus();
    return;
  }
  if (!hasFlag("write")) {
    console.error("Usage: --write | --status");
    process.exit(2);
  }
  await runWrite();
}

main().catch((error) => {
  appendLog("fatal", { error: String(error) });
  try {
    releaseLock();
  } catch {
    /* ignore */
  }
  console.error(error);
  process.exit(1);
});

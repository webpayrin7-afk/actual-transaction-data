#!/usr/bin/env npx tsx
/**
 * PROFILE — National complex profile background full closeout.
 *
 * Modes:
 *   --init-manifest   build stable target manifest (read-only DB)
 *   --wave1           local-only max_floor fill from complex_buildings
 *   --run             full daemon: wave1 then wave2 API national continuation
 *   --status          print progress.json
 *   --verify-start    wait until first batch + heartbeat (used by start wrapper)
 *
 * Detached start:
 *   bash scripts/profile-national-background-start.sh
 *
 * NULL_SAFE_FILL only. No ranking/fee/AC/transaction writes. No FAR/BCR from KAPT.
 * Building-row COUNT / household SUM never promoted to profile building_count / household.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import type { Client } from "@libsql/client";
import {
  CACHE,
  OUT,
  SOURCE_VERSION,
  applyFills,
  collectCandidates,
  coreChipCount,
  decideFills,
  ensureOut,
  fetchKapt,
  fetchRecap,
  heroBucket,
  missingFields,
  nowIso,
  openDb,
  regionOf,
  requireEnv,
  sleep,
  type ApiStats,
  type Candidate,
  type HeroField,
  type MasterSnap,
  type ProfileSnap,
  type RegionKey,
  type TargetStatus,
} from "./profile-national-lib";

const LOCK = resolve(OUT, "runner.lock");
const PROGRESS = resolve(OUT, "progress.json");
const CHECKPOINT = resolve(OUT, "checkpoint.json");
const LOG = resolve(OUT, "runner.log");
const MANIFEST = resolve(OUT, "target-manifest.jsonl");
const RETRY_Q = resolve(OUT, "retry-queue.jsonl");
const MILESTONE = resolve(OUT, "seoul-gyeonggi-milestone.json");
const FINAL = resolve(OUT, "final-report.json");

const BATCH = Number(process.env.PROFILE_NAT_BATCH || 25);
const WAVE1_BATCH = Number(process.env.PROFILE_NAT_WAVE1_BATCH || 200);

type ManifestRow = {
  complex_id: string;
  sido: string;
  sigungu: string;
  lawd_cd: string;
  region: RegionKey;
  priority: number;
  current_completeness: string;
  missing_fields: HeroField[];
  available_sources: string[];
  selected_source: string;
  identity_status: string;
  status: TargetStatus;
  kapt_code: string | null;
  has_parcel: boolean;
  has_bld_max: boolean;
  core_chips: number;
};

type Progress = {
  started_at: string;
  updated_at: string;
  pid: number;
  wave: "WAVE1_LOCAL" | "WAVE2_EXTERNAL" | "DONE" | "FAILED";
  current_region: string;
  current_complex_id: string;
  total_targets: number;
  completed: number;
  remaining: number;
  success: number;
  conflict: number;
  no_source: number;
  failed: number;
  ambiguous: number;
  local_completed: number;
  api_completed: number;
  api_calls: number;
  http429: number;
  http5xx: number;
  timeout: number;
  writes_inserted: number;
  writes_updated: number;
  field_fills: Record<string, number>;
  first_batch_done: boolean;
  seoul_gg_milestone_done: boolean;
  heartbeat_seq: number;
  terminal: string | null;
};

type Checkpoint = {
  version: 1;
  cursor: number;
  wave: Progress["wave"];
  done_ids: string[];
  retry_ids: string[];
  updated_at: string;
};

function log(line: string) {
  ensureOut();
  appendFileSync(LOG, `${nowIso()} ${line}\n`);
}

function writeJsonAtomic(path: string, data: unknown) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

function readProgress(): Progress | null {
  if (!existsSync(PROGRESS)) return null;
  try {
    return JSON.parse(readFileSync(PROGRESS, "utf8")) as Progress;
  } catch {
    return null;
  }
}

function readCheckpoint(): Checkpoint {
  if (!existsSync(CHECKPOINT)) {
    return {
      version: 1,
      cursor: 0,
      wave: "WAVE1_LOCAL",
      done_ids: [],
      retry_ids: [],
      updated_at: nowIso(),
    };
  }
  return JSON.parse(readFileSync(CHECKPOINT, "utf8")) as Checkpoint;
}

function acquireLock(): boolean {
  ensureOut();
  if (existsSync(LOCK)) {
    try {
      const cur = JSON.parse(readFileSync(LOCK, "utf8")) as {
        pid: number;
        started_at: string;
      };
      try {
        process.kill(cur.pid, 0);
        return false; // still alive
      } catch {
        // stale
      }
    } catch {
      // replace
    }
  }
  writeJsonAtomic(LOCK, {
    pid: process.pid,
    started_at: nowIso(),
    host: process.env.HOSTNAME ?? "local",
  });
  return true;
}

function releaseLock() {
  if (existsSync(LOCK)) {
    try {
      const cur = JSON.parse(readFileSync(LOCK, "utf8")) as { pid: number };
      if (cur.pid === process.pid) {
        writeFileSync(LOCK, JSON.stringify({ released_at: nowIso(), pid: process.pid }));
      }
    } catch {
      /* ignore */
    }
  }
}

async function loadManifest(db: Client): Promise<ManifestRow[]> {
  if (existsSync(MANIFEST)) {
    return readFileSync(MANIFEST, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as ManifestRow);
  }
  return buildManifest(db);
}

async function buildManifest(db: Client): Promise<ManifestRow[]> {
  ensureOut();
  log("building manifest");
  const masters = await db.execute(`
    SELECT m.complex_id, m.apt_name, m.sido, m.sigungu, m.lawd_cd, m.bjdong_cd, m.jibun,
           p.household_count, p.building_count, p.approval_date, p.max_floor,
           p.parking_per_household, p.far_ratio, p.bcr_ratio, p.heating_type,
           p.parking_total, p.source, p.source_version, p.raw_meta_json,
           k.source_key AS kapt_code,
           b.mf AS bld_max
    FROM apt_complex_master m
    LEFT JOIN apt_complex_profile p ON p.complex_id = m.complex_id
    LEFT JOIN apt_complex_source_links k ON k.complex_id = m.complex_id AND k.source = 'KAPT'
    LEFT JOIN (
      SELECT complex_id, MAX(floor_count) AS mf
      FROM complex_buildings
      WHERE status = 'EXACT' AND main_atch_type = '주건축물'
        AND residential_flag = 1 AND floor_count IS NOT NULL AND floor_count > 0
      GROUP BY complex_id
    ) b ON b.complex_id = m.complex_id
    ORDER BY m.complex_id
  `);

  const rows: ManifestRow[] = [];
  for (const r of masters.rows) {
    const profile: ProfileSnap = {
      complex_id: String(r.complex_id),
      household_count: (r.household_count as number | null) ?? null,
      building_count: (r.building_count as number | null) ?? null,
      approval_date: (r.approval_date as string | null) ?? null,
      heating_type: (r.heating_type as string | null) ?? null,
      parking_total: (r.parking_total as number | null) ?? null,
      parking_per_household: (r.parking_per_household as number | null) ?? null,
      far_ratio: (r.far_ratio as number | null) ?? null,
      bcr_ratio: (r.bcr_ratio as number | null) ?? null,
      max_floor: (r.max_floor as number | null) ?? null,
      source: (r.source as string | null) ?? null,
      source_version: (r.source_version as string | null) ?? null,
      raw_meta_json: (r.raw_meta_json as string | null) ?? null,
    };

    const miss = missingFields(profile);
    const reg = regionOf(String(r.lawd_cd));
    const kapt = r.kapt_code ? String(r.kapt_code) : null;
    const hasParcel = !!(r.bjdong_cd && r.jibun);
    const hasBldMax = r.bld_max != null;
    const available: string[] = [];
    if (hasBldMax) available.push("COMPLEX_BUILDINGS_MAX_FLOOR");
    if (kapt) available.push("KAPT");
    if (hasParcel) available.push("BUILDING_HUB_RECAP");

    let status: TargetStatus;
    let selected = "NONE";
    if (miss.length === 0) {
      status = "COMPLETE";
      selected = "NONE";
    } else if (hasBldMax && miss.includes("max_floor")) {
      status = "READY_LOCAL";
      selected = "COMPLEX_BUILDINGS_MAX_FLOOR";
    } else if (kapt || hasParcel) {
      status = "READY_API";
      selected = kapt ? "KAPT+RECAP" : "BUILDING_HUB_RECAP";
    } else {
      status = "NO_SOURCE";
      selected = "NONE";
    }

    // Include COMPLETE for stable universe count, but runner skips them.
    rows.push({
      complex_id: String(r.complex_id),
      sido: String(r.sido ?? ""),
      sigungu: String(r.sigungu ?? ""),
      lawd_cd: String(r.lawd_cd),
      region: reg.key,
      priority: reg.priority,
      current_completeness: heroBucket(profile),
      missing_fields: miss,
      available_sources: available,
      selected_source: selected,
      identity_status: kapt
        ? "EXACT_KAPT"
        : hasParcel
          ? "PARCEL_READY"
          : "NO_IDENTITY",
      status,
      kapt_code: kapt,
      has_parcel: hasParcel,
      has_bld_max: hasBldMax,
      core_chips: coreChipCount(profile),
    });
  }

  rows.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    // Prefer more missing P0 core among incomplete
    const aMiss = a.missing_fields.filter((f) =>
      ["household_count", "building_count", "approval_date", "far_ratio", "bcr_ratio"].includes(
        f,
      ),
    ).length;
    const bMiss = b.missing_fields.filter((f) =>
      ["household_count", "building_count", "approval_date", "far_ratio", "bcr_ratio"].includes(
        f,
      ),
    ).length;
    if (aMiss !== bMiss) return bMiss - aMiss;
    return a.complex_id.localeCompare(b.complex_id);
  });

  writeFileSync(MANIFEST, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const summary = {
    generated_at: nowIso(),
    total: rows.length,
    by_status: Object.fromEntries(
      (
        [
          "READY_LOCAL",
          "READY_API",
          "COMPLETE",
          "NO_SOURCE",
          "CONFLICT",
          "AMBIGUOUS",
          "FAILED_RETRYABLE",
        ] as TargetStatus[]
      ).map((s) => [s, rows.filter((r) => r.status === s).length]),
    ),
    by_region: Object.fromEntries(
      [...new Set(rows.map((r) => r.region))].map((reg) => [
        reg,
        rows.filter((r) => r.region === reg).length,
      ]),
    ),
  };
  writeJsonAtomic(resolve(OUT, "manifest-summary.json"), summary);
  log(`manifest built total=${rows.length} ${JSON.stringify(summary.by_status)}`);
  return rows;
}

function emptyProgress(total: number): Progress {
  return {
    started_at: nowIso(),
    updated_at: nowIso(),
    pid: process.pid,
    wave: "WAVE1_LOCAL",
    current_region: "",
    current_complex_id: "",
    total_targets: total,
    completed: 0,
    remaining: total,
    success: 0,
    conflict: 0,
    no_source: 0,
    failed: 0,
    ambiguous: 0,
    local_completed: 0,
    api_completed: 0,
    api_calls: 0,
    http429: 0,
    http5xx: 0,
    timeout: 0,
    writes_inserted: 0,
    writes_updated: 0,
    field_fills: {},
    first_batch_done: false,
    seoul_gg_milestone_done: false,
    heartbeat_seq: 0,
    terminal: null,
  };
}

function bumpFill(prog: Progress, fields: string[]) {
  for (const f of fields) {
    prog.field_fills[f] = (prog.field_fills[f] ?? 0) + 1;
  }
}

async function loadProfile(
  db: Client,
  complexId: string,
): Promise<ProfileSnap | null> {
  const r = await db.execute({
    sql: `SELECT complex_id, household_count, building_count, approval_date, heating_type,
                 parking_total, parking_per_household, far_ratio, bcr_ratio, max_floor,
                 source, source_version, raw_meta_json
          FROM apt_complex_profile WHERE complex_id = ?`,
    args: [complexId],
  });
  const row = r.rows[0];
  if (!row) return null;
  return row as unknown as ProfileSnap;
}

async function loadMaster(db: Client, complexId: string): Promise<MasterSnap> {
  const r = await db.execute({
    sql: `SELECT complex_id, apt_name, sido, sigungu, lawd_cd, bjdong_cd, jibun
          FROM apt_complex_master WHERE complex_id = ?`,
    args: [complexId],
  });
  return r.rows[0] as unknown as MasterSnap;
}

async function loadBldMax(db: Client, complexId: string): Promise<number | null> {
  const r = await db.execute({
    sql: `SELECT MAX(floor_count) mf FROM complex_buildings
          WHERE complex_id = ? AND status = 'EXACT' AND main_atch_type = '주건축물'
            AND residential_flag = 1 AND floor_count IS NOT NULL AND floor_count > 0`,
    args: [complexId],
  });
  const v = r.rows[0]?.mf;
  return v == null ? null : Number(v);
}

async function coverByRegion(db: Client, prefix: string) {
  const r = await db.execute({
    sql: `SELECT
      COUNT(*) total,
      SUM(p.complex_id IS NOT NULL) profile_rows,
      SUM(p.household_count IS NOT NULL) household_count,
      SUM(p.building_count IS NOT NULL) building_count,
      SUM(p.approval_date IS NOT NULL) approval_date,
      SUM(p.max_floor IS NOT NULL) max_floor,
      SUM(p.far_ratio IS NOT NULL) far_ratio,
      SUM(p.bcr_ratio IS NOT NULL) bcr_ratio,
      SUM(p.heating_type IS NOT NULL) heating_type,
      SUM(p.parking_per_household IS NOT NULL) parking_per_household
    FROM apt_complex_master m
    LEFT JOIN apt_complex_profile p ON p.complex_id = m.complex_id
    WHERE m.lawd_cd LIKE ?`,
    args: [`${prefix}%`],
  });
  return r.rows[0];
}

async function chipBuckets(db: Client, prefix: string) {
  const r = await db.execute({
    sql: `SELECT p.household_count hh, p.building_count bd, p.approval_date ap
          FROM apt_complex_master m
          LEFT JOIN apt_complex_profile p ON p.complex_id = m.complex_id
          WHERE m.lawd_cd LIKE ?`,
    args: [`${prefix}%`],
  });
  const b = { c0: 0, c1: 0, c2p: 0, c3: 0 };
  for (const row of r.rows) {
    let n = 0;
    if (row.hh != null) n++;
    if (row.bd != null) n++;
    if (row.ap != null) n++;
    if (n === 0) b.c0++;
    else if (n === 1) b.c1++;
    else if (n === 2) b.c2p++;
    else b.c3++;
  }
  // c2p should be 2+, so fold 2 and 3 into 2+ for reporting but keep c3
  return {
    zero: b.c0,
    one: b.c1,
    two_plus: b.c2p + b.c3,
    three: b.c3,
  };
}

async function maybeMilestone(
  db: Client,
  prog: Progress,
  manifest: ManifestRow[],
  cursor: number,
) {
  if (prog.seoul_gg_milestone_done) return;
  // Milestone when all Gyeonggi+Seoul non-COMPLETE targets before cursor are done
  // OR when current region priority > 1
  const capital = manifest.filter((m) => m.priority <= 1 && m.status !== "COMPLETE");
  const remainingCapital = capital.filter((m, idx) => {
    const globalIdx = manifest.indexOf(m);
    return globalIdx >= cursor && m.status !== "COMPLETE";
  });
  // Simpler: when we've processed past last priority<=1 incomplete index
  let lastCapital = -1;
  for (let i = 0; i < manifest.length; i++) {
    if (manifest[i]!.priority <= 1 && manifest[i]!.status !== "COMPLETE") {
      lastCapital = i;
    }
  }
  if (cursor <= lastCapital) return;

  const seoul = await coverByRegion(db, "11");
  const gg = await coverByRegion(db, "41");
  const seoulChips = await chipBuckets(db, "11");
  const ggChips = await chipBuckets(db, "41");
  const out = {
    at: nowIso(),
    seoul,
    gyeonggi: gg,
    seoul_chips: seoulChips,
    gyeonggi_chips: ggChips,
  };
  writeJsonAtomic(MILESTONE, out);
  prog.seoul_gg_milestone_done = true;
  log(`SEOUL+GYEONGGI milestone written ${JSON.stringify(seoulChips)} ${JSON.stringify(ggChips)}`);
}

async function runWave1(
  db: Client,
  manifest: ManifestRow[],
  prog: Progress,
  ck: Checkpoint,
) {
  prog.wave = "WAVE1_LOCAL";
  const targets = manifest.filter(
    (m) =>
      m.status === "READY_LOCAL" ||
      (m.has_bld_max && m.missing_fields.includes("max_floor")),
  );
  // Also include any with bld max and null max_floor even if status READY_API
  const need = manifest.filter((m) => m.has_bld_max && m.missing_fields.includes("max_floor"));
  log(`wave1 targets=${need.length}`);

  const done = new Set(ck.done_ids);
  let batch = 0;
  for (const m of need) {
    if (done.has(`w1:${m.complex_id}`)) continue;
    prog.current_region = m.region;
    prog.current_complex_id = m.complex_id;
    try {
      const existing = await loadProfile(db, m.complex_id);
      if (existing?.max_floor != null) {
        done.add(`w1:${m.complex_id}`);
        continue;
      }
      const mf = await loadBldMax(db, m.complex_id);
      if (mf == null || mf <= 0) {
        prog.no_source += 1;
        done.add(`w1:${m.complex_id}`);
        continue;
      }
      const cand: Candidate = {
        value: Math.round(mf),
        source: "COMPLEX_BUILDINGS_MAX_FLOOR",
        source_key: "residential_main_exact",
        raw: mf,
      };
      const res = await applyFills(db, m.complex_id, existing, { max_floor: cand });
      if (res.inserted) prog.writes_inserted += 1;
      if (res.updated) prog.writes_updated += 1;
      bumpFill(prog, res.fields);
      prog.success += 1;
      prog.local_completed += 1;
      done.add(`w1:${m.complex_id}`);
      batch += 1;
      if (batch >= WAVE1_BATCH) {
        prog.first_batch_done = true;
        prog.heartbeat_seq += 1;
        prog.updated_at = nowIso();
        prog.remaining = prog.total_targets;
        ck.done_ids = [...done];
        ck.cursor = prog.local_completed;
        ck.wave = "WAVE1_LOCAL";
        ck.updated_at = nowIso();
        writeJsonAtomic(CHECKPOINT, ck);
        writeJsonAtomic(PROGRESS, prog);
        log(`wave1 checkpoint local=${prog.local_completed} inserts=${prog.writes_inserted}`);
        batch = 0;
      }
    } catch (e) {
      prog.failed += 1;
      appendFileSync(RETRY_Q, `${JSON.stringify({ complex_id: m.complex_id, wave: "WAVE1", error: String(e), at: nowIso() })}\n`);
      log(`wave1 fail ${m.complex_id} ${String(e)}`);
    }
  }
  prog.first_batch_done = true;
  prog.heartbeat_seq += 1;
  prog.updated_at = nowIso();
  prog.remaining = Math.max(0, prog.total_targets - prog.completed);
  ck.done_ids = [...done];
  ck.wave = "WAVE2_EXTERNAL";
  ck.updated_at = nowIso();
  writeJsonAtomic(CHECKPOINT, ck);
  writeJsonAtomic(PROGRESS, prog);
  log(`wave1 done local_completed=${prog.local_completed}`);
}

async function runWave2(
  db: Client,
  manifest: ManifestRow[],
  prog: Progress,
  ck: Checkpoint,
  apiKey: string,
) {
  prog.wave = "WAVE2_EXTERNAL";
  const stats: ApiStats = {
    calls: 0,
    http429: 0,
    http5xx: 0,
    timeout: 0,
    sleepMs: 80,
  };
  const done = new Set(ck.done_ids);
  let batch = 0;
  let idx = 0;

  for (const m of manifest) {
    idx += 1;
    if (m.status === "COMPLETE") continue;
    if (done.has(`w2:${m.complex_id}`)) continue;
    // Skip pure NO_SOURCE with nothing to do after wave1
    if (m.status === "NO_SOURCE" && !m.kapt_code && !m.has_parcel) {
      prog.no_source += 1;
      done.add(`w2:${m.complex_id}`);
      continue;
    }

    prog.current_region = m.region;
    prog.current_complex_id = m.complex_id;

    try {
      const existing = await loadProfile(db, m.complex_id);
      const stillMissing = missingFields(
        existing ??
          ({
            complex_id: m.complex_id,
            household_count: null,
            building_count: null,
            approval_date: null,
            heating_type: null,
            parking_total: null,
            parking_per_household: null,
            far_ratio: null,
            bcr_ratio: null,
            max_floor: null,
            source: null,
            source_version: null,
            raw_meta_json: null,
          } as ProfileSnap),
      );
      if (!stillMissing.length) {
        done.add(`w2:${m.complex_id}`);
        prog.completed += 1;
        continue;
      }

      const master = await loadMaster(db, m.complex_id);
      const bldMax = stillMissing.includes("max_floor")
        ? await loadBldMax(db, m.complex_id)
        : null;

      let basic = null as Record<string, unknown> | null;
      let detail = null as Record<string, unknown> | null;
      let recapItem = null as Record<string, unknown> | null;
      let recapKey: string | null = null;
      let recapSource = "BUILDING_HUB_RECAP";
      const needsRecap =
        stillMissing.includes("far_ratio") ||
        stillMissing.includes("bcr_ratio") ||
        stillMissing.includes("household_count") ||
        stillMissing.includes("building_count") ||
        stillMissing.includes("approval_date") ||
        stillMissing.includes("parking_per_household") ||
        stillMissing.includes("heating_type") ||
        !m.kapt_code;
      // Heartbeat before external I/O so stalls are visible.
      prog.heartbeat_seq += 1;
      prog.updated_at = nowIso();
      if (prog.heartbeat_seq % 5 === 0) writeJsonAtomic(PROGRESS, prog);

      const runOne = async () => {
        if (m.kapt_code) {
          const k = await fetchKapt(m.kapt_code, apiKey, stats);
          basic = k.basic;
          detail = k.detail;
        }
        if (needsRecap && m.has_parcel) {
          const rec = await fetchRecap(master, apiKey, stats);
          recapItem = rec.item;
          recapKey = rec.parcelKey;
          if (rec.status === "COLLAPSE") recapSource = "BUILDING_HUB_DUPLICATE_COLLAPSE";
        }
      };
      {
        let timer: ReturnType<typeof setTimeout> | null = null;
        try {
          await Promise.race([
            runOne(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("complex_timeout_120s")),
                120_000,
              );
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      }

      const bags = collectCandidates({
        kaptCode: m.kapt_code,
        basic,
        detail,
        recap: recapItem,
        recapKey,
        recapSource,
        bldMaxFloor: bldMax,
      });
      const decided = decideFills(existing, bags);
      prog.conflict += decided.conflicts;
      prog.ambiguous += decided.ambiguous;

      if (Object.keys(decided.fills).length) {
        const res = await applyFills(db, m.complex_id, existing, decided.fills);
        if (res.inserted) prog.writes_inserted += 1;
        if (res.updated) prog.writes_updated += 1;
        bumpFill(prog, res.fields);
        prog.success += 1;
      } else if (!m.kapt_code && !recapItem && bldMax == null) {
        prog.no_source += 1;
      }

      prog.api_completed += 1;
      prog.completed += 1;
      done.add(`w2:${m.complex_id}`);
      batch += 1;

      prog.api_calls = stats.calls;
      prog.http429 = stats.http429;
      prog.http5xx = stats.http5xx;
      prog.timeout = stats.timeout;
      prog.heartbeat_seq += 1;
      prog.updated_at = nowIso();
      prog.remaining = Math.max(0, prog.total_targets - prog.completed);
      prog.first_batch_done = true;

      if (batch >= BATCH) {
        ck.done_ids = [...done];
        ck.cursor = idx;
        ck.wave = "WAVE2_EXTERNAL";
        ck.updated_at = nowIso();
        writeJsonAtomic(CHECKPOINT, ck);
        writeJsonAtomic(PROGRESS, prog);
        await maybeMilestone(db, prog, manifest, idx);
        log(
          `wave2 checkpoint idx=${idx} completed=${prog.completed} api=${stats.calls} fills=${JSON.stringify(prog.field_fills)}`,
        );
        batch = 0;
      }
    } catch (e) {
      prog.failed += 1;
      appendFileSync(
        RETRY_Q,
        `${JSON.stringify({ complex_id: m.complex_id, wave: "WAVE2", error: String(e), at: nowIso() })}\n`,
      );
      log(`wave2 fail ${m.complex_id} ${String(e)}`);
      // continue
      await sleep(Math.min(5000, stats.sleepMs * 2));
    }
  }

  ck.done_ids = [...done];
  ck.wave = "DONE";
  ck.updated_at = nowIso();
  prog.wave = "DONE";
  prog.terminal = "COMPLETE";
  prog.updated_at = nowIso();
  prog.remaining = 0;
  writeJsonAtomic(CHECKPOINT, ck);
  writeJsonAtomic(PROGRESS, prog);
  await maybeMilestone(db, prog, manifest, manifest.length);
  log(`wave2 done api_calls=${stats.calls}`);
}

async function writeFinal(db: Client, prog: Progress) {
  const prefixes: Array<[string, string]> = [
    ["SEOUL", "11"],
    ["GYEONGGI", "41"],
    ["INCHEON", "28"],
    ["BUSAN", "26"],
    ["DAEGU", "27"],
    ["DAEJEON", "30"],
    ["ULSAN", "31"],
    ["SEJONG", "36"],
    ["GANGWON", "51"],
    ["CHUNGBUK", "43"],
    ["CHUNGNAM", "44"],
    ["JEONBUK", "52"],
    ["GYEONGBUK", "47"],
    ["GYEONGNAM", "48"],
    ["JEJU", "50"],
    ["GWANGJU_JEONNAM", "12"],
  ];
  const byRegion: Record<string, unknown> = {};
  for (const [name, p] of prefixes) {
    byRegion[name] = await coverByRegion(db, p);
  }
  const national = await db.execute(`
    SELECT COUNT(*) total,
      SUM(p.complex_id IS NOT NULL) profile_rows,
      SUM(p.household_count IS NOT NULL) household_count,
      SUM(p.building_count IS NOT NULL) building_count,
      SUM(p.approval_date IS NOT NULL) approval_date,
      SUM(p.max_floor IS NOT NULL) max_floor,
      SUM(p.far_ratio IS NOT NULL) far_ratio,
      SUM(p.bcr_ratio IS NOT NULL) bcr_ratio,
      SUM(p.heating_type IS NOT NULL) heating_type,
      SUM(p.parking_per_household IS NOT NULL) parking_per_household
    FROM apt_complex_master m
    LEFT JOIN apt_complex_profile p ON p.complex_id = m.complex_id
  `);
  const jamsil = await db.execute({
    sql: `SELECT household_count, building_count, approval_date, max_floor,
                 parking_total, parking_per_household, far_ratio, bcr_ratio, heating_type
          FROM apt_complex_profile WHERE complex_id = ?`,
    args: ["cx_4c63d9a100973c60"],
  });
  writeJsonAtomic(FINAL, {
    at: nowIso(),
    progress: prog,
    national: national.rows[0],
    by_region: byRegion,
    seoul_chips: await chipBuckets(db, "11"),
    gyeonggi_chips: await chipBuckets(db, "41"),
    jamsil_els: jamsil.rows[0],
  });
}

async function runDaemon() {
  ensureOut();
  mkdirSync(CACHE, { recursive: true });
  if (!acquireLock()) {
    console.error("FAILED_TO_START: lock held by live process");
    process.exit(2);
  }
  process.on("exit", releaseLock);
  process.on("SIGINT", () => {
    releaseLock();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    releaseLock();
    process.exit(143);
  });

  const apiKey = requireEnv("MOLIT_API_KEY");
  const db = openDb();
  const manifest = await loadManifest(db);
  const workTargets = manifest.filter((m) => m.status !== "COMPLETE").length;
  let prog = readProgress();
  if (!prog || prog.terminal) {
    prog = emptyProgress(workTargets);
  }
  prog.pid = process.pid;
  prog.started_at = prog.started_at || nowIso();
  prog.updated_at = nowIso();
  writeJsonAtomic(PROGRESS, prog);
  log(`daemon start pid=${process.pid} targets=${workTargets}`);

  const ck = readCheckpoint();
  try {
    if (ck.wave === "WAVE1_LOCAL" || ck.wave === "WAVE2_EXTERNAL") {
      // Always ensure wave1 completes first if not marked done in ck
      if (ck.wave === "WAVE1_LOCAL") {
        await runWave1(db, manifest, prog, ck);
      }
      await runWave2(db, manifest, prog, ck, apiKey);
    }
    await writeFinal(db, prog);
    log("daemon complete");
  } catch (e) {
    prog.wave = "FAILED";
    prog.terminal = `FAILED:${String(e)}`;
    prog.updated_at = nowIso();
    writeJsonAtomic(PROGRESS, prog);
    log(`daemon fatal ${String(e)}`);
    throw e;
  } finally {
    releaseLock();
  }
}

async function verifyStart(timeoutMs = 120_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const p = readProgress();
    const lockOk = existsSync(LOCK);
    if (
      p &&
      lockOk &&
      p.first_batch_done &&
      p.heartbeat_seq > 0 &&
      (p.local_completed > 0 || p.api_completed > 0 || p.writes_inserted > 0 || p.writes_updated > 0)
    ) {
      console.log(
        JSON.stringify(
          {
            STATUS: "BACKGROUND_RUNNING",
            progress: p,
            lock: JSON.parse(readFileSync(LOCK, "utf8")),
            checkpoint: existsSync(CHECKPOINT),
            log_bytes: existsSync(LOG) ? readFileSync(LOG).length : 0,
          },
          null,
          2,
        ),
      );
      return;
    }
    await sleep(2000);
  }
  console.log(JSON.stringify({ STATUS: "FAILED_TO_START", progress: readProgress() }, null, 2));
  process.exit(1);
}

async function main() {
  ensureOut();
  const args = process.argv.slice(2);
  if (args.includes("--status")) {
    console.log(JSON.stringify(readProgress(), null, 2));
    return;
  }
  if (args.includes("--init-manifest")) {
    const db = openDb();
    const rows = await buildManifest(db);
    console.log(
      JSON.stringify(
        {
          total: rows.length,
          ready_local: rows.filter((r) => r.status === "READY_LOCAL").length,
          ready_api: rows.filter((r) => r.status === "READY_API").length,
          complete: rows.filter((r) => r.status === "COMPLETE").length,
          no_source: rows.filter((r) => r.status === "NO_SOURCE").length,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (args.includes("--wave1")) {
    if (!acquireLock()) {
      console.error("lock held");
      process.exit(2);
    }
    try {
      const db = openDb();
      const manifest = await loadManifest(db);
      const prog = emptyProgress(manifest.filter((m) => m.status !== "COMPLETE").length);
      writeJsonAtomic(PROGRESS, prog);
      const ck = readCheckpoint();
      ck.wave = "WAVE1_LOCAL";
      await runWave1(db, manifest, prog, ck);
      console.log(JSON.stringify(prog, null, 2));
    } finally {
      releaseLock();
    }
    return;
  }
  if (args.includes("--verify-start")) {
    await verifyStart();
    return;
  }
  if (args.includes("--run") || args.length === 0) {
    await runDaemon();
    return;
  }
  console.error("unknown args", args);
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

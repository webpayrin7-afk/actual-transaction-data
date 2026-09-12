#!/usr/bin/env node
/**
 * Phase 6.1 — Apartment Master v1 production bootstrap (INSERT-only).
 *
 *   node scripts/phase61-apartment-master-bootstrap.mjs
 *   node scripts/phase61-apartment-master-bootstrap.mjs --execute
 */
import { createClient } from "@libsql/client";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const BOOT_PATH = resolve(ROOT, "data/master/complex_master_v1_bootstrap.json");
const HELD_PATH = resolve(ROOT, "data/master/complex_master_v1_held.json");
const REPORT_PATH = resolve(ROOT, "data/poc/phase61/bootstrap-report.json");

const BATCH = 100;
const EXPECTED_READY = 14966;
const EXPECTED_AMB = 736;
const EXPECTED_UNR = 49;

const DDL = `
CREATE TABLE IF NOT EXISTS apt_complex_master (
  complex_id TEXT PRIMARY KEY,
  apt_name TEXT NOT NULL,
  apt_name_norm TEXT NOT NULL,
  sido TEXT,
  sido_code TEXT,
  sigungu TEXT,
  lawd_cd TEXT NOT NULL,
  legal_dong_name TEXT,
  bjdong_cd TEXT,
  jibun TEXT,
  road_address TEXT,
  latitude REAL,
  longitude REAL,
  identity_status TEXT NOT NULL,
  identity_reason_codes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_acm_name_norm ON apt_complex_master (apt_name_norm);
CREATE INDEX IF NOT EXISTS idx_acm_lawd ON apt_complex_master (lawd_cd);
CREATE INDEX IF NOT EXISTS idx_acm_bjdong ON apt_complex_master (bjdong_cd);
CREATE INDEX IF NOT EXISTS idx_acm_lawd_norm ON apt_complex_master (lawd_cd, apt_name_norm);

CREATE TABLE IF NOT EXISTS apt_complex_source_links (
  source TEXT NOT NULL,
  source_key TEXT NOT NULL,
  complex_id TEXT NOT NULL REFERENCES apt_complex_master(complex_id),
  source_meta_json TEXT,
  source_version TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source, source_key)
);
CREATE INDEX IF NOT EXISTS idx_acsl_complex ON apt_complex_source_links (complex_id);

CREATE TABLE IF NOT EXISTS apt_complex_enrichment_state (
  complex_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  status TEXT NOT NULL,
  reason_code TEXT,
  data_version INTEGER,
  processed_at TEXT,
  source_updated_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (complex_id, domain)
);
`;

const PHASE5_PILOTS = [
  { complexKey: "hangang-daewoo", lawdCd: "11170", aptNameNorm: "한강(대우)" },
  { complexKey: "parkrio", lawdCd: "11710", aptNameNorm: "파크리오" },
  { complexKey: "banpo-xi", lawdCd: "11650", aptNameNorm: "반포자이" },
  { complexKey: "jamsil-els", lawdCd: "11710", aptNameNorm: "잠실엘스" },
  { complexKey: "mokdong-7", lawdCd: "11470", aptNameNorm: "목동신시가지7" },
  { complexKey: "eunma", lawdCd: "11680", aptNameNorm: "은마" },
];

function getDb() {
  const url = process.env.TURSO_DATABASE_URL?.trim();
  const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
  if (!url || !authToken) throw new Error("TURSO env required");
  if (url.startsWith("file:") || url === ":memory:") {
    throw new Error("Refusing local DB");
  }
  return createClient({ url, authToken });
}

async function cnt(db, sql, args = []) {
  const r = await db.execute({ sql, args });
  return Number(r.rows[0].c ?? 0);
}

async function tableExists(db, name) {
  return (
    (await cnt(
      db,
      "SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name=?",
      [name],
    )) > 0
  );
}

function loadRows() {
  const doc = JSON.parse(readFileSync(BOOT_PATH, "utf8"));
  if (doc.ready_count !== EXPECTED_READY || doc.rows.length !== EXPECTED_READY) {
    throw new Error(`ready mismatch ${doc.ready_count}/${doc.rows.length}`);
  }
  return doc.rows;
}

function loadHeld() {
  return JSON.parse(readFileSync(HELD_PATH, "utf8"));
}

function localPreflight(rows, held) {
  const ids = new Set(rows.map((r) => r.complex_id));
  const keys = new Set(rows.map((r) => r.molit_source_key));
  if (ids.size !== EXPECTED_READY) throw new Error("dup complex_id in manifest");
  if (keys.size !== EXPECTED_READY) throw new Error("dup source_key in manifest");
  for (const r of rows) {
    if (
      !r.complex_id ||
      !r.apt_name ||
      !r.apt_name_norm ||
      !r.lawd_cd ||
      r.identity_status !== "IDENTITY-READY" ||
      r.molit_source_key !== `${r.lawd_cd}|${r.apt_name_norm}`
    ) {
      throw new Error(`bad row ${r.molit_source_key}`);
    }
  }
  if (held.ambiguous_count !== EXPECTED_AMB || held.unresolved_count !== EXPECTED_UNR) {
    throw new Error(
      `held counts mismatch amb=${held.ambiguous_count} unr=${held.unresolved_count}`,
    );
  }
}

async function main() {
  const doWrite = process.argv.includes("--execute");
  const rows = loadRows();
  const held = loadHeld();
  localPreflight(rows, held);

  const db = getDb();
  await db.executeMultiple(DDL);

  for (const t of [
    "apt_complex_master",
    "apt_complex_source_links",
    "apt_complex_enrichment_state",
  ]) {
    if (!(await tableExists(db, t))) throw new Error(`DDL failed: ${t}`);
  }

  const beforeMaster = await cnt(db, "SELECT COUNT(*) AS c FROM apt_complex_master");
  const beforeLinks = await cnt(db, "SELECT COUNT(*) AS c FROM apt_complex_source_links");
  const beforeStatus = await cnt(
    db,
    "SELECT COUNT(*) AS c FROM apt_complex_enrichment_state",
  );

  const byId = new Map(rows.map((r) => [r.complex_id, r]));
  const byKey = new Map(rows.map((r) => [r.molit_source_key, r]));

  const existingMaster = await db.execute(
    "SELECT complex_id, apt_name_norm, lawd_cd, identity_status FROM apt_complex_master",
  );
  const haveIds = new Set();
  for (const g of existingMaster.rows) {
    const id = String(g.complex_id);
    haveIds.add(id);
    const exp = byId.get(id);
    if (!exp) throw new Error(`HOLD unexpected master ${id}`);
    if (
      String(g.apt_name_norm) !== exp.apt_name_norm ||
      String(g.lawd_cd) !== exp.lawd_cd ||
      String(g.identity_status) !== "IDENTITY-READY"
    ) {
      throw new Error(`HOLD conflict master ${id}`);
    }
  }

  const existingLinks = await db.execute(
    "SELECT source_key, complex_id FROM apt_complex_source_links WHERE source='MOLIT'",
  );
  const haveKeys = new Set();
  for (const g of existingLinks.rows) {
    const key = String(g.source_key);
    haveKeys.add(key);
    const exp = byKey.get(key);
    if (!exp) throw new Error(`HOLD unexpected link ${key}`);
    if (String(g.complex_id) !== exp.complex_id) {
      throw new Error(`HOLD conflict link ${key}`);
    }
  }

  const needMaster = rows.filter((r) => !haveIds.has(r.complex_id));
  const needLinks = rows.filter((r) => !haveKeys.has(r.molit_source_key));

  const report = {
    phase: "6.1",
    execute: doWrite,
    schema: {
      apt_complex_master: "created YES",
      apt_complex_source_links: "created YES",
      apt_complex_enrichment_state: "created YES",
    },
    preflight: {
      READY_candidates: rows.length,
      duplicate_complex_ids: 0,
      duplicate_source_keys: 0,
      missing_required_fields: 0,
      source_mapping: "100%",
      before_master: beforeMaster,
      before_links: beforeLinks,
      before_status: beforeStatus,
      missing_master: needMaster.length,
      missing_links: needLinks.length,
    },
    held: {
      AMBIGUOUS: held.ambiguous_count,
      UNRESOLVED: held.unresolved_count,
      canonical_ids_assigned_to_held: 0,
    },
  };

  mkdirSync(resolve(ROOT, "data/poc/phase61"), { recursive: true });

  if (!doWrite) {
    report.decision = "PREFLIGHT-PASS";
    report.next = "re-run with --execute";
    writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const now = new Date().toISOString();
  let masterWritten = 0;
  let linksWritten = 0;

  for (let i = 0; i < needMaster.length; i += BATCH) {
    const chunk = needMaster.slice(i, i + BATCH);
    const ph = chunk.map(() => "(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").join(",");
    const args = [];
    for (const r of chunk) {
      args.push(
        r.complex_id,
        r.apt_name,
        r.apt_name_norm,
        r.sido || null,
        r.sido_code || null,
        r.sigungu || null,
        r.lawd_cd,
        r.legal_dong_name || null,
        r.bjdong_cd || null,
        r.jibun || null,
        null,
        null,
        null,
        "IDENTITY-READY",
        JSON.stringify(r.identity_reason_codes ?? []),
        now,
        now,
      );
    }
    const res = await db.execute({
      sql: `INSERT INTO apt_complex_master (
        complex_id, apt_name, apt_name_norm, sido, sido_code, sigungu, lawd_cd,
        legal_dong_name, bjdong_cd, jibun, road_address, latitude, longitude,
        identity_status, identity_reason_codes, created_at, updated_at
      ) VALUES ${ph}`,
      args,
    });
    masterWritten += Number(res.rowsAffected ?? chunk.length);
    if (i === 0 || (i / BATCH) % 25 === 0) {
      console.log(
        `master ${Math.min(i + BATCH, needMaster.length)}/${needMaster.length}`,
      );
    }
  }

  for (let i = 0; i < needLinks.length; i += BATCH) {
    const chunk = needLinks.slice(i, i + BATCH);
    const ph = chunk.map(() => "(?,?,?,?,?,?,?)").join(",");
    const args = [];
    for (const r of chunk) {
      args.push(
        "MOLIT",
        r.molit_source_key,
        r.complex_id,
        JSON.stringify({ lawd_cd: r.lawd_cd, apt_name_norm: r.apt_name_norm }),
        "v1",
        now,
        now,
      );
    }
    const res = await db.execute({
      sql: `INSERT INTO apt_complex_source_links (
        source, source_key, complex_id, source_meta_json, source_version, created_at, updated_at
      ) VALUES ${ph}`,
      args,
    });
    linksWritten += Number(res.rowsAffected ?? chunk.length);
    if (i === 0 || (i / BATCH) % 25 === 0) {
      console.log(
        `links ${Math.min(i + BATCH, needLinks.length)}/${needLinks.length}`,
      );
    }
  }

  const masterAfter = await cnt(db, "SELECT COUNT(*) AS c FROM apt_complex_master");
  const linksAfter = await cnt(db, "SELECT COUNT(*) AS c FROM apt_complex_source_links");
  const statusAfter = await cnt(
    db,
    "SELECT COUNT(*) AS c FROM apt_complex_enrichment_state",
  );
  const dupId = await cnt(
    db,
    "SELECT COUNT(*) AS c FROM (SELECT complex_id FROM apt_complex_master GROUP BY complex_id HAVING COUNT(*)>1)",
  );
  const dupKey = await cnt(
    db,
    "SELECT COUNT(*) AS c FROM (SELECT source, source_key FROM apt_complex_source_links GROUP BY source, source_key HAVING COUNT(*)>1)",
  );
  const orphan = await cnt(
    db,
    `SELECT COUNT(*) AS c FROM apt_complex_source_links l
     LEFT JOIN apt_complex_master m ON m.complex_id = l.complex_id
     WHERE m.complex_id IS NULL`,
  );
  const seoul = await cnt(
    db,
    "SELECT COUNT(*) AS c FROM apt_complex_master WHERE lawd_cd LIKE '11%'",
  );
  const gyeonggi = await cnt(
    db,
    "SELECT COUNT(*) AS c FROM apt_complex_master WHERE lawd_cd LIKE '41%'",
  );
  const bunJi = await cnt(
    db,
    "SELECT COUNT(*) AS c FROM apt_complex_master WHERE jibun LIKE '%-%'",
  );

  let pilotsResolved = 0;
  const pilotResults = [];
  for (const p of PHASE5_PILOTS) {
    const key = `${p.lawdCd}|${p.aptNameNorm}`;
    const r = await db.execute({
      sql: "SELECT complex_id FROM apt_complex_source_links WHERE source='MOLIT' AND source_key=?",
      args: [key],
    });
    const id = r.rows[0] ? String(r.rows[0].complex_id) : null;
    if (id) pilotsResolved++;
    pilotResults.push({ complexKey: p.complexKey, complex_id: id });
  }

  let classCount = 0;
  if (await tableExists(db, "apt_complex_classifications")) {
    classCount = await cnt(db, "SELECT COUNT(*) AS c FROM apt_complex_classifications");
  }

  const decision =
    masterAfter === EXPECTED_READY &&
    linksAfter === EXPECTED_READY &&
    statusAfter === 0 &&
    dupId === 0 &&
    dupKey === 0 &&
    orphan === 0 &&
    pilotsResolved === PHASE5_PILOTS.length
      ? "PASS"
      : "HOLD";

  Object.assign(report, {
    canonical_bootstrap: {
      READY_candidates: EXPECTED_READY,
      master_written: masterWritten,
      master_total: masterAfter,
      source_links_written: linksWritten,
      source_links_total: linksAfter,
      status_rows: statusAfter,
      total_row_writes: masterWritten + linksWritten,
    },
    integrity: {
      duplicate_complex_ids: dupId,
      duplicate_source_keys: dupKey,
      source_mapping: orphan === 0 ? "100%" : `orphans=${orphan}`,
      missing_required_fields: 0,
    },
    spot_checks: { seoul, gyeonggi, bun_ji: bunJi },
    phase5_compatibility: {
      existing_loaded_complexes: classCount,
      pilots: PHASE5_PILOTS.length,
      resolved_to_complex_id: pilotsResolved,
      unresolved: PHASE5_PILOTS.length - pilotsResolved,
      pilot_results: pilotResults,
    },
    production: {
      runtime_errors: 0,
      flags_changed: "none",
      updates: 0,
      deletes: 0,
    },
    decision,
    next:
      decision === "PASS"
        ? "Phase 6.2 — dual-key integration for existing child tables"
        : "investigate HOLD before dual-key migration",
  });

  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (decision !== "PASS") process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

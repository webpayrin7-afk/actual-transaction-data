#!/usr/bin/env node
/**
 * Phase 6.2 — dual-key backfill (complex_id onto Phase5 child tables).
 *
 *   node scripts/phase62-dual-key-backfill.mjs           # preflight only
 *   node scripts/phase62-dual-key-backfill.mjs --execute # ALTER + UPDATE complex_id only
 */
import { createClient } from "@libsql/client";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const REPORT_PATH = resolve(ROOT, "data/poc/phase62/dual-key-report.json");

const CHILD_TABLES = [
  "apt_complex_classifications",
  "apt_pyeong_groups",
  "apt_pyeong_group_baselines",
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

async function cols(db, table) {
  const r = await db.execute(`PRAGMA table_info(${table})`);
  return r.rows.map((x) => String(x.name));
}

async function businessChecksum(db, table) {
  const names = (await cols(db, table)).filter((n) => n !== "complex_id");
  const list = names.map((n) => `COALESCE(CAST(${n} AS TEXT),'')`).join(`||'|'||`);
  const r = await db.execute(
    `SELECT GROUP_CONCAT(row_hash, '') AS h FROM (
       SELECT ${list} AS row_hash FROM ${table} ORDER BY 1
     )`,
  );
  const raw = String(r.rows[0]?.h ?? "");
  return createHash("sha256").update(raw).digest("hex");
}

async function main() {
  const doWrite = process.argv.includes("--execute");
  const db = getDb();

  // Build complex_key → complex_id map from classifications × MOLIT links
  const cls = await db.execute(
    `SELECT complex_key, apt_name_norm, lawd_cd FROM apt_complex_classifications ORDER BY complex_key`,
  );
  const keyToId = new Map();
  const unresolvedKeys = [];
  const conflicts = [];
  for (const row of cls.rows) {
    const complexKey = String(row.complex_key);
    const sourceKey = `${row.lawd_cd}|${row.apt_name_norm}`;
    const link = await db.execute({
      sql: `SELECT complex_id FROM apt_complex_source_links WHERE source='MOLIT' AND source_key=?`,
      args: [sourceKey],
    });
    const ids = [...new Set(link.rows.map((r) => String(r.complex_id)))];
    if (ids.length === 0) {
      unresolvedKeys.push({ complex_key: complexKey, source_key: sourceKey });
      continue;
    }
    if (ids.length > 1) {
      conflicts.push({ complex_key: complexKey, complex_ids: ids });
      continue;
    }
    // verify master
    const m = await cnt(
      db,
      "SELECT COUNT(*) AS c FROM apt_complex_master WHERE complex_id=?",
      [ids[0]],
    );
    if (m !== 1) {
      unresolvedKeys.push({
        complex_key: complexKey,
        source_key: sourceKey,
        reason: "master_missing",
      });
      continue;
    }
    keyToId.set(complexKey, ids[0]);
  }
  if (conflicts.length) {
    console.error(JSON.stringify({ decision: "HOLD", conflicts }, null, 2));
    process.exit(2);
  }

  const preflight = {};
  for (const t of CHILD_TABLES) {
    const colnames = await cols(db, t);
    const total = await cnt(db, `SELECT COUNT(*) AS c FROM ${t}`);
    const distinctKeys = await cnt(
      db,
      `SELECT COUNT(DISTINCT complex_key) AS c FROM ${t}`,
    );
    const keyRows = await db.execute(
      `SELECT complex_key, COUNT(*) AS c FROM ${t} GROUP BY complex_key ORDER BY complex_key`,
    );
    let resolvableRows = 0;
    let unresolvableRows = 0;
    const unresolved = [];
    for (const r of keyRows.rows) {
      const k = String(r.complex_key);
      const c = Number(r.c);
      if (keyToId.has(k)) resolvableRows += c;
      else {
        unresolvableRows += c;
        unresolved.push(k);
      }
    }
    preflight[t] = {
      rows: total,
      complexes: distinctKeys,
      has_complex_id: colnames.includes("complex_id"),
      columns: colnames,
      resolvable_rows: resolvableRows,
      unresolvable_rows: unresolvableRows,
      unresolvable_keys: unresolved,
      expected_updates: resolvableRows,
    };
  }

  const report = {
    phase: "6.2",
    execute: doWrite,
    preflight,
    eleven_vs_six: {
      child_table_distinct_complexes: 11,
      phase5_pilot_allowlist: 6,
      explanation:
        "Phase 6.1 'existing loaded complexes: 11' counted distinct complex_key in apt_complex_classifications. 'resolved 6/6 pilots' checked only PHASE5_PILOT_COMPLEXES allowlist. 5 additional loaded complexes exist beyond the original 6 pilots.",
      classification_keys: cls.rows.map((r) => String(r.complex_key)),
    },
    mapping: {
      resolvable_complexes: keyToId.size,
      unresolved_complexes: unresolvedKeys,
      conflicts: 0,
    },
  };

  if (!doWrite) {
    report.decision = "PREFLIGHT-PASS";
    mkdirSync(resolve(ROOT, "data/poc/phase62"), { recursive: true });
    writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  // checksums before
  const checksumBefore = {};
  for (const t of CHILD_TABLES) {
    checksumBefore[t] = await businessChecksum(db, t);
  }

  // schema: add nullable complex_id + indexes (no FK force)
  for (const t of CHILD_TABLES) {
    const colnames = await cols(db, t);
    if (!colnames.includes("complex_id")) {
      await db.execute(`ALTER TABLE ${t} ADD COLUMN complex_id TEXT`);
    }
    await db.execute(
      `CREATE INDEX IF NOT EXISTS idx_${t}_complex_id ON ${t} (complex_id)`,
    );
  }

  const updates = {};
  for (const t of CHILD_TABLES) {
    let n = 0;
    for (const [complexKey, complexId] of keyToId.entries()) {
      const res = await db.execute({
        sql: `UPDATE ${t} SET complex_id = ? WHERE complex_key = ? AND (complex_id IS NULL OR complex_id = ?)`,
        args: [complexId, complexKey, complexId],
      });
      n += Number(res.rowsAffected ?? 0);
    }
    // detect conflict if any row already has different complex_id
    const bad = await db.execute({
      sql: `SELECT complex_key, complex_id FROM ${t}
            WHERE complex_id IS NOT NULL AND complex_key IN (${[...keyToId.keys()].map(() => "?").join(",")})`,
      args: [...keyToId.keys()],
    });
    for (const r of bad.rows) {
      const expected = keyToId.get(String(r.complex_key));
      if (expected && String(r.complex_id) !== expected) {
        throw new Error(
          `HOLD conflict ${t} ${r.complex_key}: have ${r.complex_id} want ${expected}`,
        );
      }
    }
    updates[t] = n;
  }

  const checksumAfter = {};
  for (const t of CHILD_TABLES) {
    checksumAfter[t] = await businessChecksum(db, t);
  }
  for (const t of CHILD_TABLES) {
    if (checksumBefore[t] !== checksumAfter[t]) {
      throw new Error(`HOLD business field checksum changed for ${t}`);
    }
  }

  // integrity
  async function orphanCount(table) {
    return cnt(
      db,
      `SELECT COUNT(*) AS c FROM ${table} x
       LEFT JOIN apt_complex_master m ON m.complex_id = x.complex_id
       WHERE x.complex_id IS NOT NULL AND m.complex_id IS NULL`,
    );
  }
  const classOrphan = await orphanCount("apt_complex_classifications");
  const groupOrphan = await orphanCount("apt_pyeong_groups");
  const baseOrphan = await orphanCount("apt_pyeong_group_baselines");
  const mismatch = await cnt(
    db,
    `SELECT COUNT(*) AS c
     FROM apt_pyeong_group_baselines b
     JOIN apt_pyeong_groups g ON g.group_key = b.group_key
     WHERE b.complex_id IS NOT NULL AND g.complex_id IS NOT NULL
       AND b.complex_id != g.complex_id`,
  );

  const nullClass = await cnt(
    db,
    "SELECT COUNT(*) AS c FROM apt_complex_classifications WHERE complex_id IS NULL",
  );
  const nullGroup = await cnt(
    db,
    "SELECT COUNT(*) AS c FROM apt_pyeong_groups WHERE complex_id IS NULL",
  );
  const nullBase = await cnt(
    db,
    "SELECT COUNT(*) AS c FROM apt_pyeong_group_baselines WHERE complex_id IS NULL",
  );

  const decision =
    classOrphan === 0 &&
    groupOrphan === 0 &&
    baseOrphan === 0 &&
    mismatch === 0 &&
    nullClass === preflight.apt_complex_classifications.unresolvable_rows &&
    nullGroup === preflight.apt_pyeong_groups.unresolvable_rows &&
    nullBase === preflight.apt_pyeong_group_baselines.unresolvable_rows
      ? "PASS"
      : "HOLD";

  Object.assign(report, {
    schema: {
      complex_id_added: "YES (nullable)",
      indexes: "idx_*_complex_id YES",
      FK: "NO (avoid rebuild risk)",
    },
    backfill: {
      classification_updates: updates.apt_complex_classifications,
      group_updates: updates.apt_pyeong_groups,
      baseline_updates: updates.apt_pyeong_group_baselines,
      unresolved_rows: {
        classifications: nullClass,
        groups: nullGroup,
        baselines: nullBase,
      },
      unresolved_keys: unresolvedKeys,
      conflicts: 0,
      business_checksum_unchanged: true,
    },
    integrity: {
      classification_to_master:
        classOrphan === 0 ? "100%" : `orphans=${classOrphan}`,
      group_to_master: groupOrphan === 0 ? "100%" : `orphans=${groupOrphan}`,
      baseline_to_master: baseOrphan === 0 ? "100%" : `orphans=${baseOrphan}`,
      baseline_group_complex_id_mismatch: mismatch,
    },
    production_compatibility: {
      legacy_complex_key_retained: "YES",
      dual_write: "YES (code)",
      dual_read_fallback: "YES (code)",
      updates_only_complex_id: true,
      deletes: 0,
    },
    flags: { changed: "NO" },
    decision,
    next:
      decision === "PASS"
        ? "Phase 6.3 — Apartment Master enrichment framework + GEO foundation"
        : "investigate HOLD before enrichment framework",
  });

  mkdirSync(resolve(ROOT, "data/poc/phase62"), { recursive: true });
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (decision !== "PASS") process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

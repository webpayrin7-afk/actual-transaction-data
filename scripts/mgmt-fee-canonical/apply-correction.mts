/**
 * Apply the approved 54-row correction in one Production transaction.
 * Does not call the fee API. Refuses to write unless the live rows match
 * the approved manifest byte for byte.
 *
 *   npx tsx scripts/mgmt-fee-canonical/apply-correction.mts
 *   npx tsx scripts/mgmt-fee-canonical/apply-correction.mts --commit
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient, type Client, type Transaction } from "@libsql/client";
import {
  SNAPSHOT_KEYS,
  assertPlanGuards,
  rowKey,
  rowsEqual,
  sha256,
  type CorrectionEntry,
  type CorrectionManifest,
  type FeeRowSnapshot,
  type RollbackManifest,
} from "./correction-plan";

const APPROVED_CORRECTION_HASH = "11c2cc91834f1a406d8ff86d511aeaa0867d9cb48cf6bf822f50043fd2314e96";
const APPROVED_ROLLBACK_HASH = "3f0e9b9a28c14705892e4e28d231a76f1d1eb5877477758d8ff92bc9bab69d95";
const EXPECTED_STORED_TOTAL = 192226996611;
const DELETE_KEYS = [
  "cx_4c63d9a100973c60|202608",
  "cx_4c63d9a100973c60|202609",
] as const;

const ROOT = resolve(import.meta.dirname, "../..");
const DIR = resolve(ROOT, "data/poc/mgmt-fee-canonical");
const RESULT_PATH = resolve(DIR, "correction-apply-result.json");

const NUMERIC_KEYS = new Set<string>([
  "common_fee",
  "individual_fee",
  "long_term_repair_reserve",
  "total_fee",
  "per_area_common_fee",
  "per_area_total_fee",
  "area_basis_sqm",
  "household_basis",
  "per_area_individual_fee",
  "per_area_reserve_fee",
]);

type ApplyStatus = "PASS" | "ROLLED_BACK" | "BLOCKED";

function selectSql(): string {
  return `SELECT ${SNAPSHOT_KEYS.join(", ")} FROM apt_complex_mgmt_fee_monthly`;
}

function whereSql(): string {
  return SNAPSHOT_KEYS.map((key) => `${key} IS ?`).join(" AND ");
}

function whereArgs(row: FeeRowSnapshot): unknown[] {
  return SNAPSHOT_KEYS.map((key) => row[key]);
}

function normalizeRow(raw: Record<string, unknown>): FeeRowSnapshot {
  const row = {} as FeeRowSnapshot;
  for (const key of SNAPSHOT_KEYS) {
    const value = raw[key];
    if (value == null) {
      row[key] = null as never;
      continue;
    }
    if (NUMERIC_KEYS.has(key)) {
      const number = typeof value === "bigint" ? Number(value) : Number(value);
      if (!Number.isFinite(number)) throw new Error(`non numeric ${key}`);
      row[key] = number as never;
    } else {
      row[key] = String(value) as never;
    }
  }
  return row;
}

function indexRows(rows: readonly FeeRowSnapshot[]): Map<string, FeeRowSnapshot> {
  const map = new Map<string, FeeRowSnapshot>();
  for (const row of rows) {
    const key = rowKey(row.complex_id, row.period_yyyymm);
    if (map.has(key)) throw new Error(`duplicate live key ${key}`);
    map.set(key, row);
  }
  return map;
}

function loadManifests(): { correction: CorrectionManifest; rollback: RollbackManifest; exactKeys: Set<string> } {
  const correction = JSON.parse(readFileSync(resolve(DIR, "correction-manifest.json"), "utf8")) as CorrectionManifest;
  const rollback = JSON.parse(readFileSync(resolve(DIR, "rollback-manifest.json"), "utf8")) as RollbackManifest;
  const report = JSON.parse(readFileSync(resolve(DIR, "reconciliation-report.json"), "utf8")) as {
    rows_detail: Array<{ complex_id: string; period_yyyymm: string; classification: string }>;
  };
  assertPlanGuards(correction);
  if (correction.hash !== APPROVED_CORRECTION_HASH) throw new Error("correction hash is not the approved hash");
  if (rollback.hash !== APPROVED_ROLLBACK_HASH || rollback.hash !== sha256(rollback.entries)) {
    throw new Error("rollback hash is not the approved hash");
  }
  const exactKeys = new Set(
    report.rows_detail
      .filter((row) => row.classification === "EXACT_MATCH")
      .map((row) => rowKey(row.complex_id, row.period_yyyymm)),
  );
  return { correction, rollback, exactKeys };
}

function precheck(args: {
  correction: CorrectionManifest;
  exactKeys: Set<string>;
  live: Map<string, FeeRowSnapshot>;
}): string[] {
  const failures: string[] = [];
  const updates = args.correction.entries.filter((entry) => entry.action === "UPDATE");
  const deletes = args.correction.entries.filter((entry) => entry.action === "DELETE");
  const inserts = args.correction.entries.filter((entry) => entry.action !== "UPDATE" && entry.action !== "DELETE");
  if (args.correction.summary.total !== 54) failures.push(`candidate total ${args.correction.summary.total}`);
  if (updates.length !== 52) failures.push(`UPDATE ${updates.length}`);
  if (deletes.length !== 2) failures.push(`DELETE ${deletes.length}`);
  if (inserts.length !== 0) failures.push(`INSERT ${inserts.length}`);
  if (args.exactKeys.size !== 72) failures.push(`EXACT_MATCH ${args.exactKeys.size}`);
  const candidateKeys = new Set(args.correction.entries.map((entry) => rowKey(entry.complex_id, entry.period_yyyymm)));
  if (candidateKeys.size !== 54) failures.push(`candidate keys ${candidateKeys.size}`);
  const deleteKeys = deletes.map((entry) => rowKey(entry.complex_id, entry.period_yyyymm)).sort();
  if (deleteKeys.join(",") !== [...DELETE_KEYS].sort().join(",")) failures.push("delete keys are not 잠실엘스 202608/202609");
  for (const key of args.exactKeys) {
    if (candidateKeys.has(key)) failures.push(`exact row targeted ${key}`);
    if (!args.live.has(key)) failures.push(`exact row missing ${key}`);
  }
  const unclassified = [...args.live.keys()].filter((key) => !candidateKeys.has(key) && !args.exactKeys.has(key));
  if (unclassified.length > 0) failures.push(`unclassified live rows ${unclassified.length}`);
  if (args.live.size !== 126) failures.push(`live rows ${args.live.size}`);
  const complexes = new Set([...args.live.values()].map((row) => row.complex_id));
  if (complexes.size !== 11) failures.push(`live complexes ${complexes.size}`);
  for (const entry of args.correction.entries) {
    const key = rowKey(entry.complex_id, entry.period_yyyymm);
    const current = args.live.get(key);
    if (!current) {
      failures.push(`missing live row ${key}`);
      continue;
    }
    if (!rowsEqual(current, entry.before)) {
      const fields = SNAPSHOT_KEYS.filter((field) => current[field] !== entry.before[field]);
      failures.push(`before drift ${key} ${fields.join(",")}`);
    }
    if (entry.action === "UPDATE") {
      if (!entry.after) failures.push(`update without after ${key}`);
      else {
        for (const field of SNAPSHOT_KEYS) {
          if (field === "total_fee" || field === "updated_at") continue;
          if (entry.after[field] !== entry.before[field]) failures.push(`plan mutates ${field} ${key}`);
        }
        if (entry.after.source !== "MOLIT_KAPT_FEE_V3" || entry.after.amount_basis !== "complex_month_total_krw") {
          failures.push(`label drift ${key}`);
        }
        if (entry.after.total_fee !== entry.canonical_amount) failures.push(`canonical mismatch ${key}`);
      }
    }
  }
  return failures;
}

function updateStatement(entry: CorrectionEntry): { sql: string; args: unknown[] } {
  if (entry.action !== "UPDATE" || !entry.after) throw new Error("not an update");
  return {
    sql: `UPDATE apt_complex_mgmt_fee_monthly SET total_fee = ?, updated_at = ? WHERE ${whereSql()}`,
    args: [entry.after.total_fee, entry.after.updated_at, ...whereArgs(entry.before)],
  };
}

function deleteStatement(entry: CorrectionEntry): { sql: string; args: unknown[] } {
  if (entry.action !== "DELETE") throw new Error("not a delete");
  return {
    sql: `DELETE FROM apt_complex_mgmt_fee_monthly WHERE ${whereSql()}`,
    args: whereArgs(entry.before),
  };
}

function validateAfter(args: {
  correction: CorrectionManifest;
  exactKeys: Set<string>;
  before: Map<string, FeeRowSnapshot>;
  after: Map<string, FeeRowSnapshot>;
}): string[] {
  const failures: string[] = [];
  if (args.after.size !== 124) failures.push(`rows ${args.after.size}`);
  const complexes = new Set([...args.after.values()].map((row) => row.complex_id));
  if (complexes.size !== 11) failures.push(`complexes ${complexes.size}`);
  if ([...args.after.keys()].length !== args.after.size) failures.push("duplicate keys");
  let exactUnchanged = 0;
  for (const key of args.exactKeys) {
    const left = args.before.get(key);
    const right = args.after.get(key);
    if (!left || !right || !rowsEqual(left, right)) failures.push(`exact changed ${key}`);
    else if (right.source !== "MOLIT_PORTAL_OPENAPI" || right.amount_basis !== "portal_operation_sum_krw") {
      failures.push(`portal label changed ${key}`);
    } else exactUnchanged += 1;
  }
  if (exactUnchanged !== 72) failures.push(`exact unchanged ${exactUnchanged}`);
  let updated = 0;
  let undercount = 0;
  for (const entry of args.correction.entries) {
    const key = rowKey(entry.complex_id, entry.period_yyyymm);
    if (entry.action === "DELETE") {
      if (args.after.has(key)) failures.push(`deleted row still present ${key}`);
      continue;
    }
    const current = args.after.get(key);
    if (!current || !entry.after) {
      failures.push(`updated row missing ${key}`);
      continue;
    }
    if (!rowsEqual(current, entry.after)) {
      const fields = SNAPSHOT_KEYS.filter((field) => current[field] !== entry.after?.[field]);
      failures.push(`update result drift ${key} ${fields.join(",")}`);
    }
    if (current.source !== "MOLIT_KAPT_FEE_V3" || current.amount_basis !== "complex_month_total_krw") {
      failures.push(`corrected label ${key}`);
    }
    if (current.total_fee !== entry.canonical_amount) undercount += 1;
    else updated += 1;
  }
  if (updated !== 52) failures.push(`corrected ${updated}`);
  if (undercount !== 0) failures.push(`undercount remaining ${undercount}`);
  const zeroMissing = [...args.after.values()].filter((row) => row.total_fee === 0).length;
  if (zeroMissing !== 0) failures.push(`stored zero remaining ${zeroMissing}`);
  let total = 0;
  for (const row of args.after.values()) total += row.total_fee ?? 0;
  if (total !== EXPECTED_STORED_TOTAL) failures.push(`total amount ${total}`);
  return failures;
}

async function readRows(db: Client | Transaction): Promise<FeeRowSnapshot[]> {
  const result = await db.execute(selectSql());
  return result.rows.map((row) => normalizeRow(row as unknown as Record<string, unknown>));
}

async function applyRollback(
  db: Client,
  correction: CorrectionManifest,
  rollback: RollbackManifest,
): Promise<number> {
  const byKey = new Map(correction.entries.map((entry) => [rowKey(entry.complex_id, entry.period_yyyymm), entry]));
  const tx = await db.transaction("write");
  let affected = 0;
  try {
    for (const entry of rollback.entries) {
      const key = rowKey(entry.complex_id, entry.period_yyyymm);
      let result;
      if (entry.action === "INSERT") {
        result = await tx.execute({
          sql: `INSERT INTO apt_complex_mgmt_fee_monthly (${SNAPSHOT_KEYS.join(", ")}) VALUES (${SNAPSHOT_KEYS.map(() => "?").join(", ")})`,
          args: whereArgs(entry.restores),
        });
      } else if (entry.action === "UPDATE") {
        const applied = byKey.get(key);
        if (!applied?.after) throw new Error(`rollback update missing after ${key}`);
        result = await tx.execute({
          sql: `UPDATE apt_complex_mgmt_fee_monthly SET total_fee = ?, updated_at = ? WHERE ${whereSql()}`,
          args: [entry.restores.total_fee, entry.restores.updated_at, ...whereArgs(applied.after)],
        });
      } else {
        throw new Error(`rollback action ${entry.action}`);
      }
      if (Number(result.rowsAffected) !== 1) throw new Error(`rollback affected ${key} ${result.rowsAffected}`);
      affected += 1;
    }
    if (affected !== 54) throw new Error(`rollback affected ${affected}`);
    await tx.commit();
    return affected;
  } catch (error) {
    await tx.rollback().catch(() => undefined);
    throw error;
  } finally {
    tx.close();
  }
}

function writeResult(body: Record<string, unknown>): void {
  writeFileSync(RESULT_PATH, `${JSON.stringify(body, null, 2)}\n`);
}

async function main(): Promise<void> {
  const commit = process.argv.includes("--commit");
  const { correction, rollback, exactKeys } = loadManifests();
  const url = process.env.TURSO_DATABASE_URL?.trim();
  const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
  if (!url || !authToken) throw new Error("Turso env missing");
  const db = createClient({ url, authToken });
  const beforeRows = await readRows(db);
  const before = indexRows(beforeRows);
  const failures = precheck({ correction, exactKeys, live: before });
  if (failures.length > 0) {
    writeResult({
      status: "BLOCKED",
      precheck_failures: failures,
      production_write: false,
      api_calls: 0,
    });
    console.log(JSON.stringify({ status: "BLOCKED", failures }));
    process.exit(2);
  }
  if (!commit) {
    console.log(JSON.stringify({ status: "PRECHECK_OK", candidates: 54, updates: 52, deletes: 2, inserts: 0 }));
    return;
  }

  const tx = await db.transaction("write");
  let affected = 0;
  try {
    const locked = indexRows(await readRows(tx));
    const lockedFailures = precheck({ correction, exactKeys, live: locked });
    if (lockedFailures.length > 0) throw new Error(`precheck inside transaction: ${lockedFailures.join("; ")}`);
    for (const entry of correction.entries) {
      const statement = entry.action === "DELETE" ? deleteStatement(entry) : updateStatement(entry);
      if (/\binsert\b/i.test(statement.sql)) throw new Error("insert forbidden");
      const result = await tx.execute(statement);
      if (Number(result.rowsAffected) !== 1) {
        throw new Error(`affected ${rowKey(entry.complex_id, entry.period_yyyymm)} ${result.rowsAffected}`);
      }
      affected += 1;
    }
    if (affected !== 54) throw new Error(`affected ${affected}`);
    const after = indexRows(await readRows(tx));
    const postFailures = validateAfter({ correction, exactKeys, before: locked, after });
    if (postFailures.length > 0) throw new Error(`post-write: ${postFailures.join("; ")}`);
    await tx.commit();
  } catch (error) {
    await tx.rollback().catch(() => undefined);
    tx.close();
    const message = error instanceof Error ? error.message : "apply failed";
    const blocked = message.startsWith("precheck inside transaction");
    writeResult({
      status: blocked ? "BLOCKED" : "ROLLED_BACK",
      reason: message,
      rollback_executed: true,
      affected_before_rollback: affected,
      production_write: false,
      api_calls: 0,
    });
    console.log(JSON.stringify({ status: blocked ? "BLOCKED" : "ROLLED_BACK", reason: message, affected }));
    process.exit(blocked ? 2 : 3);
  }
  try {
    tx.close();
  } catch {
    // The commit already succeeded. Closing the handle must not hide that.
  }

  const committed = indexRows(await readRows(db));
  const post = validateAfter({ correction, exactKeys, before, after: committed });
  if (post.length > 0) {
    let rollbackAffected = 0;
    let rollbackError: string | null = null;
    try {
      rollbackAffected = await applyRollback(db, correction, rollback);
    } catch (error) {
      rollbackError = error instanceof Error ? error.message : "rollback failed";
    }
    const restored = await readRows(db);
    writeResult({
      status: "ROLLED_BACK",
      reason: post.join("; "),
      rollback_affected: rollbackAffected,
      rollback_error: rollbackError,
      restored_rows: restored.length,
      production_write: true,
      api_calls: 0,
    });
    console.log(JSON.stringify({ status: "ROLLED_BACK", post, rollbackAffected, rollbackError, restored_rows: restored.length }));
    process.exit(3);
  }

  let total = 0;
  for (const row of committed.values()) total += row.total_fee ?? 0;
  writeResult({
    status: "PASS",
    rows: committed.size,
    complexes: new Set([...committed.values()].map((row) => row.complex_id)).size,
    updates: 52,
    deletes: 2,
    inserts: 0,
    affected: 54,
    exact_unchanged: 72,
    undercount_remaining: 0,
    missing_zero_remaining: 0,
    duplicate_keys: 0,
    total_amount: total,
    correction_hash: APPROVED_CORRECTION_HASH,
    rollback_hash: APPROVED_ROLLBACK_HASH,
    rollback_executed: false,
    production_write: true,
    api_calls: 0,
  });
  console.log(JSON.stringify({ status: "PASS", rows: committed.size, total_amount: total, affected: 54 }));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "apply failed");
  process.exit(1);
});

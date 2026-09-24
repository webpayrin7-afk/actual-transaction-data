/**
 * Production INSERT of the verified Busan/Gyeongnam wave-6 COMPLETE months.
 * Rebuilds the 182 rows from the committed wave-6 checkpoint. Does not call the fee API.
 * A second --commit of the same artifact is a no-op when every stored row already matches.
 *
 *   npx tsx scripts/mgmt-fee-canonical/apply-busan-gyeongnam-wave6.mts
 *   npx tsx scripts/mgmt-fee-canonical/apply-busan-gyeongnam-wave6.mts --commit
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient, type Client, type Transaction } from "@libsql/client";
import { classifyFeeMonth } from "./classify";
import { buildProbePeriods, choosePublishedPeriod } from "./national-inventory";
import { REFERENCE_CATALOG, REFERENCE_OP_NAMES } from "./op-catalog";
import { OpCheckpointStore } from "./op-checkpoint";
import {
  SNAPSHOT_KEYS,
  rowKey,
  rowsEqual,
  type FeeRowSnapshot,
} from "./correction-plan";
import { CANONICAL_AMOUNT_BASIS, CANONICAL_SOURCE } from "./types";

const CHECKPOINT_SHA256 = "c8a9e35d96177410b6ae290db8a4faea40dec1d05531b80e4d8efe17981563e9";
const DRYRUN_SHA256 = "3f4d911cbca6e5a2f1acd9a9f0c277deec4189995811c6ea5eab5e7d108d4b1e";
const EXPECTED_BEFORE_ROWS = 781;
const EXPECTED_BEFORE_COMPLEXES = 668;
const EXPECTED_AFTER_ROWS = 963;
const EXPECTED_AFTER_COMPLEXES = 850;
const PROBE_OP = "getHsmpCleaningCostInfoV3";
const PROBE_SERVICE = "common";

const DIR = resolve(import.meta.dirname, "../../data/poc/mgmt-fee-canonical");
const CHECKPOINT_PATH = resolve(DIR, "busan-gyeongnam-wave6-op-checkpoint.json");
const DRYRUN_PATH = resolve(DIR, "busan-gyeongnam-wave6-dryrun.json");
const RESULT_PATH = resolve(DIR, "busan-gyeongnam-wave6-apply-result.json");

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

type InsertPlan = {
  complex_id: string;
  sido_code: "26" | "48";
  sido: string;
  period_yyyymm: string;
  common_fee: number;
  individual_fee: number;
  long_term_repair_reserve: number;
  total_fee: number;
};

type ArtifactSample = {
  complex_id: string;
  sido_code: string;
  period: string;
  status: string;
  amount: number;
  would: string;
};

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function isExplicitKrw(amount: number | null | undefined): amount is number {
  return typeof amount === "number" && Number.isSafeInteger(amount);
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

async function readRows(db: Client | Transaction): Promise<FeeRowSnapshot[]> {
  const result = await db.execute(`SELECT ${SNAPSHOT_KEYS.join(", ")} FROM apt_complex_mgmt_fee_monthly`);
  const rows = result.rows.map((row) => normalizeRow(row as Record<string, unknown>));
  const seen = new Set<string>();
  for (const row of rows) {
    const key = rowKey(row.complex_id, row.period_yyyymm);
    if (seen.has(key)) throw new Error(`duplicate live key ${key}`);
    seen.add(key);
  }
  return rows;
}

function identityHash(rows: readonly FeeRowSnapshot[]): string {
  const lines = rows
    .map((row) => SNAPSHOT_KEYS.map((key) => `${key}=${row[key] ?? ""}`).join("|"))
    .sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

function indexRows(rows: readonly FeeRowSnapshot[]): Map<string, FeeRowSnapshot> {
  return new Map(rows.map((row) => [rowKey(row.complex_id, row.period_yyyymm), row]));
}

function rebuildPlans(store: OpCheckpointStore): { plans: InsertPlan[]; unpublished: string[] } {
  const periods = buildProbePeriods("202609", 3);
  const complexes = [...new Set(store.list().map((record) => record.complex_id))].sort();
  const plans: InsertPlan[] = [];
  const unpublished: string[] = [];
  for (const complex_id of complexes) {
    const probes = periods.map((period) => {
      const cached = store.get(complex_id, period, PROBE_SERVICE, PROBE_OP);
      return {
        period,
        published: cached?.status === "success" && (cached.amount ?? 0) > 0,
      };
    });
    const period = choosePublishedPeriod(probes);
    if (!period) {
      unpublished.push(complex_id);
      continue;
    }
    const observations = REFERENCE_OP_NAMES.map((op) => {
      const catalog = REFERENCE_CATALOG.find((row) => row.op === op);
      if (!catalog) throw new Error(`catalog missing ${op}`);
      const record = store.get(complex_id, period, catalog.service, op);
      if (!record || record.status === "missing") return { op, state: "missing" as const, amount: null };
      if (record.status === "failed") return { op, state: "failed" as const, amount: null, error: record.error };
      return { op, state: "success" as const, amount: record.amount };
    });
    const classified = classifyFeeMonth({
      complex_id,
      period_yyyymm: period,
      expectedOps: REFERENCE_OP_NAMES,
      observations,
      source: CANONICAL_SOURCE,
      amount_basis: CANONICAL_AMOUNT_BASIS,
    });
    if (classified.checkpoint_status !== "COMPLETE" || classified.amount == null || !classified.result) {
      throw new Error(`published month is not COMPLETE ${complex_id} ${period} ${classified.checkpoint_status}`);
    }
    const sums = { common: 0, individual: 0, reserve: 0 };
    for (const catalog of REFERENCE_CATALOG) {
      const record = store.get(complex_id, period, catalog.service, catalog.op);
      if (!record || record.status !== "success" || !isExplicitKrw(record.amount)) {
        throw new Error(`uncertain component ${complex_id} ${period} ${catalog.service} ${catalog.op}`);
      }
      sums[catalog.service] += record.amount;
    }
    if (sums.common + sums.individual + sums.reserve !== classified.amount) {
      throw new Error(`component sum diverges ${complex_id} ${period}`);
    }
    if (!isExplicitKrw(classified.amount)) {
      throw new Error(`canonical amount not an integer ${complex_id} ${period}`);
    }
    plans.push({
      complex_id,
      sido_code: "26",
      sido: "",
      period_yyyymm: period,
      common_fee: sums.common,
      individual_fee: sums.individual,
      long_term_repair_reserve: sums.reserve,
      total_fee: classified.amount,
    });
  }
  return { plans, unpublished };
}

function expectedSnapshot(plan: InsertPlan, updatedAt: string): FeeRowSnapshot {
  return {
    complex_id: plan.complex_id,
    period_yyyymm: plan.period_yyyymm,
    common_fee: plan.common_fee,
    individual_fee: plan.individual_fee,
    long_term_repair_reserve: plan.long_term_repair_reserve,
    total_fee: plan.total_fee,
    per_area_common_fee: null,
    per_area_total_fee: null,
    area_basis_sqm: null,
    household_basis: null,
    amount_basis: CANONICAL_AMOUNT_BASIS,
    source: CANONICAL_SOURCE,
    source_version: null,
    updated_at: updatedAt,
    per_area_individual_fee: null,
    per_area_reserve_fee: null,
    area_basis: null,
    fee_status: null,
  };
}

const INSERT_SQL = `
INSERT INTO apt_complex_mgmt_fee_monthly (
  complex_id, period_yyyymm, common_fee, individual_fee, long_term_repair_reserve,
  total_fee, per_area_common_fee, per_area_total_fee, area_basis_sqm,
  household_basis, amount_basis, source, source_version, updated_at
) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, NULL, ?)
`.trim();

function insertArgs(plan: InsertPlan, updatedAt: string): unknown[] {
  return [
    plan.complex_id,
    plan.period_yyyymm,
    plan.common_fee,
    plan.individual_fee,
    plan.long_term_repair_reserve,
    plan.total_fee,
    CANONICAL_AMOUNT_BASIS,
    CANONICAL_SOURCE,
    updatedAt,
  ];
}

function periodCounts(plans: readonly InsertPlan[]): Record<string, number> {
  return {
    "202607": plans.filter((plan) => plan.period_yyyymm === "202607").length,
    "202608": plans.filter((plan) => plan.period_yyyymm === "202608").length,
    "202609": plans.filter((plan) => plan.period_yyyymm === "202609").length,
  };
}

function writeResult(body: Record<string, unknown>): void {
  writeFileSync(RESULT_PATH, `${JSON.stringify(body, null, 2)}\n`);
}

async function rollbackInserted(
  db: Client,
  plans: readonly InsertPlan[],
  updatedAt: string,
  originalKeys: ReadonlySet<string>,
  originalHash: string,
): Promise<void> {
  const tx = await db.transaction("write");
  try {
    let affected = 0;
    for (const plan of plans) {
      const result = await tx.execute({
        sql: `DELETE FROM apt_complex_mgmt_fee_monthly
              WHERE complex_id = ? AND period_yyyymm = ? AND total_fee = ?
                AND source = ? AND amount_basis = ? AND updated_at = ?`,
        args: [plan.complex_id, plan.period_yyyymm, plan.total_fee, CANONICAL_SOURCE, CANONICAL_AMOUNT_BASIS, updatedAt],
      });
      if (Number(result.rowsAffected) !== 1) {
        throw new Error(`rollback affected ${plan.complex_id} ${result.rowsAffected}`);
      }
      affected += 1;
    }
    if (affected !== plans.length) throw new Error(`rollback affected ${affected}`);
    const restored = await readRows(tx);
    if (restored.length !== originalKeys.size || identityHash(restored) !== originalHash) {
      throw new Error("rollback did not restore the existing rows");
    }
    await tx.commit();
  } catch (error) {
    await tx.rollback().catch(() => undefined);
    throw error;
  } finally {
    tx.close();
  }
}

async function applySido(
  db: Client,
  plans: readonly InsertPlan[],
  updatedAt: string,
  originalKeys: ReadonlySet<string>,
  originalHash: string,
): Promise<void> {
  const tx = await db.transaction("write");
  try {
    const locked = await readRows(tx);
    const lockedIndex = indexRows(locked);
    const originalRows = locked.filter((row) => originalKeys.has(rowKey(row.complex_id, row.period_yyyymm)));
    if (originalRows.length !== originalKeys.size || identityHash(originalRows) !== originalHash) {
      throw new Error("existing rows changed inside transaction");
    }
    for (const plan of plans) {
      if (lockedIndex.has(rowKey(plan.complex_id, plan.period_yyyymm))) {
        throw new Error(`collision ${plan.complex_id} ${plan.period_yyyymm}`);
      }
    }
    let affected = 0;
    for (const plan of plans) {
      const result = await tx.execute({ sql: INSERT_SQL, args: insertArgs(plan, updatedAt) });
      if (Number(result.rowsAffected) !== 1) {
        throw new Error(`affected ${plan.complex_id} ${plan.period_yyyymm} ${result.rowsAffected}`);
      }
      affected += 1;
    }
    if (affected !== plans.length) throw new Error(`affected ${affected} expected ${plans.length}`);
    const after = await readRows(tx);
    const afterIndex = indexRows(after);
    if (after.length !== locked.length + plans.length) throw new Error(`row count ${after.length}`);
    const still = after.filter((row) => originalKeys.has(rowKey(row.complex_id, row.period_yyyymm)));
    if (identityHash(still) !== originalHash) throw new Error("existing rows changed by insert");
    for (const plan of plans) {
      const stored = afterIndex.get(rowKey(plan.complex_id, plan.period_yyyymm));
      if (!stored || !rowsEqual(stored, expectedSnapshot(plan, updatedAt))) {
        throw new Error(`stored row mismatch ${plan.complex_id} ${plan.period_yyyymm}`);
      }
    }
    await tx.commit();
  } catch (error) {
    await tx.rollback().catch(() => undefined);
    throw error;
  } finally {
    tx.close();
  }
}

async function main(): Promise<void> {
  const commit = process.argv.includes("--commit");
  const failures: string[] = [];
  if (sha256File(CHECKPOINT_PATH) !== CHECKPOINT_SHA256) failures.push("checkpoint hash");
  if (sha256File(DRYRUN_PATH) !== DRYRUN_SHA256) failures.push("dry-run hash");
  const artifact = JSON.parse(readFileSync(DRYRUN_PATH, "utf8")) as {
    production_write: boolean;
    api_calls: number;
    reuse_confirmation_api_calls: number;
    http_429: boolean;
    target_months: number;
    no_published_month: number;
    by_sido: Array<{ sido_code: string; targets: number; COMPLETE: number; would_insert: number; would_update: number; PARTIAL: number; MISSING: number; FAILED: number }>;
    periods: string[];
    totals: { COMPLETE: number; PARTIAL: number; MISSING: number; FAILED: number; would_insert: number; would_update: number };
    samples: ArtifactSample[];
  };
  if (artifact.production_write !== false) failures.push("artifact already marked written");
  if (artifact.api_calls !== 1496 || artifact.reuse_confirmation_api_calls !== 0 || artifact.http_429 !== false) {
    failures.push("artifact api guard");
  }
  if (artifact.target_months !== 182 || artifact.no_published_month !== 18) failures.push("artifact target counts");
  if (artifact.totals.COMPLETE !== 182 || artifact.totals.would_insert !== 182 || artifact.totals.would_update !== 0) {
    failures.push("artifact totals");
  }
  const artifactBusan = artifact.by_sido.find((row) => row.sido_code === "26");
  const artifactGyeongnam = artifact.by_sido.find((row) => row.sido_code === "48");
  if (
    !artifactBusan ||
    artifactBusan.targets !== 93 ||
    artifactBusan.COMPLETE !== 93 ||
    artifactBusan.would_insert !== 93 ||
    artifactBusan.would_update !== 0 ||
    artifactBusan.PARTIAL !== 0 ||
    artifactBusan.MISSING !== 0 ||
    artifactBusan.FAILED !== 0
  ) {
    failures.push("artifact busan");
  }
  if (
    !artifactGyeongnam ||
    artifactGyeongnam.targets !== 89 ||
    artifactGyeongnam.COMPLETE !== 89 ||
    artifactGyeongnam.would_insert !== 89 ||
    artifactGyeongnam.would_update !== 0
  ) {
    failures.push("artifact gyeongnam");
  }
  if (artifact.totals.PARTIAL !== 0 || artifact.totals.MISSING !== 0 || artifact.totals.FAILED !== 0) {
    failures.push("artifact non-complete");
  }

  const store = OpCheckpointStore.parse(readFileSync(CHECKPOINT_PATH, "utf8"));
  const records = store.list();
  if (records.length !== 5514) failures.push(`checkpoint records ${records.length}`);
  if (records.some((record) => record.http !== 200 || record.status === "failed")) failures.push("checkpoint failed or non-200");
  const outside = new Set(records.map((record) => record.period).filter((period) => !["202607", "202608", "202609"].includes(period)));
  if (outside.size > 0) failures.push("checkpoint period outside artifact");

  let plans: InsertPlan[] = [];
  let unpublished: string[] = [];
  try {
    const rebuilt = rebuildPlans(store);
    plans = rebuilt.plans;
    unpublished = rebuilt.unpublished;
  } catch (error) {
    failures.push(error instanceof Error ? error.message : "rebuild failed");
  }
  if (plans.length !== 182 || unpublished.length !== 18) {
    failures.push(`rebuilt plans ${plans.length} unpublished ${unpublished.length}`);
  }
  const planKeys = new Set(plans.map((plan) => rowKey(plan.complex_id, plan.period_yyyymm)));
  if (planKeys.size !== plans.length) failures.push("duplicate plan key");
  if (plans.some((plan) => unpublished.includes(plan.complex_id))) failures.push("unpublished included");

  const url = process.env.TURSO_DATABASE_URL?.trim();
  const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
  if (!url || !authToken) throw new Error("Turso env missing");
  const db = createClient({ url, authToken });

  const info = await db.execute("PRAGMA table_info(apt_complex_mgmt_fee_monthly)");
  const columns = info.rows.map((row) => ({
    name: String(row.name),
    notnull: Number(row.notnull),
    dflt: row.dflt_value,
  }));
  const required = columns.filter((column) => column.notnull === 1 && column.dflt == null).map((column) => column.name);
  const provided = new Set(["complex_id", "period_yyyymm", "common_fee", "individual_fee", "long_term_repair_reserve", "total_fee", "amount_basis", "source", "updated_at"]);
  for (const name of required) {
    if (!provided.has(name)) failures.push(`NOT NULL column unset ${name}`);
  }
  const triggers = await db.execute({
    sql: "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?",
    args: ["apt_complex_mgmt_fee_monthly"],
  });
  if (triggers.rows.length > 0) failures.push("fee table trigger present");

  const before = await readRows(db);
  const beforeIndex = indexRows(before);
  const beforeComplexes = new Set(before.map((row) => row.complex_id)).size;
  const nonPlanRows = before.filter((row) => !planKeys.has(rowKey(row.complex_id, row.period_yyyymm)));
  const payloadMatch =
    plans.length === 182 &&
    plans.every((plan) => {
      const stored = beforeIndex.get(rowKey(plan.complex_id, plan.period_yyyymm));
      return stored != null && rowsEqual(stored, expectedSnapshot(plan, stored.updated_at));
    });
  const alreadyApplied =
    payloadMatch &&
    before.length === EXPECTED_AFTER_ROWS &&
    beforeComplexes === EXPECTED_AFTER_COMPLEXES &&
    nonPlanRows.length === EXPECTED_BEFORE_ROWS &&
    new Set(nonPlanRows.map((row) => row.complex_id)).size === EXPECTED_BEFORE_COMPLEXES;
  let originalHash: string;
  let originalKeys: Set<string>;
  if (alreadyApplied) {
    originalHash = identityHash(nonPlanRows);
    originalKeys = new Set(nonPlanRows.map((row) => rowKey(row.complex_id, row.period_yyyymm)));
    if (existsSync(RESULT_PATH)) {
      const priorResult = JSON.parse(readFileSync(RESULT_PATH, "utf8")) as { existing_row_hash?: string };
      if (priorResult.existing_row_hash && priorResult.existing_row_hash !== originalHash) {
        failures.push("existing rows changed");
      }
    }
  } else {
    if (before.length !== EXPECTED_BEFORE_ROWS) failures.push(`existing rows ${before.length}`);
    if (beforeComplexes !== EXPECTED_BEFORE_COMPLEXES) failures.push(`existing complexes ${beforeComplexes}`);
    originalHash = identityHash(before);
    originalKeys = new Set(beforeIndex.keys());
  }

  if (plans.length > 0) {
    const ids = plans.map((plan) => plan.complex_id).concat(unpublished);
    const placeholders = ids.map(() => "?").join(", ");
    const masters = await db.execute({
      sql: `SELECT complex_id, sido, sido_code FROM apt_complex_master WHERE complex_id IN (${placeholders})`,
      args: ids,
    });
    const byId = new Map(masters.rows.map((row) => [String(row.complex_id), row]));
    if (byId.size !== ids.length) failures.push(`master rows ${byId.size} expected ${ids.length}`);
    for (const plan of plans) {
      const master = byId.get(plan.complex_id);
      const code = master ? String(master.sido_code) : "";
      if (code !== "26" && code !== "48") {
        failures.push(`sido ${plan.complex_id} ${code}`);
        continue;
      }
      plan.sido_code = code;
      plan.sido = master?.sido == null ? "" : String(master.sido);
    }
    for (const id of unpublished) {
      const code = byId.get(id) ? String(byId.get(id)!.sido_code) : "";
      if (code !== "26" && code !== "48") failures.push(`unpublished sido ${code}`);
    }
  }

  const busan = plans.filter((plan) => plan.sido_code === "26");
  const gyeongnam = plans.filter((plan) => plan.sido_code === "48");
  if (plans.length === 182 && (busan.length !== 93 || gyeongnam.length !== 89)) {
    failures.push(`sido split busan ${busan.length} gyeongnam ${gyeongnam.length}`);
  }
  if (before.some((row) => unpublished.includes(row.complex_id))) failures.push("unpublished already stored");
  const collisions = plans.filter((plan) => beforeIndex.has(rowKey(plan.complex_id, plan.period_yyyymm)));
  if (!alreadyApplied && collisions.length > 0) {
    const differs = collisions.some((plan) => {
      const stored = beforeIndex.get(rowKey(plan.complex_id, plan.period_yyyymm));
      return stored == null || !rowsEqual(stored, expectedSnapshot(plan, stored.updated_at));
    });
    failures.push(differs ? `collision differs ${collisions.length}` : `collisions ${collisions.length}`);
  }

  const samplePlans = busan.slice().sort((left, right) => left.complex_id.localeCompare(right.complex_id)).slice(0, 10);
  if (artifact.samples.length === 10 && samplePlans.length === 10) {
    for (let index = 0; index < 10; index += 1) {
      const sample = artifact.samples[index]!;
      const plan = samplePlans[index]!;
      if (
        sample.complex_id !== plan.complex_id ||
        sample.period !== plan.period_yyyymm ||
        sample.amount !== plan.total_fee ||
        sample.status !== "COMPLETE" ||
        sample.would !== "insert" ||
        sample.sido_code !== "26"
      ) {
        failures.push(`sample ${index} mismatch`);
      }
    }
  } else if (plans.length > 0) {
    failures.push("sample length");
  }

  const periods = periodCounts(plans);
  const canonicalTotal = plans.reduce((sum, plan) => sum + plan.total_fee, 0);
  if (failures.length > 0) {
    if (!existsSync(RESULT_PATH)) {
      writeResult({
        status: "BLOCKED",
        precheck_failures: failures,
        production_write: false,
        api_calls: 0,
        rollback_executed: false,
      });
    }
    console.log(JSON.stringify({ status: "BLOCKED", failures, api_calls: 0 }));
    process.exit(2);
  }

  if (alreadyApplied) {
    console.log(JSON.stringify({
      status: "IDEMPOTENT_NOOP",
      inserted: 0,
      updated: 0,
      deleted: 0,
      rows: before.length,
      complexes: beforeComplexes,
      api_calls: 0,
    }));
    return;
  }

  const summary = {
    busan: busan.length,
    gyeongnam: gyeongnam.length,
    total: plans.length,
    unpublished: unpublished.length,
    collisions: 0,
    periods,
    canonical_total: canonicalTotal,
    existing_rows: before.length,
    existing_complexes: beforeComplexes,
  };
  if (!commit) {
    console.log(JSON.stringify({ status: "PRECHECK_OK", ...summary, api_calls: 0 }));
    return;
  }

  const updatedAt = new Date().toISOString();
  let insertedBusan = 0;
  let insertedGyeongnam = 0;
  try {
    await applySido(db, busan, updatedAt, originalKeys, originalHash);
    insertedBusan = busan.length;
    await applySido(db, gyeongnam, updatedAt, originalKeys, originalHash);
    insertedGyeongnam = gyeongnam.length;
  } catch (error) {
    const message = error instanceof Error ? error.message : "apply failed";
    const after = await readRows(db).catch(() => []);
    writeResult({
      status: "ROLLED_BACK",
      reason: message,
      inserted_busan: insertedBusan,
      inserted_gyeongnam: insertedGyeongnam,
      rows_now: after.length,
      rollback_executed: true,
      production_write: insertedBusan > 0,
      api_calls: 0,
    });
    console.log(JSON.stringify({ status: "ROLLED_BACK", reason: message, insertedBusan, insertedGyeongnam, api_calls: 0 }));
    process.exit(3);
  }

  const after = await readRows(db);
  const afterIndex = indexRows(after);
  const afterComplexes = new Set(after.map((row) => row.complex_id)).size;
  const still = after.filter((row) => originalKeys.has(rowKey(row.complex_id, row.period_yyyymm)));
  const post: string[] = [];
  if (after.length !== EXPECTED_AFTER_ROWS) post.push(`rows ${after.length}`);
  if (afterComplexes !== EXPECTED_AFTER_COMPLEXES) post.push(`complexes ${afterComplexes}`);
  if (identityHash(still) !== originalHash || still.length !== EXPECTED_BEFORE_ROWS) post.push("existing rows changed");
  if (insertedBusan !== 93 || insertedGyeongnam !== 89) post.push("insert counts");
  if (after.some((row) => unpublished.includes(row.complex_id))) post.push("unpublished row present");
  for (const plan of plans) {
    const stored = afterIndex.get(rowKey(plan.complex_id, plan.period_yyyymm));
    if (!stored || !rowsEqual(stored, expectedSnapshot(plan, updatedAt))) post.push(`row ${plan.complex_id}`);
  }
  const insertedTotal = plans.reduce((sum, plan) => {
    const stored = afterIndex.get(rowKey(plan.complex_id, plan.period_yyyymm));
    return sum + (stored?.total_fee ?? 0);
  }, 0);
  if (insertedTotal !== canonicalTotal) post.push("canonical total");
  if (post.length > 0) {
    let rollbackError: string | null = null;
    try {
      await rollbackInserted(db, plans, updatedAt, originalKeys, originalHash);
    } catch (error) {
      rollbackError = error instanceof Error ? error.message : "rollback failed";
    }
    const restored = await readRows(db);
    writeResult({
      status: "ROLLED_BACK",
      reason: post.join("; "),
      rollback_error: rollbackError,
      restored_rows: restored.length,
      restored_hash_match: identityHash(restored) === originalHash,
      rollback_executed: rollbackError == null,
      production_write: true,
      api_calls: 0,
    });
    console.log(JSON.stringify({ status: "ROLLED_BACK", post, rollbackError, restored_rows: restored.length, api_calls: 0 }));
    process.exit(4);
  }

  writeResult({
    status: "PASS",
    inserted_busan: insertedBusan,
    inserted_gyeongnam: insertedGyeongnam,
    inserted: insertedBusan + insertedGyeongnam,
    updated: 0,
    deleted: 0,
    rows: after.length,
    complexes: afterComplexes,
    duplicate_keys: 0,
    existing_rows_unchanged: true,
    existing_row_hash: originalHash,
    periods,
    inserted_canonical_total: insertedTotal,
    updated_at: updatedAt,
    source: CANONICAL_SOURCE,
    amount_basis: CANONICAL_AMOUNT_BASIS,
    component_policy: "reference-catalog service sums; per-area household fee_status source_version left null",
    rollback_executed: false,
    production_write: true,
    api_calls: 0,
    plans: plans
      .map((plan) => ({
        complex_id: plan.complex_id,
        sido_code: plan.sido_code,
        period_yyyymm: plan.period_yyyymm,
        total_fee: plan.total_fee,
      }))
      .sort((left, right) => left.complex_id.localeCompare(right.complex_id)),
  });
  console.log(JSON.stringify({
    status: "PASS",
    inserted_busan: insertedBusan,
    inserted_gyeongnam: insertedGyeongnam,
    rows: after.length,
    complexes: afterComplexes,
    periods,
    inserted_canonical_total: insertedTotal,
    api_calls: 0,
  }));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "apply failed");
  process.exit(1);
});

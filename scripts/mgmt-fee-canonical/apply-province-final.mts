/**
 * Production INSERT-only apply of one province's verified COMPLETE months (generalized apply-gyeonggi-final).
 * Rebuilds rows from the province checkpoint; never calls the fee API. Requires dry-run gate PASS,
 * a terminal cohort, and the pinned cohort sha. PARTIAL / MISSING / FAILED / NO_PUBLISHED_MONTH are never written.
 * A second --commit is IDEMPOTENT_NOOP.
 *
 *   npx tsx scripts/mgmt-fee-canonical/apply-province-final.mts --province=incheon [--commit]
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
import { provinceArtifactPrefix, provinceFromArgv } from "./provinces";
import { CANONICAL_AMOUNT_BASIS, CANONICAL_SOURCE } from "./types";

const PROBE_OP = "getHsmpCleaningCostInfoV3";
const PROBE_SERVICE = "common";
const PERIODS = ["202607", "202608", "202609"];

const PROVINCE = provinceFromArgv(process.argv);
const PREFIX = provinceArtifactPrefix(PROVINCE);
const SIDO_CODE = PROVINCE.sido_code;
const DIR = resolve(import.meta.dirname, "../../data/poc/mgmt-fee-canonical");
const CHECKPOINT_PATH = resolve(DIR, `${PREFIX}-op-checkpoint.json`);
const DRYRUN_PATH = resolve(DIR, `${PREFIX}-dryrun.json`);
const COHORT_PATH = resolve(DIR, `${PREFIX}-cohort.json`);
const COHORT_SHA_PATH = resolve(DIR, `${PREFIX}-cohort.sha256`);
const RESULT_PATH = resolve(DIR, `${PREFIX}-apply-result.json`);

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
  sido_code: string;
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

function rebuildPlans(store: OpCheckpointStore, cohortIds: readonly string[]): { plans: InsertPlan[]; unpublished: string[]; skipped: string[] } {
  const periods = buildProbePeriods("202609", 3);
  const complexes = [...cohortIds];
  const plans: InsertPlan[] = [];
  const unpublished: string[] = [];
  const skipped: string[] = [];
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
    if (classified.checkpoint_status !== "COMPLETE") {
      skipped.push(complex_id);
      continue;
    }
    if (classified.amount == null || !classified.result) throw new Error(`COMPLETE without amount ${complex_id} ${period}`);
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
      sido_code: SIDO_CODE,
      sido: "",
      period_yyyymm: period,
      common_fee: sums.common,
      individual_fee: sums.individual,
      long_term_repair_reserve: sums.reserve,
      total_fee: classified.amount,
    });
  }
  return { plans, unpublished, skipped };
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
  return Object.fromEntries(PERIODS.map((period) => [period, plans.filter((plan) => plan.period_yyyymm === period).length]));
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

async function applyProvince(
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
  for (const path of [CHECKPOINT_PATH, DRYRUN_PATH, COHORT_PATH, COHORT_SHA_PATH]) {
    if (!existsSync(path)) throw new Error(`artifact missing ${path}`);
  }
  const hashes = {
    checkpoint_sha256: sha256File(CHECKPOINT_PATH),
    dryrun_sha256: sha256File(DRYRUN_PATH),
    cohort_sha256: sha256File(COHORT_PATH),
  };
  if (readFileSync(COHORT_SHA_PATH, "utf8").trim() !== hashes.cohort_sha256) failures.push("cohort hash");
  if (existsSync(RESULT_PATH)) {
    const prior = JSON.parse(readFileSync(RESULT_PATH, "utf8")) as { status?: string; checkpoint_sha256?: string; dryrun_sha256?: string };
    if (prior.status === "PASS" && (prior.checkpoint_sha256 !== hashes.checkpoint_sha256 || prior.dryrun_sha256 !== hashes.dryrun_sha256)) {
      failures.push("artifacts changed after apply");
    }
  }
  const cohort = JSON.parse(readFileSync(COHORT_PATH, "utf8")) as {
    selected: number;
    frozen: boolean;
    complexes: Array<{ complex_id: string; kapt_code: string; sido_code: string }>;
  };
  if (!cohort.frozen || cohort.selected !== cohort.complexes.length || cohort.complexes.length < 1) failures.push("frozen cohort");
  if (cohort.complexes.some((row) => row.sido_code !== SIDO_CODE)) failures.push("cohort sido");
  const artifact = JSON.parse(readFileSync(DRYRUN_PATH, "utf8")) as {
    production_write: boolean;
    cohort_terminal: boolean;
    gate: string;
    complexes: number;
    api_calls: number;
    reuse_confirmation_api_calls: number;
    http_429: boolean;
    target_months: number;
    no_published_month: number;
    identity_conflicts: number;
    by_sido: Array<{ sido_code: string; targets: number; COMPLETE: number; would_insert: number; would_update: number }>;
    totals: { COMPLETE: number; PARTIAL: number; MISSING: number; FAILED: number; would_insert: number; would_update: number };
    samples: ArtifactSample[];
  };
  if (artifact.production_write !== false) failures.push("artifact already marked written");
  if (artifact.cohort_terminal !== true || artifact.gate !== "PASS") failures.push(`dry-run gate ${artifact.gate}`);
  if (artifact.complexes !== cohort.complexes.length) failures.push("artifact cohort size");
  if (artifact.reuse_confirmation_api_calls !== 0 || artifact.http_429 !== false) failures.push("artifact api guard");
  if (artifact.totals.would_update !== 0 || artifact.totals.would_insert !== artifact.totals.COMPLETE) failures.push("artifact totals");
  const nonComplete = artifact.totals.PARTIAL + artifact.totals.MISSING + artifact.totals.FAILED;
  if (artifact.target_months !== artifact.totals.COMPLETE + nonComplete) failures.push("artifact target months");
  if (artifact.target_months + artifact.no_published_month + artifact.identity_conflicts !== cohort.complexes.length) {
    failures.push("artifact classification sum");
  }
  const bySido = artifact.by_sido.find((row) => row.sido_code === SIDO_CODE);
  if (!bySido || bySido.COMPLETE !== artifact.totals.COMPLETE || bySido.would_update !== 0) failures.push("artifact by_sido");

  const store = OpCheckpointStore.parse(readFileSync(CHECKPOINT_PATH, "utf8"));
  const records = store.list();
  if (records.some((record) => record.period && !PERIODS.includes(record.period))) failures.push("checkpoint period outside artifact");
  const cohortIds = new Set(cohort.complexes.map((row) => row.complex_id));
  if (records.some((record) => !cohortIds.has(record.complex_id))) failures.push("checkpoint complex outside cohort");

  let plans: InsertPlan[] = [];
  let unpublished: string[] = [];
  let skipped: string[] = [];
  try {
    const identityGuard = JSON.parse(readFileSync(resolve(DIR, `${PREFIX}-identity-guard.json`), "utf8")) as { conflicts: number; samples: Array<{ complex_id: string }> };
    if (identityGuard.conflicts !== artifact.identity_conflicts) failures.push("identity guard mismatch");
    if (identityGuard.conflicts > identityGuard.samples.length) failures.push("identity conflicts exceed sample list");
    const conflictIds = new Set(identityGuard.samples.map((row) => row.complex_id));
    const rebuilt = rebuildPlans(store, cohort.complexes.map((row) => row.complex_id).filter((id) => !conflictIds.has(id)));
    plans = rebuilt.plans;
    unpublished = rebuilt.unpublished;
    skipped = rebuilt.skipped;
  } catch (error) {
    failures.push(error instanceof Error ? error.message : "rebuild failed");
  }
  if (plans.length !== artifact.totals.COMPLETE || unpublished.length !== artifact.no_published_month || skipped.length !== nonComplete) {
    failures.push(`rebuilt plans ${plans.length} unpublished ${unpublished.length} skipped ${skipped.length}`);
  }
  const planKeys = new Set(plans.map((plan) => rowKey(plan.complex_id, plan.period_yyyymm)));
  if (planKeys.size !== plans.length) failures.push("duplicate plan key");

  const url = process.env.TURSO_DATABASE_URL?.trim();
  const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
  if (!url || !authToken) throw new Error("Turso env missing");
  const db = createClient({ url, authToken });

  const info = await db.execute("PRAGMA table_info(apt_complex_mgmt_fee_monthly)");
  const required = info.rows
    .filter((row) => Number(row.notnull) === 1 && row.dflt_value == null)
    .map((row) => String(row.name));
  const provided = new Set(["complex_id", "period_yyyymm", "common_fee", "individual_fee", "long_term_repair_reserve", "total_fee", "amount_basis", "source", "updated_at"]);
  for (const name of required) if (!provided.has(name)) failures.push(`NOT NULL column unset ${name}`);
  const triggers = await db.execute({
    sql: "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?",
    args: ["apt_complex_mgmt_fee_monthly"],
  });
  if (triggers.rows.length > 0) failures.push("fee table trigger present");

  const before = await readRows(db);
  const beforeIndex = indexRows(before);
  const beforeComplexes = new Set(before.map((row) => row.complex_id)).size;
  const present = plans.filter((plan) => beforeIndex.has(rowKey(plan.complex_id, plan.period_yyyymm)));
  const presentMatch = present.every((plan) => {
    const stored = beforeIndex.get(rowKey(plan.complex_id, plan.period_yyyymm));
    return stored != null && rowsEqual(stored, expectedSnapshot(plan, stored.updated_at));
  });
  const alreadyApplied = plans.length > 0 && present.length === plans.length && presentMatch;
  if (!alreadyApplied && present.length > 0) failures.push(`collisions ${present.length}${presentMatch ? "" : " differ"}`);
  const cohortStored = before.filter((row) => cohortIds.has(row.complex_id) && !planKeys.has(rowKey(row.complex_id, row.period_yyyymm)));
  if (cohortStored.length > 0) failures.push(`cohort complexes already stored outside plan ${cohortStored.length}`);
  const nonPlanRows = before.filter((row) => !planKeys.has(rowKey(row.complex_id, row.period_yyyymm)));
  const originalHash = identityHash(nonPlanRows);
  const originalKeys = new Set(nonPlanRows.map((row) => rowKey(row.complex_id, row.period_yyyymm)));

  if (plans.length > 0 || unpublished.length > 0) {
    const ids = plans.map((plan) => plan.complex_id).concat(unpublished);
    const byId = new Map<string, Record<string, unknown>>();
    for (let offset = 0; offset < ids.length; offset += 400) {
      const batch = ids.slice(offset, offset + 400);
      const masters = await db.execute({
        sql: `SELECT complex_id, sido, sido_code FROM apt_complex_master WHERE complex_id IN (${batch.map(() => "?").join(", ")})`,
        args: batch,
      });
      for (const row of masters.rows) byId.set(String(row.complex_id), row as Record<string, unknown>);
    }
    if (byId.size !== ids.length) failures.push(`master rows ${byId.size} expected ${ids.length}`);
    for (const plan of plans) {
      const master = byId.get(plan.complex_id);
      if (!master || String(master.sido_code) !== SIDO_CODE) failures.push(`sido ${plan.complex_id}`);
      plan.sido = master?.sido == null ? "" : String(master.sido);
    }
    for (const id of unpublished) {
      const master = byId.get(id);
      if (!master || String(master.sido_code) !== SIDO_CODE) failures.push(`unpublished sido ${id}`);
    }
  }
  const unpublishedSet = new Set(unpublished);
  if (before.some((row) => unpublishedSet.has(row.complex_id))) failures.push("unpublished already stored");

  const samplePlans = plans.slice(0, artifact.samples.length);
  for (let index = 0; index < artifact.samples.length; index += 1) {
    const sample = artifact.samples[index]!;
    const plan = samplePlans[index];
    if (
      !plan ||
      sample.complex_id !== plan.complex_id ||
      sample.period !== plan.period_yyyymm ||
      sample.amount !== plan.total_fee ||
      sample.status !== "COMPLETE" ||
      sample.would !== "insert" ||
      sample.sido_code !== SIDO_CODE
    ) {
      failures.push(`sample ${index} mismatch`);
    }
  }

  const periods = periodCounts(plans);
  const canonicalTotal = plans.reduce((sum, plan) => sum + plan.total_fee, 0);
  if (failures.length > 0) {
    if (!existsSync(RESULT_PATH)) {
      writeResult({ status: "BLOCKED", province: PROVINCE.slug, precheck_failures: failures.slice(0, 50), production_write: false, api_calls: 0, rollback_executed: false });
    }
    console.log(JSON.stringify({ status: "BLOCKED", failures: failures.slice(0, 20), api_calls: 0 }));
    process.exit(2);
  }

  if (alreadyApplied) {
    console.log(JSON.stringify({ status: "IDEMPOTENT_NOOP", province: PROVINCE.slug, inserted: 0, updated: 0, deleted: 0, rows: before.length, complexes: beforeComplexes, api_calls: 0 }));
    return;
  }

  const summary = {
    province: PROVINCE.slug,
    total: plans.length,
    unpublished: unpublished.length,
    skipped_non_complete: skipped.length,
    collisions: 0,
    periods,
    canonical_total: canonicalTotal,
    existing_rows: before.length,
    existing_complexes: beforeComplexes,
  };
  if (!commit || plans.length === 0) {
    console.log(JSON.stringify({ status: "PRECHECK_OK", ...summary, api_calls: 0 }));
    if (commit) {
      writeResult({ status: "PASS", ...summary, ...hashes, inserted: 0, updated: 0, deleted: 0, rows: before.length, complexes: beforeComplexes, production_write: false, api_calls: 0 });
    }
    return;
  }

  const updatedAt = new Date().toISOString();
  try {
    await applyProvince(db, plans, updatedAt, originalKeys, originalHash);
  } catch (error) {
    const message = error instanceof Error ? error.message : "apply failed";
    const after = await readRows(db).catch(() => []);
    writeResult({ status: "ROLLED_BACK", province: PROVINCE.slug, reason: message, inserted: 0, rows_now: after.length, rollback_executed: true, production_write: false, api_calls: 0 });
    console.log(JSON.stringify({ status: "ROLLED_BACK", reason: message, api_calls: 0 }));
    process.exit(3);
  }

  const after = await readRows(db);
  const afterIndex = indexRows(after);
  const afterComplexes = new Set(after.map((row) => row.complex_id)).size;
  const still = after.filter((row) => originalKeys.has(rowKey(row.complex_id, row.period_yyyymm)));
  const post: string[] = [];
  if (after.length < before.length + plans.length) post.push(`rows ${after.length}`);
  if (identityHash(still) !== originalHash || still.length !== nonPlanRows.length) post.push("existing rows changed");
  if (after.some((row) => unpublishedSet.has(row.complex_id))) post.push("unpublished row present");
  for (const plan of plans) {
    const stored = afterIndex.get(rowKey(plan.complex_id, plan.period_yyyymm));
    if (!stored || !rowsEqual(stored, expectedSnapshot(plan, updatedAt))) post.push(`row ${plan.complex_id}`);
  }
  const insertedTotal = plans.reduce((sum, plan) => sum + (afterIndex.get(rowKey(plan.complex_id, plan.period_yyyymm))?.total_fee ?? 0), 0);
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
      province: PROVINCE.slug,
      reason: post.slice(0, 20).join("; "),
      rollback_error: rollbackError,
      restored_rows: restored.length,
      rollback_executed: rollbackError == null,
      production_write: true,
      api_calls: 0,
    });
    console.log(JSON.stringify({ status: "ROLLED_BACK", post: post.slice(0, 20), rollbackError, restored_rows: restored.length, api_calls: 0 }));
    process.exit(4);
  }

  writeResult({
    status: "PASS",
    ...summary,
    ...hashes,
    inserted: plans.length,
    updated: 0,
    deleted: 0,
    rows_before: before.length,
    complexes_before: beforeComplexes,
    rows: after.length,
    complexes: afterComplexes,
    duplicate_keys: 0,
    existing_rows_unchanged: true,
    existing_row_hash: originalHash,
    inserted_canonical_total: insertedTotal,
    updated_at: updatedAt,
    source: CANONICAL_SOURCE,
    amount_basis: CANONICAL_AMOUNT_BASIS,
    component_policy: "reference-catalog service sums; per-area household fee_status source_version left null",
    rollback_executed: false,
    production_write: true,
    api_calls: 0,
    plans: plans
      .map((plan) => ({ complex_id: plan.complex_id, sido_code: plan.sido_code, period_yyyymm: plan.period_yyyymm, total_fee: plan.total_fee }))
      .sort((left, right) => left.complex_id.localeCompare(right.complex_id)),
  });
  console.log(JSON.stringify({ status: "PASS", province: PROVINCE.slug, inserted: plans.length, rows: after.length, complexes: afterComplexes, periods, inserted_canonical_total: insertedTotal, api_calls: 0 }));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "apply failed");
  process.exit(1);
});

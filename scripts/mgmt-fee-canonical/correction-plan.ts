/**
 * Deterministic correction plan for the reconciled 54 fee rows.
 * Does not open a database and does not call the fee API.
 *
 * Missing-row policy is DELETE, not NULL:
 * total_fee is nullable, but source is NOT NULL, and the only application
 * reader (not on this branch) treats every present row as a month.
 * sumComponents(0,0,0) is 0 and is included in averages. A null total_fee
 * with the stored 0 components still averages as 0. Nulling every component
 * still occupies the continuity window. Absence does neither.
 * Portal per-㎡ display already drops these rows (fee_status INCOMPLETE,
 * per-area null, total_fee <= 0). That path does not decide the policy.
 *
 * Source / amount_basis stay as stored on UNDERCOUNT rows. The reader does
 * not select amount_basis. Those 52 rows never reach the portal path
 * (per_area_total_fee is null). Their current labels already match the
 * canonical constants, and schema has no constraint requiring a new label.
 */
import { createHash } from "node:crypto";

export const SNAPSHOT_KEYS = [
  "complex_id",
  "period_yyyymm",
  "common_fee",
  "individual_fee",
  "long_term_repair_reserve",
  "total_fee",
  "per_area_common_fee",
  "per_area_total_fee",
  "area_basis_sqm",
  "household_basis",
  "amount_basis",
  "source",
  "source_version",
  "updated_at",
  "per_area_individual_fee",
  "per_area_reserve_fee",
  "area_basis",
  "fee_status",
] as const;

export type SnapshotKey = (typeof SNAPSHOT_KEYS)[number];

export type FeeRowSnapshot = {
  complex_id: string;
  period_yyyymm: string;
  common_fee: number | null;
  individual_fee: number | null;
  long_term_repair_reserve: number | null;
  total_fee: number | null;
  per_area_common_fee: number | null;
  per_area_total_fee: number | null;
  area_basis_sqm: number | null;
  household_basis: number | null;
  amount_basis: string | null;
  source: string;
  source_version: string | null;
  updated_at: string;
  per_area_individual_fee: number | null;
  per_area_reserve_fee: number | null;
  area_basis: string | null;
  fee_status: string | null;
};

export type ReconciledRow = {
  complex_id: string;
  period_yyyymm: string;
  stored_amount: number | null;
  canonical_amount: number | null;
  classification: string;
  delta: number | null;
  source: string | null;
  amount_basis: string | null;
};

export type CorrectionAction = "UPDATE" | "DELETE";

export type CorrectionEntry = {
  complex_id: string;
  period_yyyymm: string;
  action: CorrectionAction;
  classification: "UNDERCOUNT" | "STORED_ZERO_BUT_MISSING";
  reason: string;
  old_amount: number;
  canonical_amount: number | null;
  delta: number | null;
  old_source: string;
  old_amount_basis: string;
  proposed_source: string | null;
  proposed_amount_basis: string | null;
  before: FeeRowSnapshot;
  after: FeeRowSnapshot | null;
  expected_affected_rows: 1;
};

export type CorrectionManifest = {
  ordering: "complex_id,period_yyyymm";
  updated_at: string;
  production_write: false;
  missing_row_policy: "DELETE";
  source_amount_basis_policy: "keep";
  guards: {
    expected_candidate_count: number;
    expected_undercount_updates: number;
    expected_missing_deletes: number;
    exact_match_untouched: number;
    before_value_check: true;
    transaction: true;
    abort_on_before_drift: true;
    abort_on_count_mismatch: true;
    exact_match_mutation: false;
    new_row_insert: false;
  };
  summary: {
    total: number;
    UPDATE: number;
    DELETE: number;
    expected_affected_rows: number;
  };
  hash: string;
  entries: CorrectionEntry[];
};

export type RollbackEntry = {
  complex_id: string;
  period_yyyymm: string;
  action: "UPDATE" | "INSERT";
  restores: FeeRowSnapshot;
  expected_affected_rows: 1;
};

export type RollbackManifest = {
  ordering: "complex_id,period_yyyymm";
  production_write: false;
  summary: {
    total: number;
    UPDATE: number;
    INSERT: number;
    expected_affected_rows: number;
  };
  hash: string;
  entries: RollbackEntry[];
};

export class CorrectionAbort extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorrectionAbort";
  }
}

const UPDATE_REASON =
  "UNDERCOUNT: stored total_fee is below the canonical COMPLETE amount. Update total_fee only. source and amount_basis already match the canonical labels and are not read as a gate.";

const DELETE_REASON =
  "STORED_ZERO_BUT_MISSING: canonical month is MISSING. A present row is a month to the fee reader, and stored 0 components are averaged as 0. NULL total_fee does not remove that row. Delete the row.";

export function rowKey(complex_id: string, period_yyyymm: string): string {
  return `${complex_id}|${period_yyyymm}`;
}

export function compareFeeKey(left: { complex_id: string; period_yyyymm: string }, right: { complex_id: string; period_yyyymm: string }): number {
  const complex = left.complex_id.localeCompare(right.complex_id);
  if (complex !== 0) return complex;
  return left.period_yyyymm.localeCompare(right.period_yyyymm);
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

export function sha256(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function snapshotOf(row: FeeRowSnapshot): FeeRowSnapshot {
  const copy = {} as FeeRowSnapshot;
  for (const key of SNAPSHOT_KEYS) {
    copy[key] = row[key];
  }
  return copy;
}

export function rowsEqual(left: FeeRowSnapshot, right: FeeRowSnapshot): boolean {
  return SNAPSHOT_KEYS.every((key) => left[key] === right[key]);
}

function withTotal(row: FeeRowSnapshot, total_fee: number, updated_at: string): FeeRowSnapshot {
  return { ...snapshotOf(row), total_fee, updated_at };
}

export function buildCorrectionPlan(args: {
  reconciled: readonly ReconciledRow[];
  snapshots: readonly FeeRowSnapshot[];
  updatedAt: string;
  expect?: { exact: number; update: number; delete: number };
}): { correction: CorrectionManifest; rollback: RollbackManifest } {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(args.updatedAt)) {
    throw new CorrectionAbort("updatedAt must be a fixed timestamp");
  }
  const snaps = new Map<string, FeeRowSnapshot>();
  for (const row of args.snapshots) {
    const key = rowKey(row.complex_id, row.period_yyyymm);
    if (snaps.has(key)) throw new CorrectionAbort(`duplicate snapshot ${key}`);
    snaps.set(key, snapshotOf(row));
  }

  let exact = 0;
  const entries: CorrectionEntry[] = [];
  for (const row of args.reconciled) {
    if (row.classification === "EXACT_MATCH") {
      exact += 1;
      continue;
    }
    if (row.classification !== "UNDERCOUNT" && row.classification !== "STORED_ZERO_BUT_MISSING") {
      throw new CorrectionAbort(`row ${row.complex_id} ${row.period_yyyymm} is not a correction candidate: ${row.classification}`);
    }
    const before = snaps.get(rowKey(row.complex_id, row.period_yyyymm));
    if (!before) throw new CorrectionAbort(`snapshot missing ${row.complex_id} ${row.period_yyyymm}`);
    if (before.total_fee !== row.stored_amount || before.source !== row.source || before.amount_basis !== row.amount_basis) {
      throw new CorrectionAbort(`snapshot drifted from reconciliation ${row.complex_id} ${row.period_yyyymm}`);
    }
    if (row.classification === "UNDERCOUNT") {
      if (row.canonical_amount == null || !Number.isInteger(row.canonical_amount)) {
        throw new CorrectionAbort(`canonical amount missing ${row.complex_id} ${row.period_yyyymm}`);
      }
      if (row.stored_amount == null || !Number.isInteger(row.stored_amount)) {
        throw new CorrectionAbort(`stored amount missing ${row.complex_id} ${row.period_yyyymm}`);
      }
      const delta = row.canonical_amount - row.stored_amount;
      if (delta <= 0 || row.delta !== delta) {
        throw new CorrectionAbort(`delta mismatch ${row.complex_id} ${row.period_yyyymm}`);
      }
      const after = withTotal(before, row.canonical_amount, args.updatedAt);
      entries.push({
        complex_id: row.complex_id,
        period_yyyymm: row.period_yyyymm,
        action: "UPDATE",
        classification: "UNDERCOUNT",
        reason: UPDATE_REASON,
        old_amount: row.stored_amount,
        canonical_amount: row.canonical_amount,
        delta,
        old_source: before.source,
        old_amount_basis: before.amount_basis ?? "",
        proposed_source: before.source,
        proposed_amount_basis: before.amount_basis,
        before,
        after,
        expected_affected_rows: 1,
      });
      continue;
    }
    if (row.stored_amount !== 0 || row.canonical_amount !== null) {
      throw new CorrectionAbort(`missing row is not stored zero ${row.complex_id} ${row.period_yyyymm}`);
    }
    entries.push({
      complex_id: row.complex_id,
      period_yyyymm: row.period_yyyymm,
      action: "DELETE",
      classification: "STORED_ZERO_BUT_MISSING",
      reason: DELETE_REASON,
      old_amount: 0,
      canonical_amount: null,
      delta: null,
      old_source: before.source,
      old_amount_basis: before.amount_basis ?? "",
      proposed_source: null,
      proposed_amount_basis: null,
      before,
      after: null,
      expected_affected_rows: 1,
    });
  }

  entries.sort(compareFeeKey);
  const updates = entries.filter((entry) => entry.action === "UPDATE").length;
  const deletes = entries.filter((entry) => entry.action === "DELETE").length;
  if (args.expect) {
    if (exact !== args.expect.exact || updates !== args.expect.update || deletes !== args.expect.delete) {
      throw new CorrectionAbort(
        `count mismatch exact=${exact} update=${updates} delete=${deletes}`,
      );
    }
  }
  if (entries.some((entry) => entry.action !== "UPDATE" && entry.action !== "DELETE")) {
    throw new CorrectionAbort("new row insert is forbidden");
  }

  const rollbackEntries: RollbackEntry[] = entries.map((entry) => ({
    complex_id: entry.complex_id,
    period_yyyymm: entry.period_yyyymm,
    action: entry.action === "DELETE" ? "INSERT" : "UPDATE",
    restores: entry.before,
    expected_affected_rows: 1,
  }));

  const correctionWithoutHash = {
    ordering: "complex_id,period_yyyymm" as const,
    updated_at: args.updatedAt,
    production_write: false as const,
    missing_row_policy: "DELETE" as const,
    source_amount_basis_policy: "keep" as const,
    guards: {
      expected_candidate_count: entries.length,
      expected_undercount_updates: updates,
      expected_missing_deletes: deletes,
      exact_match_untouched: exact,
      before_value_check: true as const,
      transaction: true as const,
      abort_on_before_drift: true as const,
      abort_on_count_mismatch: true as const,
      exact_match_mutation: false as const,
      new_row_insert: false as const,
    },
    summary: {
      total: entries.length,
      UPDATE: updates,
      DELETE: deletes,
      expected_affected_rows: entries.length,
    },
    entries,
  };
  const correction: CorrectionManifest = {
    ...correctionWithoutHash,
    hash: sha256(correctionWithoutHash.entries),
  };
  const rollbackWithoutHash = {
    ordering: "complex_id,period_yyyymm" as const,
    production_write: false as const,
    summary: {
      total: rollbackEntries.length,
      UPDATE: rollbackEntries.filter((entry) => entry.action === "UPDATE").length,
      INSERT: rollbackEntries.filter((entry) => entry.action === "INSERT").length,
      expected_affected_rows: rollbackEntries.length,
    },
    entries: rollbackEntries,
  };
  return {
    correction,
    rollback: { ...rollbackWithoutHash, hash: sha256(rollbackWithoutHash.entries) },
  };
}

export function assertPlanGuards(plan: CorrectionManifest): void {
  if (plan.production_write !== false) throw new CorrectionAbort("production write flag");
  if (plan.summary.total !== plan.guards.expected_candidate_count) {
    throw new CorrectionAbort("expected count mismatch");
  }
  if (plan.summary.UPDATE !== plan.guards.expected_undercount_updates) {
    throw new CorrectionAbort("undercount count mismatch");
  }
  if (plan.summary.DELETE !== plan.guards.expected_missing_deletes) {
    throw new CorrectionAbort("missing count mismatch");
  }
  if (plan.summary.expected_affected_rows !== plan.entries.length) {
    throw new CorrectionAbort("affected count mismatch");
  }
  if (plan.hash !== sha256(plan.entries)) throw new CorrectionAbort("hash mismatch");
  const seen = new Set<string>();
  for (const entry of plan.entries) {
    const key = rowKey(entry.complex_id, entry.period_yyyymm);
    if (seen.has(key)) throw new CorrectionAbort(`duplicate ${key}`);
    seen.add(key);
    if (entry.action === "UPDATE") {
      if (entry.classification !== "UNDERCOUNT" || entry.after == null) {
        throw new CorrectionAbort(`update shape ${key}`);
      }
      if (entry.after.source !== entry.before.source || entry.after.amount_basis !== entry.before.amount_basis) {
        throw new CorrectionAbort(`source change forbidden ${key}`);
      }
      if (entry.after.total_fee !== entry.canonical_amount) throw new CorrectionAbort(`amount ${key}`);
    } else if (entry.action === "DELETE") {
      if (entry.classification !== "STORED_ZERO_BUT_MISSING" || entry.after != null) {
        throw new CorrectionAbort(`delete shape ${key}`);
      }
    } else {
      throw new CorrectionAbort("new row insert is forbidden");
    }
    if (entry.expected_affected_rows !== 1) throw new CorrectionAbort(`affected ${key}`);
  }
  for (let i = 1; i < plan.entries.length; i += 1) {
    if (compareFeeKey(plan.entries[i - 1], plan.entries[i]) > 0) {
      throw new CorrectionAbort("ordering is not deterministic");
    }
  }
}

function indexRows(rows: readonly FeeRowSnapshot[]): Map<string, FeeRowSnapshot> {
  const map = new Map<string, FeeRowSnapshot>();
  for (const row of rows) {
    const key = rowKey(row.complex_id, row.period_yyyymm);
    if (map.has(key)) throw new CorrectionAbort(`duplicate live row ${key}`);
    map.set(key, snapshotOf(row));
  }
  return map;
}

export function applyCorrection(
  rows: readonly FeeRowSnapshot[],
  plan: CorrectionManifest,
  reportedChanges?: readonly number[],
): FeeRowSnapshot[] {
  assertPlanGuards(plan);
  const live = indexRows(rows);
  for (const entry of plan.entries) {
    const current = live.get(rowKey(entry.complex_id, entry.period_yyyymm));
    if (!current || !rowsEqual(current, entry.before)) {
      throw new CorrectionAbort(`before-value drift ${entry.complex_id} ${entry.period_yyyymm}`);
    }
  }
  if (reportedChanges && reportedChanges.length !== plan.entries.length) {
    throw new CorrectionAbort("affected row count mismatch");
  }
  const next = new Map(live);
  let affected = 0;
  plan.entries.forEach((entry, index) => {
    const key = rowKey(entry.complex_id, entry.period_yyyymm);
    const changes = reportedChanges ? reportedChanges[index] : 1;
    if (changes !== 1) return;
    if (entry.action === "DELETE") next.delete(key);
    else next.set(key, snapshotOf(entry.after as FeeRowSnapshot));
    affected += 1;
  });
  if (affected !== plan.summary.expected_affected_rows) {
    throw new CorrectionAbort("affected row count mismatch");
  }
  return [...next.values()].sort(compareFeeKey);
}

export function applyRollback(
  rows: readonly FeeRowSnapshot[],
  rollback: RollbackManifest,
): FeeRowSnapshot[] {
  if (rollback.hash !== sha256(rollback.entries)) throw new CorrectionAbort("rollback hash mismatch");
  const live = indexRows(rows);
  const next = new Map(live);
  let affected = 0;
  for (const entry of rollback.entries) {
    const key = rowKey(entry.complex_id, entry.period_yyyymm);
    if (entry.action === "INSERT") {
      if (next.has(key)) throw new CorrectionAbort(`rollback insert target exists ${key}`);
      next.set(key, snapshotOf(entry.restores));
      affected += 1;
      continue;
    }
    if (entry.action !== "UPDATE") throw new CorrectionAbort(`rollback action ${entry.action}`);
    const current = next.get(key);
    if (!current) throw new CorrectionAbort(`rollback update target missing ${key}`);
    next.set(key, snapshotOf(entry.restores));
    affected += 1;
  }
  if (affected !== rollback.summary.expected_affected_rows) {
    throw new CorrectionAbort("affected row count mismatch");
  }
  return [...next.values()].sort(compareFeeKey);
}

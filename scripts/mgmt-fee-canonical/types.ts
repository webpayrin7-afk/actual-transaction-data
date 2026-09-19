/**
 * Offline canonical fee model.
 * Write contract follows phase71c upsert keying.
 * This module does not call external APIs or open a database.
 */

export type Completeness = "COMPLETE" | "PARTIAL" | "MISSING";

export type CheckpointStatus = Completeness | "FAILED";

export type RowPresence = "NEW" | "EXISTING";

export type UpsertAction = "insert" | "update" | "skip";

export type OpState = "success" | "failed" | "missing";

/** One operation observation from a fixture or future adapter. Never fetched here. */
export type OpObservation = {
  op: string;
  state: OpState;
  /**
   * Explicit numeric payload. `0` is a real zero.
   * `null` or omission is not zero, including when state is "missing".
   */
  amount?: number | null;
  error?: string | null;
};

export type CanonicalFeeResult = {
  complex_id: string;
  period_yyyymm: string;
  /** Null when nothing may be stored (MISSING, or no numeric successes). */
  amount: number | null;
  completeness: Completeness;
  successful_ops: string[];
  failed_ops: string[];
  missing_ops: string[];
  source: string;
  amount_basis: string;
};

export type CheckpointRecord = {
  complex_id: string;
  period: string;
  status: CheckpointStatus;
  completed_ops: string[];
  failed_ops: string[];
  missing_ops: string[];
  last_error: string | null;
  updated_at: string;
};

export type SampleMember = {
  complex_id: string;
  region?: "seoul" | "gyeonggi";
};

export type ExistingFeeKey = {
  complex_id: string;
  period_yyyymm: string;
};

export type DryRunTarget = {
  complex_id: string;
  period_yyyymm: string;
  observations?: OpObservation[];
};

export type UpsertPlan = {
  action: UpsertAction;
  complex_id: string;
  period_yyyymm: string;
  total_fee: number | null;
  amount_basis: string;
  source: string;
  presence: RowPresence;
  reason: string;
};

export type DryRunError = {
  complex_id: string;
  period: string;
  message: string;
};

export type DryRunReport = {
  total_targets: number;
  COMPLETE: number;
  PARTIAL: number;
  MISSING: number;
  FAILED: number;
  would_insert: number;
  would_update: number;
  would_skip: number;
  checkpoint_skipped: number;
  errors: DryRunError[];
};

export const CANONICAL_SOURCE = "MOLIT_KAPT_FEE_V3";
export const CANONICAL_AMOUNT_BASIS = "complex_month_total_krw";
export const DEFAULT_COHORT_CAP = 5;

/**
 * Phase 7.1c upsert shape. Planner only — never executed, never ALTER/DELETE.
 * Conflict key is the production primary key.
 */
export const CANONICAL_UPSERT_SQL = `
INSERT INTO apt_complex_mgmt_fee_monthly (
  complex_id, period_yyyymm, common_fee, individual_fee, long_term_repair_reserve,
  total_fee, per_area_common_fee, per_area_total_fee, area_basis_sqm,
  household_basis, amount_basis, source, source_version, updated_at
) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?)
ON CONFLICT(complex_id, period_yyyymm) DO UPDATE SET
  common_fee=excluded.common_fee,
  individual_fee=excluded.individual_fee,
  long_term_repair_reserve=excluded.long_term_repair_reserve,
  total_fee=excluded.total_fee,
  household_basis=excluded.household_basis,
  amount_basis=excluded.amount_basis,
  source=excluded.source,
  source_version=excluded.source_version,
  updated_at=excluded.updated_at
`.trim();

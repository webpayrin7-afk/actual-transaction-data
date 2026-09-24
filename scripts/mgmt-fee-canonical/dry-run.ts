/**
 * Offline dry-run planner.
 * Builds an idempotent upsert plan and a checkpoint. Does not write SQL
 * and does not contact Production or an external fee API.
 */
import { classifyFeeMonth } from "./classify";
import { CheckpointStore } from "./checkpoint";
import {
  feeRowKey,
  prepareSampleCohort,
  rowPresence,
  validatePeriod,
} from "./cohort";
import { REFERENCE_OP_NAMES } from "./op-catalog";
import {
  CANONICAL_AMOUNT_BASIS,
  CANONICAL_SOURCE,
  CANONICAL_UPSERT_SQL,
  DEFAULT_COHORT_CAP,
  type CanonicalFeeResult,
  type DryRunReport,
  type DryRunTarget,
  type ExistingFeeKey,
  type SampleMember,
  type UpsertPlan,
} from "./types";

export type DryRunInput = {
  cohort: readonly SampleMember[];
  periods: readonly string[];
  targets?: readonly DryRunTarget[];
  existingFeeKeys?: readonly ExistingFeeKey[];
  checkpoint?: CheckpointStore;
  expectedOps?: readonly string[];
  cap?: number;
  now?: string;
};

export type DryRunOutput = {
  results: CanonicalFeeResult[];
  plans: UpsertPlan[];
  report: DryRunReport;
  checkpoint: CheckpointStore;
};

export function assertUpsertSqlAllowed(sql: string = CANONICAL_UPSERT_SQL): void {
  if (/\bDELETE\b/i.test(sql) || /\bALTER\s+TABLE\b/i.test(sql) || /\bDROP\b/i.test(sql)) {
    throw new Error("forbidden sql: delete/alter/drop");
  }
  if (!/ON CONFLICT\s*\(\s*complex_id\s*,\s*period_yyyymm\s*\)/i.test(sql)) {
    throw new Error("upsert key (complex_id, period_yyyymm) missing");
  }
}

function emptyReport(): DryRunReport {
  return {
    total_targets: 0,
    COMPLETE: 0,
    PARTIAL: 0,
    MISSING: 0,
    FAILED: 0,
    would_insert: 0,
    would_update: 0,
    would_skip: 0,
    checkpoint_skipped: 0,
    errors: [],
  };
}

export function runCanonicalDryRun(input: DryRunInput): DryRunOutput {
  assertUpsertSqlAllowed();
  const cohort = prepareSampleCohort(input.cohort, input.cap ?? DEFAULT_COHORT_CAP);
  if (input.periods.length === 0) {
    throw new Error("explicit periods required");
  }
  const periods = input.periods.map((period) => validatePeriod(period));
  const periodSet = new Set(periods);
  const cohortIds = new Set(cohort.map((member) => member.complex_id));
  const expectedOps = input.expectedOps ?? REFERENCE_OP_NAMES;
  const now = input.now ?? "1970-01-01T00:00:00.000Z";
  const checkpoint = CheckpointStore.fromRecords(input.checkpoint?.list() ?? []);

  const existing = new Set(
    (input.existingFeeKeys ?? []).map((key) =>
      feeRowKey(key.complex_id, validatePeriod(key.period_yyyymm)),
    ),
  );

  const provided = new Map<string, DryRunTarget>();
  for (const target of input.targets ?? []) {
    if (!cohortIds.has(target.complex_id)) {
      throw new Error(`target complex_id is outside the cohort: ${target.complex_id}`);
    }
    const period = validatePeriod(target.period_yyyymm);
    if (!periodSet.has(period)) {
      throw new Error(`period ${period} is not in the explicit period list`);
    }
    const key = feeRowKey(target.complex_id, period);
    if (provided.has(key)) {
      throw new Error(`duplicate target ${key}`);
    }
    provided.set(key, { ...target, period_yyyymm: period });
  }

  const results: CanonicalFeeResult[] = [];
  const plans: UpsertPlan[] = [];
  const report = emptyReport();

  for (const member of cohort) {
    for (const period of periods) {
      report.total_targets += 1;
      const key = feeRowKey(member.complex_id, period);
      const presence = rowPresence(member.complex_id, period, existing);
      const prior = checkpoint.get(member.complex_id, period);

      if (checkpoint.shouldSkip(member.complex_id, period)) {
        report.COMPLETE += 1;
        report.would_skip += 1;
        report.checkpoint_skipped += 1;
        plans.push({
          action: "skip",
          complex_id: member.complex_id,
          period_yyyymm: period,
          total_fee: null,
          amount_basis: CANONICAL_AMOUNT_BASIS,
          source: CANONICAL_SOURCE,
          presence,
          reason: "checkpoint COMPLETE",
        });
        results.push({
          complex_id: member.complex_id,
          period_yyyymm: period,
          amount: null,
          completeness: "COMPLETE",
          successful_ops: prior?.completed_ops ?? [],
          failed_ops: prior?.failed_ops ?? [],
          missing_ops: prior?.missing_ops ?? [],
          source: CANONICAL_SOURCE,
          amount_basis: CANONICAL_AMOUNT_BASIS,
        });
        continue;
      }

      const target = provided.get(key);
      const classified = classifyFeeMonth({
        complex_id: member.complex_id,
        period_yyyymm: period,
        observations: target?.observations ?? [],
        expectedOps,
      });

      const planBase = {
        complex_id: member.complex_id,
        period_yyyymm: period,
        amount_basis: CANONICAL_AMOUNT_BASIS,
        source: CANONICAL_SOURCE,
        presence,
      };

      if (classified.checkpoint_status === "COMPLETE" && classified.result) {
        report.COMPLETE += 1;
        const action = presence === "EXISTING" ? "update" : "insert";
        if (action === "insert") report.would_insert += 1;
        else report.would_update += 1;
        plans.push({
          ...planBase,
          action,
          total_fee: classified.amount,
          reason: presence === "EXISTING" ? "idempotent upsert" : "new complete month",
        });
        results.push(classified.result);
      } else if (classified.checkpoint_status === "PARTIAL" && classified.result) {
        report.PARTIAL += 1;
        report.would_skip += 1;
        plans.push({
          ...planBase,
          action: "skip",
          total_fee: null,
          reason: "partial response is not stored",
        });
        results.push(classified.result);
      } else if (classified.checkpoint_status === "MISSING" && classified.result) {
        report.MISSING += 1;
        report.would_skip += 1;
        plans.push({
          ...planBase,
          action: "skip",
          total_fee: null,
          reason: "missing month is not stored",
        });
        results.push(classified.result);
      } else {
        report.FAILED += 1;
        report.would_skip += 1;
        report.errors.push({
          complex_id: member.complex_id,
          period,
          message: classified.last_error ?? "failed",
        });
        plans.push({
          ...planBase,
          action: "skip",
          total_fee: null,
          reason: "failed checkpoint",
        });
      }

      checkpoint.put({
        complex_id: member.complex_id,
        period,
        status: classified.checkpoint_status,
        completed_ops: classified.successful_ops,
        failed_ops: classified.failed_ops,
        missing_ops: classified.missing_ops,
        last_error: classified.last_error,
        updated_at: now,
      });
    }
  }

  return { results, plans, report, checkpoint };
}

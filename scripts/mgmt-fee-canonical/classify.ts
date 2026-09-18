/**
 * Classify a fixture month. Missing operations are omitted from the sum.
 * They are never coerced to 0. A partial sum cannot be COMPLETE.
 */
import {
  CANONICAL_AMOUNT_BASIS,
  CANONICAL_SOURCE,
  type CanonicalFeeResult,
  type CheckpointStatus,
  type Completeness,
  type OpObservation,
} from "./types";

export type ClassifiedMonth = {
  result: CanonicalFeeResult | null;
  checkpoint_status: CheckpointStatus;
  successful_ops: string[];
  failed_ops: string[];
  missing_ops: string[];
  amount: number | null;
  last_error: string | null;
};

function isExplicitAmount(amount: number | null | undefined): amount is number {
  return typeof amount === "number" && Number.isFinite(amount);
}

export function classifyFeeMonth(args: {
  complex_id: string;
  period_yyyymm: string;
  observations: readonly OpObservation[];
  expectedOps: readonly string[];
  source?: string;
  amount_basis?: string;
}): ClassifiedMonth {
  if (args.expectedOps.length === 0) {
    throw new Error("expected ops required");
  }

  const byOp = new Map<string, OpObservation>();
  for (const obs of args.observations) {
    if (byOp.has(obs.op)) {
      throw new Error(`duplicate observation for ${obs.op}`);
    }
    byOp.set(obs.op, obs);
  }

  const successful_ops: string[] = [];
  const failed_ops: string[] = [];
  const missing_ops: string[] = [];
  const errorParts: string[] = [];
  let amountSum = 0;

  for (const op of args.expectedOps) {
    const obs = byOp.get(op);
    if (!obs || obs.state === "missing") {
      missing_ops.push(op);
      continue;
    }
    if (obs.state === "failed") {
      failed_ops.push(op);
      if (obs.error) errorParts.push(`${op}: ${obs.error}`);
      continue;
    }
    if (!isExplicitAmount(obs.amount)) {
      missing_ops.push(op);
      continue;
    }
    successful_ops.push(op);
    amountSum += obs.amount;
  }

  for (const obs of args.observations) {
    if (!args.expectedOps.includes(obs.op)) {
      errorParts.push(`unexpected op ignored: ${obs.op}`);
    }
  }

  const last_error = errorParts.length > 0 ? errorParts.join("; ") : null;
  const source = args.source ?? CANONICAL_SOURCE;
  const amount_basis = args.amount_basis ?? CANONICAL_AMOUNT_BASIS;

  if (
    successful_ops.length === args.expectedOps.length &&
    failed_ops.length === 0 &&
    missing_ops.length === 0
  ) {
    return {
      result: {
        complex_id: args.complex_id,
        period_yyyymm: args.period_yyyymm,
        amount: amountSum,
        completeness: "COMPLETE",
        successful_ops,
        failed_ops,
        missing_ops,
        source,
        amount_basis,
      },
      checkpoint_status: "COMPLETE",
      successful_ops,
      failed_ops,
      missing_ops,
      amount: amountSum,
      last_error,
    };
  }

  if (successful_ops.length === 0 && failed_ops.length === 0) {
    return {
      result: baseResult(
        args.complex_id,
        args.period_yyyymm,
        null,
        "MISSING",
        successful_ops,
        failed_ops,
        missing_ops,
        source,
        amount_basis,
      ),
      checkpoint_status: "MISSING",
      successful_ops,
      failed_ops,
      missing_ops,
      amount: null,
      last_error,
    };
  }

  if (successful_ops.length === 0 && failed_ops.length > 0) {
    return {
      result: null,
      checkpoint_status: "FAILED",
      successful_ops,
      failed_ops,
      missing_ops,
      amount: null,
      last_error: last_error ?? "all expected ops failed",
    };
  }

  return {
    result: baseResult(
      args.complex_id,
      args.period_yyyymm,
      amountSum,
      "PARTIAL",
      successful_ops,
      failed_ops,
      missing_ops,
      source,
      amount_basis,
    ),
    checkpoint_status: "PARTIAL",
    successful_ops,
    failed_ops,
    missing_ops,
    amount: amountSum,
    last_error,
  };
}

function baseResult(
  complex_id: string,
  period_yyyymm: string,
  amount: number | null,
  completeness: Completeness,
  successful_ops: string[],
  failed_ops: string[],
  missing_ops: string[],
  source: string,
  amount_basis: string,
): CanonicalFeeResult {
  return {
    complex_id,
    period_yyyymm,
    amount,
    completeness,
    successful_ops,
    failed_ops,
    missing_ops,
    source,
    amount_basis,
  };
}

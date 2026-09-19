/**
 * Resumable national fee batch planner.
 * Dry-run only: it never builds a DELETE and never writes Production.
 */
import { classifyFeeMonth } from "./classify";
import { validatePeriod } from "./cohort";
import type { LiveCall } from "./live-calls";
import { RateLimitStop, type ParsedOp } from "./live-parse";
import { OpCheckpointStore, type OpCheckpointRecord } from "./op-checkpoint";
import type { MappingState } from "./national-inventory";
import { CANONICAL_AMOUNT_BASIS, CANONICAL_SOURCE, type OpObservation } from "./types";

export const DEFAULT_CHUNK_SIZE = 25;
export const DEFAULT_SLEEP_MS = 1000;
export const MAX_COMPLEXES_PER_SIDO = 25;
export const MAX_WAVE_TARGETS = 50;
export const MAX_EXPLICIT_PERIODS = 3;

export type TargetStatus =
  | "NOT_STARTED"
  | "IN_PROGRESS"
  | "COMPLETE"
  | "PARTIAL"
  | "MISSING"
  | "FAILED"
  | "HOLD_429";

export type WriteAction = "insert" | "update" | "skip";

export type WaveComplex = {
  complex_id: string;
  sido: string;
  sido_code: string;
  kapt_code: string;
  state: MappingState;
};

export type WaveTarget = {
  complex_id: string;
  sido: string;
  sido_code: string;
  kapt_code: string;
  period: string;
};

export type TargetRecord = {
  complex_id: string;
  sido: string;
  sido_code: string;
  period: string;
  status: TargetStatus;
  amount: number | null;
  would: WriteAction;
  updated_at: string;
};

export type FetchOp = (args: {
  complex_id: string;
  kapt_code: string;
  period: string;
  service: LiveCall["service"];
  op: string;
}) => Promise<ParsedOp>;

export function parseExplicitPeriods(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.includes("-") && !trimmed.includes(",")) {
    const [start, end] = trimmed.split("-").map((part) => validatePeriod(part.trim()));
    if (!start || !end || start > end) throw new Error("invalid period range");
    const periods: string[] = [];
    let cursor = start;
    while (cursor <= end) {
      periods.push(cursor);
      if (periods.length > MAX_EXPLICIT_PERIODS) {
        throw new Error("period range exceeds 3 explicit months");
      }
      const year = Number(cursor.slice(0, 4));
      const month = Number(cursor.slice(4, 6));
      const nextMonth = month === 12 ? 1 : month + 1;
      const nextYear = month === 12 ? year + 1 : year;
      cursor = `${nextYear}${String(nextMonth).padStart(2, "0")}`;
    }
    return periods;
  }
  const periods = trimmed
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => validatePeriod(part));
  if (periods.length === 0 || periods.length > MAX_EXPLICIT_PERIODS) {
    throw new Error("explicit period list must contain 1..3 months");
  }
  return periods;
}

export function chunkItems<T>(items: readonly T[], size = DEFAULT_CHUNK_SIZE): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new Error("chunk size");
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export function planWriteAction(
  status: "COMPLETE" | "PARTIAL" | "MISSING" | "FAILED",
  exists: boolean,
): WriteAction {
  if (status !== "COMPLETE") return "skip";
  return exists ? "update" : "insert";
}

export function isTerminalTarget(status: TargetStatus): boolean {
  return status === "COMPLETE" || status === "MISSING";
}

export function planWaveCohort(args: {
  complexes: readonly WaveComplex[];
  perSido?: number;
  totalCap?: number;
}): WaveComplex[] {
  const perSido = args.perSido ?? MAX_COMPLEXES_PER_SIDO;
  const totalCap = args.totalCap ?? MAX_WAVE_TARGETS;
  const grouped = new Map<string, WaveComplex[]>();
  for (const row of args.complexes) {
    if (row.state !== "READY") continue;
    if (!/^A\d{8}$/.test(row.kapt_code)) continue;
    const list = grouped.get(row.sido_code) ?? [];
    list.push(row);
    grouped.set(row.sido_code, list);
  }
  const picked: WaveComplex[] = [];
  for (const code of [...grouped.keys()].sort()) {
    const rows = grouped.get(code) ?? [];
    rows.sort((left, right) => left.complex_id.localeCompare(right.complex_id));
    for (const row of rows.slice(0, perSido)) {
      if (picked.length >= totalCap) return picked;
      picked.push(row);
    }
  }
  return picked;
}

/** Explicit sido allow-list. Does not rank other regions in. */
export function planNamedSidoCohort(args: {
  complexes: readonly WaveComplex[];
  sidoCodes: readonly string[];
  perSido?: number;
  totalCap?: number;
}): WaveComplex[] {
  const allowed = new Set(args.sidoCodes);
  if (allowed.size === 0) throw new Error("sido allow-list empty");
  return planWaveCohort({
    complexes: args.complexes.filter((row) => allowed.has(row.sido_code)),
    perSido: args.perSido,
    totalCap: args.totalCap,
  });
}

function observationsFor(
  calls: readonly LiveCall[],
  store: OpCheckpointStore,
  complex_id: string,
  period: string,
): OpObservation[] {
  return calls.map((call) => {
    const record = store.get(complex_id, period, call.service, call.op);
    if (!record || record.status === "missing") return { op: call.op, state: "missing", amount: null };
    if (record.status === "failed") return { op: call.op, state: "failed", amount: null, error: record.error };
    return { op: call.op, state: "success", amount: record.amount };
  });
}

function monthReady(store: OpCheckpointStore, complex_id: string, period: string, calls: readonly LiveCall[]): boolean {
  return calls.every((call) => store.get(complex_id, period, call.service, call.op) != null);
}

export type WaveDryRunResult = {
  stopped: "ok" | "HOLD_429";
  api_calls: number;
  reused_ops: number;
  targets: number;
  by_sido: Array<{
    sido_code: string;
    sido: string;
    targets: number;
    COMPLETE: number;
    PARTIAL: number;
    MISSING: number;
    FAILED: number;
    would_insert: number;
    would_update: number;
  }>;
  samples: Array<{
    complex_id: string;
    sido_code: string;
    period: string;
    status: TargetStatus;
    amount: number | null;
    would: WriteAction;
  }>;
  records: TargetRecord[];
};

export async function runExpansionDryRun(args: {
  targets: readonly WaveTarget[];
  calls: readonly LiveCall[];
  fetchOp: FetchOp;
  store?: OpCheckpointStore;
  existingKeys?: ReadonlySet<string>;
  prior?: readonly TargetRecord[];
  sleepMs?: number;
  workers?: number;
  /** Defaults to the wave-1 cap. This order cannot raise it above 200. */
  maxTargets?: number;
  now?: string;
  sleep?: (ms: number) => Promise<void>;
}): Promise<WaveDryRunResult & { store: OpCheckpointStore }> {
  const workers = args.workers ?? 1;
  const sleepMs = args.sleepMs ?? DEFAULT_SLEEP_MS;
  const maxTargets = args.maxTargets ?? MAX_WAVE_TARGETS;
  if (workers !== 1 || sleepMs < DEFAULT_SLEEP_MS) throw new Error("rate policy");
  if (!Number.isInteger(maxTargets) || maxTargets < 1 || maxTargets > 200) throw new Error("wave target cap");
  if (args.targets.length > maxTargets) throw new Error("wave target cap");
  const store = args.store ?? OpCheckpointStore.empty();
  const existing = args.existingKeys ?? new Set<string>();
  const now = args.now ?? "2026-09-18T00:00:00.000Z";
  const sleep = args.sleep ?? (async () => undefined);
  const prior = new Map(args.prior?.map((row) => [`${row.complex_id}|${row.period}`, row]) ?? []);
  const records: TargetRecord[] = [];
  let apiCalls = 0;
  let reused = 0;
  let stopped: "ok" | "HOLD_429" = "ok";

  for (const target of args.targets) {
    const key = `${target.complex_id}|${target.period}`;
    const previous = prior.get(key);
    if (previous && isTerminalTarget(previous.status)) {
      records.push(previous);
      continue;
    }
    if (stopped === "HOLD_429") {
      records.push({
        complex_id: target.complex_id,
        sido: target.sido,
        sido_code: target.sido_code,
        period: target.period,
        status: "NOT_STARTED",
        amount: null,
        would: "skip",
        updated_at: now,
      });
      continue;
    }
    try {
      for (const call of args.calls) {
        if (!store.shouldFetch(target.complex_id, target.period, call.service, call.op)) {
          reused += 1;
          continue;
        }
        await sleep(sleepMs);
        const parsed = await args.fetchOp({
          complex_id: target.complex_id,
          kapt_code: target.kapt_code,
          period: target.period,
          service: call.service,
          op: call.op,
        });
        apiCalls += 1;
        const record: OpCheckpointRecord = {
          complex_id: target.complex_id,
          period: target.period,
          op: call.op,
          service: call.service,
          status: parsed.state,
          http: parsed.http,
          result_class: parsed.result_class,
          amount: parsed.amount,
          numeric_fields: parsed.numeric_fields,
          explicit_zero_fields: parsed.explicit_zero_fields,
          error: parsed.error,
          completed_at: now,
        };
        store.put(record);
      }
    } catch (error) {
      if (error instanceof RateLimitStop) {
        stopped = "HOLD_429";
        records.push({
          complex_id: target.complex_id,
          sido: target.sido,
          sido_code: target.sido_code,
          period: target.period,
          status: "HOLD_429",
          amount: null,
          would: "skip",
          updated_at: now,
        });
        continue;
      }
      throw error;
    }
    if (!monthReady(store, target.complex_id, target.period, args.calls)) {
      records.push({
        complex_id: target.complex_id,
        sido: target.sido,
        sido_code: target.sido_code,
        period: target.period,
        status: "FAILED",
        amount: null,
        would: "skip",
        updated_at: now,
      });
      continue;
    }
    const classified = classifyFeeMonth({
      complex_id: target.complex_id,
      period_yyyymm: target.period,
      expectedOps: args.calls.map((call) => call.op),
      observations: observationsFor(args.calls, store, target.complex_id, target.period),
      source: CANONICAL_SOURCE,
      amount_basis: CANONICAL_AMOUNT_BASIS,
    });
    const status: TargetStatus =
      classified.checkpoint_status === "FAILED" ? "FAILED" : classified.checkpoint_status;
    const would = planWriteAction(
      status === "FAILED" ? "FAILED" : status,
      existing.has(key),
    );
    records.push({
      complex_id: target.complex_id,
      sido: target.sido,
      sido_code: target.sido_code,
      period: target.period,
      status,
      amount: status === "COMPLETE" ? classified.amount : null,
      would,
      updated_at: now,
    });
  }

  const bySido = new Map<string, WaveDryRunResult["by_sido"][number]>();
  for (const record of records) {
    const bucket = bySido.get(record.sido_code) ?? {
      sido_code: record.sido_code,
      sido: record.sido,
      targets: 0,
      COMPLETE: 0,
      PARTIAL: 0,
      MISSING: 0,
      FAILED: 0,
      would_insert: 0,
      would_update: 0,
    };
    bucket.targets += 1;
    if (record.status === "COMPLETE" || record.status === "PARTIAL" || record.status === "MISSING" || record.status === "FAILED") {
      bucket[record.status] += 1;
    }
    if (record.would === "insert") bucket.would_insert += 1;
    if (record.would === "update") bucket.would_update += 1;
    bySido.set(record.sido_code, bucket);
  }
  return {
    stopped,
    api_calls: apiCalls,
    reused_ops: reused,
    targets: records.length,
    by_sido: [...bySido.values()],
    samples: records.slice(0, 10).map((record) => ({
      complex_id: record.complex_id,
      sido_code: record.sido_code,
      period: record.period,
      status: record.status,
      amount: record.amount,
      would: record.would,
    })),
    records,
    store,
  };
}

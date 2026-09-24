/**
 * National KAPT coverage from existing master rows and source links.
 * No name matching. Counts only; this module does not dump rows.
 */
import { validatePeriod } from "./cohort";

export const CAPITAL_SIDO_CODES = ["11", "41"] as const;
export const KAPT_CODE_RE = /^A\d{8}$/;

export type MappingState = "READY" | "ALREADY_LOADED" | "UNMAPPED" | "AMBIGUOUS";

export type ComplexInput = {
  complex_id: string;
  sido: string;
  sido_code: string;
  kapt_codes: readonly string[];
  has_fee: boolean;
};

export type SidoCoverage = {
  sido: string;
  sido_code: string;
  master: number;
  kapt_mapped: number;
  coverage_pct: number;
  existing_fee_complexes: number;
  ready_unloaded: number;
  already_loaded: number;
  unmapped: number;
  ambiguous: number;
};

export type InventorySummary = {
  national: SidoCoverage;
  by_sido: SidoCoverage[];
};

function coveragePct(mapped: number, master: number): number {
  if (master === 0) return 0;
  return Math.round((mapped / master) * 10000) / 100;
}

export function sharedKaptCodes(rows: readonly ComplexInput[]): Set<string> {
  const owners = new Map<string, Set<string>>();
  for (const row of rows) {
    for (const code of row.kapt_codes) {
      const set = owners.get(code) ?? new Set<string>();
      set.add(row.complex_id);
      owners.set(code, set);
    }
  }
  const shared = new Set<string>();
  for (const [code, ids] of owners) {
    if (ids.size > 1) shared.add(code);
  }
  return shared;
}

export function classifyComplex(row: ComplexInput, shared: ReadonlySet<string>): MappingState {
  if (row.has_fee) return "ALREADY_LOADED";
  const codes = [...new Set(row.kapt_codes)];
  if (codes.length === 0) return "UNMAPPED";
  const confirmed = codes.length === 1 && KAPT_CODE_RE.test(codes[0]) && !shared.has(codes[0]);
  return confirmed ? "READY" : "AMBIGUOUS";
}

function emptyBucket(sido: string, sido_code: string): SidoCoverage {
  return {
    sido,
    sido_code,
    master: 0,
    kapt_mapped: 0,
    coverage_pct: 0,
    existing_fee_complexes: 0,
    ready_unloaded: 0,
    already_loaded: 0,
    unmapped: 0,
    ambiguous: 0,
  };
}

function addState(bucket: SidoCoverage, state: MappingState): void {
  if (state === "READY") bucket.ready_unloaded += 1;
  else if (state === "ALREADY_LOADED") bucket.already_loaded += 1;
  else if (state === "UNMAPPED") bucket.unmapped += 1;
  else bucket.ambiguous += 1;
}

export function aggregateInventory(rows: readonly ComplexInput[]): InventorySummary {
  const shared = sharedKaptCodes(rows);
  const buckets = new Map<string, SidoCoverage>();
  const national = emptyBucket("national", "00");
  for (const row of rows) {
    const key = `${row.sido_code}|${row.sido}`;
    const bucket = buckets.get(key) ?? emptyBucket(row.sido, row.sido_code);
    const state = classifyComplex(row, shared);
    const codes = [...new Set(row.kapt_codes)];
    const confirmed = codes.length === 1 && KAPT_CODE_RE.test(codes[0] ?? "") && !shared.has(codes[0] ?? "");
    bucket.master += 1;
    national.master += 1;
    if (confirmed) {
      bucket.kapt_mapped += 1;
      national.kapt_mapped += 1;
    }
    if (row.has_fee) {
      bucket.existing_fee_complexes += 1;
      national.existing_fee_complexes += 1;
    }
    addState(bucket, state);
    addState(national, state);
    buckets.set(key, bucket);
  }
  const finalize = (bucket: SidoCoverage): SidoCoverage => ({
    ...bucket,
    coverage_pct: coveragePct(bucket.kapt_mapped, bucket.master),
  });
  const by_sido = [...buckets.values()]
    .map(finalize)
    .sort((left, right) => left.sido_code.localeCompare(right.sido_code) || left.sido.localeCompare(right.sido));
  return { national: finalize(national), by_sido };
}

export function selectWaveSidos(bySido: readonly SidoCoverage[], limit = 2): SidoCoverage[] {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("wave sido limit");
  const excluded = new Set<string>(CAPITAL_SIDO_CODES);
  return bySido
    .filter((row) => !excluded.has(row.sido_code) && row.ready_unloaded > 0 && row.kapt_mapped > 0)
    .sort((left, right) => {
      if (right.kapt_mapped !== left.kapt_mapped) return right.kapt_mapped - left.kapt_mapped;
      if (right.coverage_pct !== left.coverage_pct) return right.coverage_pct - left.coverage_pct;
      if (right.ready_unloaded !== left.ready_unloaded) return right.ready_unloaded - left.ready_unloaded;
      return left.sido_code.localeCompare(right.sido_code);
    })
    .slice(0, limit);
}

export function previousPeriod(period: string): string {
  const current = validatePeriod(period);
  const year = Number(current.slice(0, 4));
  const month = Number(current.slice(4, 6));
  const nextMonth = month === 1 ? 12 : month - 1;
  const nextYear = month === 1 ? year - 1 : year;
  return `${nextYear}${String(nextMonth).padStart(2, "0")}`;
}

/** Explicit ceiling plus a bounded lookback. Not a rolling 12-month window. */
export function buildProbePeriods(ceiling: string, lookback: number): string[] {
  if (!Number.isInteger(lookback) || lookback < 1 || lookback > 3) {
    throw new Error("probe lookback must be 1..3");
  }
  const periods: string[] = [];
  let cursor = validatePeriod(ceiling);
  for (let i = 0; i < lookback; i += 1) {
    periods.push(cursor);
    cursor = previousPeriod(cursor);
  }
  return periods;
}

export function choosePublishedPeriod(
  probes: readonly { period: string; published: boolean }[],
): string | null {
  const ordered = [...probes].sort((left, right) => right.period.localeCompare(left.period));
  return ordered.find((row) => row.published)?.period ?? null;
}

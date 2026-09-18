/**
 * Fixed real-sample scope. Explicit cohort kapt codes only.
 * 은마 202607 has no production row. The other three targets do.
 */
import { validatePeriod } from "./cohort";

export function assertReadOnlySql(sql: string): void {
  if (/\b(insert|update|delete|alter|drop|create|replace)\b/i.test(sql)) {
    throw new Error("production write forbidden");
  }
  if (!/^\s*select\b/i.test(sql)) throw new Error("read-only select required");
}

export type RealSampleTarget = {
  complex_id: string;
  kapt_code: string;
  region: "seoul" | "gyeonggi";
  period_yyyymm: string;
};

export const REAL_SAMPLE_TARGETS: readonly RealSampleTarget[] = [
  {
    complex_id: "cx_4c63d9a100973c60",
    kapt_code: "A13822004",
    region: "seoul",
    period_yyyymm: "202607",
  },
  {
    complex_id: "cx_4c63d9a100973c60",
    kapt_code: "A13822004",
    region: "seoul",
    period_yyyymm: "202608",
  },
  {
    complex_id: "cx_ec9a204afeaadf1b",
    kapt_code: "A14003105",
    region: "seoul",
    period_yyyymm: "202607",
  },
  {
    complex_id: "cx_0320fd9e007e1f8c",
    kapt_code: "A13583507",
    region: "seoul",
    period_yyyymm: "202607",
  },
];

export function assertSampleScope(targets: readonly RealSampleTarget[]): void {
  if (targets.length === 0) throw new Error("sample is empty");
  if (targets.length > 15) throw new Error(`target-month cap exceeded: ${targets.length}`);
  const complexes = new Set<string>();
  const perComplex = new Map<string, number>();
  const seen = new Set<string>();
  for (const target of targets) {
    if (!/^cx_[a-z0-9_]+$/i.test(target.complex_id)) {
      throw new Error(`explicit complex_id required: ${target.complex_id}`);
    }
    if (!/^A\d{8}$/.test(target.kapt_code)) {
      throw new Error(`explicit kapt_code required: ${target.complex_id}`);
    }
    validatePeriod(target.period_yyyymm);
    complexes.add(target.complex_id);
    perComplex.set(target.complex_id, (perComplex.get(target.complex_id) ?? 0) + 1);
    const key = `${target.complex_id}|${target.period_yyyymm}`;
    if (seen.has(key)) throw new Error(`duplicate target ${key}`);
    seen.add(key);
  }
  if (complexes.size > 5) throw new Error(`complex cap exceeded: ${complexes.size}`);
  for (const [complex_id, count] of perComplex) {
    if (count > 3) throw new Error(`period cap exceeded for ${complex_id}: ${count}`);
  }
}

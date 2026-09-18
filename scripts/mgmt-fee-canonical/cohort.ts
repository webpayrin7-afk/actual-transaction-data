/**
 * Sample cohort rules for a later expansion.
 * Explicit complex_id only. No apt_name_norm lookup. No rolling 12-month window.
 */
import { DEFAULT_COHORT_CAP, type RowPresence, type SampleMember } from "./types";

const COMPLEX_ID_RE = /^cx_[a-z0-9_]+$/i;
const PERIOD_RE = /^(\d{4})(\d{2})$/;

export function validatePeriod(period: string): string {
  const match = PERIOD_RE.exec(period);
  if (!match) {
    throw new Error(`invalid period '${period}': expected YYYYMM`);
  }
  const month = Number(match[2]);
  if (month < 1 || month > 12) {
    throw new Error(`invalid period '${period}': month out of range`);
  }
  return period;
}

/** Explicit list only. Does not expand a start/end into a rolling window. */
export function parsePeriodList(raw: string): string[] {
  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) {
    throw new Error("at least one explicit period is required");
  }
  return parts.map(validatePeriod);
}

export function prepareSampleCohort(
  members: readonly SampleMember[],
  cap: number = DEFAULT_COHORT_CAP,
): SampleMember[] {
  if (!Number.isInteger(cap) || cap < 1) {
    throw new Error("cohort cap must be a positive integer");
  }
  if (members.length === 0) {
    throw new Error("cohort is empty");
  }
  if (members.length > cap) {
    throw new Error(`cohort cap ${cap} exceeded: ${members.length}`);
  }
  const seen = new Set<string>();
  const prepared: SampleMember[] = [];
  for (const member of members) {
    const complex_id = member.complex_id?.trim() ?? "";
    if (!COMPLEX_ID_RE.test(complex_id)) {
      throw new Error(
        `explicit complex_id required (cx_...), got '${member.complex_id}'`,
      );
    }
    if (seen.has(complex_id)) {
      throw new Error(`duplicate complex_id ${complex_id}`);
    }
    seen.add(complex_id);
    if (
      member.region != null &&
      member.region !== "seoul" &&
      member.region !== "gyeonggi"
    ) {
      throw new Error(`unsupported region '${String(member.region)}'`);
    }
    prepared.push({
      complex_id,
      ...(member.region ? { region: member.region } : {}),
    });
  }
  return prepared;
}

export function feeRowKey(complex_id: string, period_yyyymm: string): string {
  return `${complex_id}|${period_yyyymm}`;
}

export function rowPresence(
  complex_id: string,
  period_yyyymm: string,
  existingKeys: ReadonlySet<string>,
): RowPresence {
  return existingKeys.has(feeRowKey(complex_id, period_yyyymm))
    ? "EXISTING"
    : "NEW";
}

/**
 * Deterministic household read from building-title rows.
 * Ambiguous, fuzzy, or double-counted title sets stay unresolved.
 */

export type TitleRow = {
  bldNm?: string | null;
  dongNm?: string | null;
  mainPurpsCdNm?: string | null;
  hhldCnt?: unknown;
};

function normName(value: string): string {
  return value.replace(/\s+/g, "").replace(/아파트$/, "");
}

function countInt(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return null;
  return n;
}

function combinedPhases(name: string): boolean {
  return (name.includes("1차") && name.includes("2차")) || name.includes("1,2");
}

/**
 * Accept one exact-name residential set.
 * A zero household title row is a real zero, not a missing value.
 * A blank count stays unresolved.
 * A summary row whose count equals the other rows is kept once.
 * Duplicate dong labels are rejected.
 */
export function householdFromTitleRows(rows: readonly TitleRow[], complexName: string): number | null {
  const target = normName(complexName);
  if (!target) return null;
  const residential = rows.filter((row) => /공동주택|아파트/.test(String(row.mainPurpsCdNm ?? "")));
  const named = residential.filter((row) => normName(String(row.bldNm ?? "")) === target);
  if (named.length === 0) return null;
  if (named.some((row) => combinedPhases(normName(String(row.bldNm ?? ""))) && !combinedPhases(target))) {
    return null;
  }
  const labels = named.map((row) => normName(String(row.dongNm ?? row.bldNm ?? "")));
  if (new Set(labels).size !== labels.length) return null;
  const counts = named.map((row) => countInt(row.hhldCnt));
  if (counts.some((value) => value == null)) return null;
  const present = counts as number[];
  if (present.length === 0 || present.every((value) => value === 0)) return null;
  if (present.length === 1) return present[0]!;
  const sum = present.reduce((total, value) => total + value, 0);
  for (const count of present) {
    const rest = sum - count;
    if (rest > 0 && count === rest) return count;
  }
  return sum;
}

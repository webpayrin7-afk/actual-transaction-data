/** NEIS ↔ SchoolInfo identity (runtime only). */

export const SEOUL_SIDO = "11";
export const SONGPA_SGG = "11710";

export const KIND = {
  elementary: "02",
  middle: "03",
  high: "04",
} as const;

export type Kind = keyof typeof KIND;

export function years(now = new Date()): number[] {
  const y = now.getFullYear();
  return [y, y - 1, y - 2];
}

export function normName(name: string): string {
  return name.replace(/\s+/g, "").trim();
}

export function pickByCode(
  rows: Record<string, unknown>[],
  schoolCode: string,
): Record<string, unknown> | null {
  const code = schoolCode.trim();
  if (!code) return null;
  for (const row of rows) {
    const c = String(row.SCHUL_CODE ?? row.SD_SCHUL_CODE ?? "").trim();
    if (c === code) return row;
  }
  return null;
}

/** Exact name within region/kind list — never name-only global id. */
export function pickByName(
  rows: Record<string, unknown>[],
  name: string,
): Record<string, unknown> | null {
  const target = normName(name);
  if (!target) return null;
  const hits = rows.filter((r) => normName(String(r.SCHUL_NM ?? "")) === target);
  return hits.length === 1 ? hits[0]! : null;
}

export function codeOf(row: Record<string, unknown> | null): string | null {
  if (!row) return null;
  const c = String(row.SCHUL_CODE ?? row.SD_SCHUL_CODE ?? "").trim();
  return c || null;
}

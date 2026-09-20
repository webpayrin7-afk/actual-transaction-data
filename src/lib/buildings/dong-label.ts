import type { DongLabelStatus } from "./types";

export function officialDongLabel(raw: unknown): {
  dongLabel: string | null;
  status: DongLabelStatus;
} {
  const label = raw == null ? "" : String(raw).trim();
  if (!label) {
    return { dongLabel: null, status: "MISSING_DONG_LABEL" };
  }
  return { dongLabel: label, status: "EXACT_DONG_LABEL" };
}

/**
 * Match key for two official dong labels (101동 vs 101).
 * Does not invent numbers; only normalizes existing official text.
 */
export function dongMatchKey(label: string | null | undefined): string | null {
  if (!label) return null;
  const compact = label.replace(/\s+/g, "").replace(/동$/u, "");
  if (!compact) return null;
  if (/^\d+$/.test(compact)) return String(Number(compact));
  return compact;
}

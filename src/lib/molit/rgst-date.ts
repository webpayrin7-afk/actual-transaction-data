/**
 * MOLIT AptTrade rgstDate helpers.
 * Official public start: contracts from 2023-01-01.
 * Raw forms seen: "24.04.19" (YY.MM.DD). Store ISO YYYY-MM-DD when valid.
 */

export const RGST_PUBLIC_START = "2023-01-01";

/** Normalize MOLIT rgstDate to YYYY-MM-DD, or null if empty/unparseable. */
export function normalizeMolitRgstDate(
  raw: string | null | undefined,
): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const dotted = /^(\d{2})\.(\d{2})\.(\d{2})$/.exec(s);
  if (dotted) {
    const yy = Number(dotted[1]);
    const mm = dotted[2];
    const dd = dotted[3];
    const year = yy >= 70 ? 1900 + yy : 2000 + yy;
    return `${year}-${mm}-${dd}`;
  }
  return null;
}

/** Persistable value from a Transaction (top-level or ingestMeta). */
export function rgstDateFromTx(tx: {
  rgstDate?: string | null;
  ingestMeta?: { rgstDate?: string };
}): string | null {
  if (tx.rgstDate != null && String(tx.rgstDate).trim()) {
    return normalizeMolitRgstDate(String(tx.rgstDate));
  }
  return normalizeMolitRgstDate(tx.ingestMeta?.rgstDate);
}

export type RegistrationDisplay = "등기완료" | "등기 미확인" | null;

/**
 * UI label for 매매 등기 column.
 * - rgstDate present → 등기완료 (never invent 미등기)
 * - dealDate >= 2023-01-01 and no rgstDate → 등기 미확인
 * - pre-2023 → null (render — / omit emphasis)
 */
export function archiveRegistrationLabel(
  dealDate: string,
  rgstDate: string | null | undefined,
): RegistrationDisplay {
  const normalized = normalizeMolitRgstDate(rgstDate ?? "");
  if (normalized) return "등기완료";
  const day = (dealDate ?? "").slice(0, 10);
  if (day >= RGST_PUBLIC_START) return "등기 미확인";
  return null;
}

/** Tooltip / title helper — registration date only when known. */
export function archiveRegistrationDateTitle(
  rgstDate: string | null | undefined,
): string | undefined {
  const iso = normalizeMolitRgstDate(rgstDate ?? "");
  if (!iso) return undefined;
  return `등기일 ${iso.slice(0, 4)}.${iso.slice(5, 7)}.${iso.slice(8, 10)}`;
}

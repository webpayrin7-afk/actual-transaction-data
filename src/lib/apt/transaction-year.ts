/** Transaction-history archive year filter (URL + SQL window). */

export type TransactionYear = "all" | `${number}`;

export function parseTransactionYear(
  raw: string | null | undefined,
): TransactionYear {
  const v = raw?.trim() ?? "";
  if (
    !v ||
    v === "all" ||
    v === "full" ||
    v === "전체" ||
    v === "전체년도" ||
    v === "1y" ||
    v === "3y" ||
    v === "5y"
  ) {
    return "all";
  }
  const digits = v.replace(/년$/, "");
  if (/^\d{4}$/.test(digits)) {
    const y = Number(digits);
    if (y >= 1990 && y <= 2100) return String(y) as TransactionYear;
  }
  return "all";
}

/** Inclusive YYYYMM bounds for a calendar year. `all` = unbounded warehouse. */
export function yearMonthBound(
  year: TransactionYear,
): { from: string; to: string } | null {
  if (year === "all") return null;
  const y = Number(year);
  if (!Number.isFinite(y)) return null;
  return { from: `${y}01`, to: `${y}12` };
}

/** 12 YYYYMM keys for a calendar year (legacy helper). */
export function yearMonthsForYear(year: TransactionYear): string[] {
  const bound = yearMonthBound(year);
  if (!bound) return [];
  const y = bound.from.slice(0, 4);
  return Array.from({ length: 12 }, (_, i) => {
    const m = String(i + 1).padStart(2, "0");
    return `${y}${m}`;
  });
}

export function transactionYearLabel(year: TransactionYear): string {
  if (year === "all") return "전체년도";
  return `${year}년`;
}

export function kpiHintForYear(year: TransactionYear): string {
  return transactionYearLabel(year);
}

export function kpiDateShort(dealDate: string): string {
  if (!dealDate || dealDate.length < 7) return dealDate;
  return `${dealDate.slice(0, 4)}.${dealDate.slice(5, 7)}`;
}

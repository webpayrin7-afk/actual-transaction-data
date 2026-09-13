/** Transaction-history archive period (URL + query bound). */

export type TransactionPeriod = "1y" | "3y" | "5y" | "all";

export const TRANSACTION_PERIODS: Array<{
  value: TransactionPeriod;
  label: string;
  months: number;
}> = [
  { value: "1y", label: "1년", months: 12 },
  { value: "3y", label: "3년", months: 36 },
  { value: "5y", label: "5년", months: 60 },
  { value: "all", label: "전체", months: 120 },
];

/** Default matches Complex Detail market preset (recent3). */
export const DEFAULT_TRANSACTION_PERIOD: TransactionPeriod = "3y";

export function parseTransactionPeriod(
  raw: string | null | undefined,
): TransactionPeriod {
  if (raw === "1y" || raw === "3y" || raw === "5y" || raw === "all") return raw;
  // Aliases
  if (raw === "1" || raw === "12m" || raw === "recent1") return "1y";
  if (raw === "3" || raw === "36m" || raw === "recent3") return "3y";
  if (raw === "5" || raw === "60m" || raw === "recent5") return "5y";
  if (raw === "full" || raw === "120m") return "all";
  return DEFAULT_TRANSACTION_PERIOD;
}

export function transactionPeriodMonths(period: TransactionPeriod): number {
  const found = TRANSACTION_PERIODS.find((p) => p.value === period);
  return found?.months ?? 36;
}

export function transactionPeriodLabel(period: TransactionPeriod): string {
  return TRANSACTION_PERIODS.find((p) => p.value === period)?.label ?? "3년";
}

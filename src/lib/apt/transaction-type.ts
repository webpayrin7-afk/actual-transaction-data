import type { AptHistoryItem } from "@/lib/molit/apt-client";

export type TransactionTabType = "trade" | "jeonse" | "monthly";

export const TRANSACTION_TABS: Array<{
  value: TransactionTabType;
  label: string;
}> = [
  { value: "trade", label: "매매" },
  { value: "jeonse", label: "전세" },
  { value: "monthly", label: "월세" },
];

export function parseTransactionTabType(
  raw: string | null | undefined,
): TransactionTabType {
  if (raw === "jeonse" || raw === "monthly" || raw === "trade") return raw;
  // URL aliases from product docs / external links
  if (raw === "sale") return "trade";
  if (raw === "wolse" || raw === "rent-monthly") return "monthly";
  if (raw === "rent" || raw === "jeonse-only") return "jeonse";
  return "trade";
}

/** Stable URL identity — sale | jeonse | monthly (not display strings). */
export function transactionTypeToParam(type: TransactionTabType): string {
  if (type === "trade") return "sale";
  return type;
}

export function transactionTypeLabel(type: TransactionTabType): string {
  return TRANSACTION_TABS.find((t) => t.value === type)?.label ?? "매매";
}

/** Unique price ink per deal type (매매 teal / 전세 orange / 월세 indigo). */
export function dealTypePriceTextClass(type: TransactionTabType): string {
  if (type === "jeonse") return "text-[color:var(--lab-price-jeonse)]";
  if (type === "monthly") return "text-[color:var(--lab-price-monthly)]";
  return "text-[color:var(--lab-price-trade)]";
}

export function matchesTransactionTab(
  tx: AptHistoryItem,
  type: TransactionTabType,
): boolean {
  if (type === "trade") return tx.dealType === "trade";
  if (type === "jeonse") {
    return tx.dealType === "rent" && Number(tx.monthlyRent ?? 0) === 0;
  }
  return tx.dealType === "rent" && Number(tx.monthlyRent ?? 0) > 0;
}

/** Newest first; stable by id for ties. */
export function filterTransactionsByType(
  items: AptHistoryItem[],
  type: TransactionTabType,
): AptHistoryItem[] {
  return items
    .filter((tx) => matchesTransactionTab(tx, type))
    .sort((a, b) => {
      if (a.dealDate < b.dealDate) return 1;
      if (a.dealDate > b.dealDate) return -1;
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    });
}

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
  return "trade";
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

import type { TransactionTabType } from "@/lib/apt/transaction-type";

/**
 * 전세/월세 계약구분 — source-backed only.
 * MOLIT contractType is persisted as dealingGbn ("신규"|"갱신").
 * 매매 does not render this column (no registration/cancel invent).
 * Do not invent 신규 when dealingGbn is null/other.
 */
export function archiveContractTypeLabel(
  mode: TransactionTabType,
  dealingGbn: string | null | undefined,
): "신규" | "갱신" | null {
  if (mode === "trade") return null;
  const g = (dealingGbn ?? "").trim();
  if (g === "신규" || g === "신규계약") return "신규";
  if (g === "갱신" || g === "갱신계약") return "갱신";
  return null;
}

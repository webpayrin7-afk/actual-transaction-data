import type { TransactionTabType } from "@/lib/apt/transaction-type";

/**
 * Archive status badge — only when source-backed.
 * - 매매: registration (등기/미등기) is NOT stored in warehouse → never invent.
 * - 전세/월세: MOLIT contractType persisted as dealingGbn ("신규"|"갱신").
 */
export function archiveStatusLabel(
  mode: TransactionTabType,
  dealingGbn: string | null | undefined,
): "신규" | "갱신" | null {
  if (mode === "trade") return null;
  const g = (dealingGbn ?? "").trim();
  if (g === "신규" || g === "갱신") return g;
  return null;
}

/**
 * Building/단지 동 for 거래동 column.
 * Warehouse stores legal 법정동 only (`dong`); MOLIT aptDong is ingest-only.
 * Do not display legal dong as 거래동. Do not infer.
 */
export function archiveBuildingDongLabel(_tx: {
  dong?: string;
}): string | null {
  return null;
}

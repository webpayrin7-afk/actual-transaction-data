import type { TransactionTabType } from "@/lib/apt/transaction-type";

/**
 * Archive status badge — only when source-backed.
 * - 매매: MOLIT has rgstDate in ingestMeta only; warehouse has NO registration
 *   column → never invent 등기/미등기 (do not infer from age/price/floor).
 * - 전세/월세: MOLIT contractType persisted as dealingGbn ("신규"|"갱신").
 */
export function archiveStatusLabel(
  mode: TransactionTabType,
  dealingGbn: string | null | undefined,
): "신규" | "갱신" | null {
  if (mode === "trade") return null;
  const g = (dealingGbn ?? "").trim();
  if (g === "신규" || g === "신규계약") return "신규";
  if (g === "갱신" || g === "갱신계약") return "갱신";
  return null;
}

/**
 * Building/단지 동 for 거래동 column.
 * Warehouse `dong` = legal 법정동 (umdNm), NOT apartment building dong.
 * MOLIT sale aptDong exists in ingestMeta only and is not persisted.
 * Jeonse/monthly MOLIT payloads have no aptDong.
 * Do not display legal dong as 거래동. Do not infer from GIS/Building Hub.
 */
export function archiveBuildingDongLabel(_tx?: {
  dong?: string;
}): string | null {
  void _tx;
  return null;
}

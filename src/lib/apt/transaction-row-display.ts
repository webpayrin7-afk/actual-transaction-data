import type { TransactionTabType } from "@/lib/apt/transaction-type";

export type ArchiveStatus = "신규" | "갱신" | "등기" | "미등기";

/**
 * Archive status badge — only when source-backed.
 * - 매매: 국토부 등기일(rgstDate, 2023년 거래부터). 있으면 "등기", 없으면 표시 안 함.
 * - 전세/월세: MOLIT contractType persisted as dealingGbn ("신규"|"갱신").
 */
export function archiveStatusLabel(
  mode: TransactionTabType,
  dealingGbn: string | null | undefined,
  trade?: { rgstDate?: string | null },
): ArchiveStatus | null {
  if (mode === "trade") {
    if (!trade || trade.rgstDate === undefined) return null;
    // 미등기는 등기일 갱신(최근 6개월 다시 읽기)이 매일 돌 때만 믿을 수 있다 — 연결 전까지는 등기만 표시
    return trade.rgstDate ? "등기" : null;
  }
  const g = (dealingGbn ?? "").trim();
  if (g === "신규" || g === "신규계약") return "신규";
  if (g === "갱신" || g === "갱신계약") return "갱신";
  return null;
}

/**
 * Building/단지 동 for 거래동 column.
 * Warehouse `dong` = legal 법정동 (umdNm), NOT apartment building dong.
 * 매매는 국토부 aptDong을 transactions.apt_dong에 저장한 것만 (등기된 2023년 이후 거래).
 * Jeonse/monthly MOLIT payloads have no aptDong.
 * Do not display legal dong as 거래동. Do not infer from GIS/Building Hub.
 */
export function archiveBuildingDongLabel(tx?: { aptDong?: string | null }): string | null {
  const d = (tx?.aptDong ?? "").trim();
  if (!d) return null;
  return /동$/.test(d) ? d : `${d}동`;
}

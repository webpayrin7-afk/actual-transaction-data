import type { Transaction } from "@/types/transaction";

/** sync dirty-check에 쓰는 거래 본문 스냅샷 (자연키 + 표시/보조 필드). */
export type TxContentSnapshot = {
  dealDate: string;
  aptName: string;
  gu: string;
  dong: string;
  exclusiveArea: number;
  dealAmount: number;
  monthlyRent: number;
  floor: number;
  buildYear: number | null;
  jibun: string;
  dealingGbn: string;
};

export function roundExclusiveArea(area: number): number {
  return Math.round(area * 100) / 100;
}

export function snapshotFromTx(tx: Transaction): TxContentSnapshot {
  return {
    dealDate: tx.dealDate.slice(0, 10),
    aptName: tx.aptName,
    gu: tx.gu ?? "",
    dong: tx.dong ?? "",
    exclusiveArea: Number(tx.exclusiveArea) || 0,
    dealAmount: Number(tx.dealAmount) || 0,
    monthlyRent: Number(tx.monthlyRent) || 0,
    floor: Number(tx.floor) || 0,
    buildYear: tx.buildYear == null ? null : Number(tx.buildYear),
    jibun: tx.jibun ?? "",
    dealingGbn: tx.dealingGbn ?? "",
  };
}

/**
 * 기존 DB row와 API row 본문이 같은지 비교.
 * id / first_seen_at / last_seen_at / XML index는 비교하지 않는다.
 */
export function isSameTransactionContent(
  existing: TxContentSnapshot,
  incoming: TxContentSnapshot,
): boolean {
  return (
    existing.dealDate.slice(0, 10) === incoming.dealDate.slice(0, 10) &&
    existing.aptName === incoming.aptName &&
    existing.gu === incoming.gu &&
    existing.dong.trim() === incoming.dong.trim() &&
    roundExclusiveArea(existing.exclusiveArea) ===
      roundExclusiveArea(incoming.exclusiveArea) &&
    existing.dealAmount === incoming.dealAmount &&
    existing.monthlyRent === incoming.monthlyRent &&
    existing.floor === incoming.floor &&
    (existing.buildYear ?? null) === (incoming.buildYear ?? null) &&
    existing.jibun.trim() === incoming.jibun.trim() &&
    existing.dealingGbn === incoming.dealingGbn
  );
}

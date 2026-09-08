import type { DealType, Transaction } from "@/types/transaction";

function normApt(name: string): string {
  return name.replace(/\s+/g, "").toLowerCase();
}

/**
 * 거래 자연키 — sync 재실행·ID 포맷 변경 시에도 동일 거래로 매칭.
 * XML 순서(index)는 포함하지 않는다.
 */
export function transactionNaturalKey(params: {
  dealType: DealType;
  lawdCd: string;
  dong: string;
  jibun: string;
  aptName: string;
  floor: number;
  exclusiveArea: number;
  dealAmount: number;
  monthlyRent: number;
  dealDate: string;
}): string {
  const area = Math.round(params.exclusiveArea * 100) / 100;
  return [
    params.dealType,
    params.lawdCd,
    params.dong.trim(),
    params.jibun.trim(),
    normApt(params.aptName),
    String(params.floor),
    String(area),
    String(params.dealAmount),
    String(params.monthlyRent),
    params.dealDate.slice(0, 10),
  ].join("|");
}

export function naturalKeyFromTx(
  tx: Transaction,
  lawdCd: string,
): string {
  return transactionNaturalKey({
    dealType: tx.dealType,
    lawdCd,
    dong: tx.dong,
    jibun: tx.jibun,
    aptName: tx.aptName,
    floor: tx.floor,
    exclusiveArea: tx.exclusiveArea,
    dealAmount: tx.dealAmount,
    monthlyRent: tx.monthlyRent,
    dealDate: tx.dealDate,
  });
}

/** index 없는 안정 ID. 배치 내 충돌 시 suffix. */
export function stableTransactionId(
  tx: Omit<Transaction, "id"> & { lawdCd: string },
  collisionIndex = 0,
): string {
  const base = [
    tx.dealType,
    tx.lawdCd,
    tx.dealDate.slice(0, 10),
    tx.aptName.replace(/\s+/g, ""),
    tx.dong.replace(/\s+/g, ""),
    tx.jibun.replace(/\s+/g, ""),
    String(tx.floor),
    String(tx.dealAmount),
    String(tx.monthlyRent),
    String(Math.round(tx.exclusiveArea * 100) / 100),
  ].join("-");
  return collisionIndex > 0 ? `${base}~${collisionIndex}` : base;
}

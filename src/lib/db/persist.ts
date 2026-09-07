import type { DealType, Transaction } from "@/types/transaction";
import { hasDb } from "@/lib/db/client";

/** MOLIT에서 받은 월 단위 결과를 웨어하우스에 비동기 적재 (실패해도 본 요청은 유지) */
export function persistMonthInBackground(params: {
  lawdCd: string;
  yearMonth: string;
  dealKind: DealType;
  items: Transaction[];
}): void {
  if (!hasDb()) return;
  void (async () => {
    try {
      const { replaceMonthTransactions } = await import("@/lib/db/repository");
      await replaceMonthTransactions(params);
    } catch (err) {
      console.warn(
        "[db] persist failed",
        params.dealKind,
        params.lawdCd,
        params.yearMonth,
        err,
      );
    }
  })();
}

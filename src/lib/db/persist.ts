import type { DealType, Transaction } from "@/types/transaction";

/**
 * LEGACY no-op.
 *
 * User request paths (apt-suggest / region / apt-detail MOLIT fallback) must
 * not write the warehouse. Historical rows were previously inserted with
 * setFirstSeenOnInsert defaulting to true, which treated backfill as
 * “today’s newly discovered deals”.
 *
 * Scheduled ingestion (`scripts/sync-molit.ts`) is the only writer.
 * `--discovery=1` (daily) vs `--discovery=0` (historical) is explicit there.
 */
export function persistMonthInBackground(params: {
  lawdCd: string;
  yearMonth: string;
  dealKind: DealType;
  items: Transaction[];
}): void {
  void params;
}

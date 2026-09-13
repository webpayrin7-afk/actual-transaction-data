import type { AptAreaOption, AptHistoryItem } from "@/lib/molit/apt-client";
import type { TransactionTabType } from "@/lib/apt/transaction-type";
import type { TransactionYear } from "@/lib/apt/transaction-year";

export type AptArchiveHigh = { amount: number; date: string } | null;

export type AptTransactionArchiveKpi = {
  saleHigh: AptArchiveHigh;
  jeonseHigh: AptArchiveHigh;
  monthlyDepositHigh: AptArchiveHigh;
  monthlyRentHigh: AptArchiveHigh;
  tradeCount: number;
  jeonseCount: number;
  monthlyCount: number;
};

export type AptTransactionArchiveResponse = {
  aptName: string;
  regionSlug: string;
  years: number[];
  year: TransactionYear;
  areas: AptAreaOption[];
  areaKey: string;
  type: TransactionTabType;
  items: AptHistoryItem[];
  offset: number;
  limit: number;
  total: number;
  hasMore: boolean;
  kpi: AptTransactionArchiveKpi;
  timingMs: Record<string, number>;
  /** False on offset>0 pages — client must keep first-page years/KPI/counts. */
  metaIncluded?: boolean;
};

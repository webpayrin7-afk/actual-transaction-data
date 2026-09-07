"use client";

import { useQuery } from "@tanstack/react-query";
import type {
  AreaFilter,
  DealType,
  TransactionsResponse,
} from "@/types/transaction";

export interface TransactionQueryParams {
  aptName: string;
  gu: string;
  dong: string;
  dealType: DealType | "all";
  area: AreaFilter;
  yearMonth: string;
  page: number;
  pageSize: number;
  region: string;
}

async function fetchTransactions(
  params: TransactionQueryParams,
): Promise<TransactionsResponse> {
  const qs = new URLSearchParams({
    aptName: params.aptName,
    gu: params.gu,
    dong: params.dong,
    dealType: params.dealType,
    area: params.area,
    yearMonth: params.yearMonth,
    page: String(params.page),
    pageSize: String(params.pageSize),
    region: params.region,
  });

  const res = await fetch(`/api/transactions?${qs.toString()}`);
  if (!res.ok) {
    throw new Error("Failed to fetch transactions");
  }
  return res.json();
}

export function useTransactions(params: TransactionQueryParams) {
  return useQuery({
    queryKey: ["transactions", params],
    queryFn: () => fetchTransactions(params),
    placeholderData: (prev) => prev,
  });
}

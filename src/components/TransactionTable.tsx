"use client";

import { Inbox } from "lucide-react";
import {
  dealTypeLabel,
  formatArea,
  formatDealAmount,
  formatDealDate,
} from "@/lib/utils/format";
import type { Transaction } from "@/types/transaction";

interface TransactionTableProps {
  items: Transaction[];
  isLoading: boolean;
}

export function TransactionTable({ items, isLoading }: TransactionTableProps) {
  if (isLoading) {
    return (
      <div className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white/90 shadow-sm">
        <div className="space-y-3 p-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className="h-10 animate-pulse rounded-lg bg-slate-100"
            />
          ))}
        </div>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-white/70 px-6 py-16 text-center">
        <Inbox className="mb-3 h-10 w-10 text-slate-300" />
        <p className="text-sm font-medium text-slate-700">조회된 거래가 없습니다</p>
        <p className="mt-1 text-xs text-slate-500">
          필터 조건이나 계약년월을 바꿔 다시 조회해 보세요.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white/90 shadow-sm">
      <div className="overflow-x-auto">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-slate-50/90 text-xs tracking-wide text-slate-500 uppercase">
            <tr>
              <th className="px-4 py-3 font-medium whitespace-nowrap">계약일자</th>
              <th className="px-4 py-3 font-medium whitespace-nowrap">유형</th>
              <th className="px-4 py-3 font-medium whitespace-nowrap">단지명</th>
              <th className="px-4 py-3 font-medium whitespace-nowrap">법정동</th>
              <th className="px-4 py-3 font-medium whitespace-nowrap">전용면적</th>
              <th className="px-4 py-3 font-medium whitespace-nowrap">거래금액</th>
              <th className="px-4 py-3 font-medium whitespace-nowrap">층</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {items.map((tx) => (
              <tr
                key={tx.id}
                className="transition hover:bg-teal-50/40"
              >
                <td className="px-4 py-3 whitespace-nowrap text-slate-700">
                  {formatDealDate(tx.dealDate)}
                </td>
                <td className="px-4 py-3 whitespace-nowrap">
                  <span
                    className={`inline-flex rounded-md px-2 py-0.5 text-xs font-medium ${
                      tx.dealType === "trade"
                        ? "bg-teal-50 text-teal-700"
                        : "bg-indigo-50 text-indigo-700"
                    }`}
                  >
                    {dealTypeLabel(tx.dealType)}
                  </span>
                </td>
                <td className="px-4 py-3 font-medium text-slate-900">
                  {tx.aptName}
                </td>
                <td className="px-4 py-3 whitespace-nowrap text-slate-600">
                  {tx.dong}
                </td>
                <td className="px-4 py-3 whitespace-nowrap text-slate-600">
                  {formatArea(tx.exclusiveArea)}
                </td>
                <td className="px-4 py-3 whitespace-nowrap font-semibold text-slate-900">
                  {formatDealAmount(tx)}
                </td>
                <td className="px-4 py-3 whitespace-nowrap text-slate-600">
                  {tx.floor}층
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

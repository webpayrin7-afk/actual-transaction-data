"use client";

import { Flame } from "lucide-react";
import type { AptHistoryItem } from "@/lib/molit/apt-client";
import {
  formatArea,
  formatDealDate,
  formatEok,
} from "@/lib/utils/format";
import type { TransactionTabType } from "@/lib/apt/transaction-type";
import { labSecondaryTabClass } from "@/components/ui/lab";
import { TRANSACTION_TABS } from "@/lib/apt/transaction-type";

/** Compact monthly-rent money line — deposit strongest, monthly secondary. */
export function formatMonthlyRentDisplay(
  depositManwon: number,
  monthlyManwon: number,
): { primary: string; secondary: string } {
  return {
    primary: `보증금 ${formatEok(depositManwon)}`,
    secondary: `월 ${monthlyManwon.toLocaleString("ko-KR")}만원`,
  };
}

export function TransactionTypeTabs({
  value,
  onChange,
  counts,
}: {
  value: TransactionTabType;
  onChange: (next: TransactionTabType) => void;
  counts?: Partial<Record<TransactionTabType, number>>;
}) {
  return (
    <div
      className="flex w-fit shrink-0 gap-1"
      role="radiogroup"
      aria-label="거래 유형"
    >
      {TRANSACTION_TABS.map((tab) => {
        const active = value === tab.value;
        const count = counts?.[tab.value];
        return (
          <button
            key={tab.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(tab.value)}
            className={labSecondaryTabClass(active)}
          >
            {tab.label}
            {count != null ? (
              <span className="ml-1 tabular-nums opacity-70">
                {count.toLocaleString("ko-KR")}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export function TransactionRow({
  tx,
  mode,
}: {
  tx: AptHistoryItem;
  mode: TransactionTabType;
}) {
  const dateFull = formatDealDate(tx.dealDate);
  const dateShort = dateFull.length >= 10 ? dateFull.slice(5) : dateFull;
  const dealingLabel = tx.dealingGbn || "중개거래";
  const metaBits = [
    formatArea(tx.exclusiveArea),
    `${tx.floor}층`,
    dealingLabel,
  ];

  if (mode === "monthly") {
    const m = formatMonthlyRentDisplay(
      tx.dealAmount,
      Number(tx.monthlyRent ?? 0),
    );
    return (
      <li className="px-3.5 py-2.5 sm:px-4 sm:py-3">
        <div className="flex items-start justify-between gap-3">
          <time
            dateTime={tx.dealDate}
            title={dateFull}
            aria-label={dateFull}
            className="shrink-0 pt-0.5 text-sm font-medium tabular-nums text-slate-900"
          >
            <span className="sm:hidden">{dateShort}</span>
            <span className="hidden sm:inline">{dateFull}</span>
          </time>
          <div className="min-w-0 flex-1 text-right">
            <p className="text-sm font-semibold tabular-nums text-orange-700 sm:text-base">
              {m.primary}
            </p>
            <p className="mt-0.5 text-xs font-medium leading-snug text-orange-700/85 sm:text-[13px]">
              <span className="tabular-nums">{m.secondary}</span>
              <span className="text-slate-300" aria-hidden>
                {" "}
                ·{" "}
              </span>
              <span className="tabular-nums text-slate-500">
                {tx.floor}층
              </span>
              <span className="text-slate-300" aria-hidden>
                {" "}
                ·{" "}
              </span>
              <span className="tabular-nums text-slate-500">
                {formatArea(tx.exclusiveArea)}
              </span>
            </p>
          </div>
        </div>
      </li>
    );
  }

  const primaryMoney = formatEok(tx.dealAmount);
  const moneyClass = mode === "trade" ? "text-teal-800" : "text-orange-700";

  return (
    <li className="px-3.5 py-2.5 sm:px-4 sm:py-3">
      <div className="flex items-start justify-between gap-3">
        <time
          dateTime={tx.dealDate}
          title={dateFull}
          aria-label={dateFull}
          className="shrink-0 pt-0.5 text-sm font-medium tabular-nums text-slate-900"
        >
          <span className="sm:hidden">{dateShort}</span>
          <span className="hidden sm:inline">{dateFull}</span>
        </time>
        <div className="min-w-0 flex-1 text-right">
          <div className="flex flex-wrap items-center justify-end gap-1.5 sm:gap-2">
            {mode === "trade" && tx.isSingoga ? (
              <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-rose-500 px-1.5 py-0.5 text-[10px] font-semibold text-white sm:gap-1 sm:px-2 sm:text-[11px]">
                <Flame className="h-3 w-3" aria-hidden />
                신고가
              </span>
            ) : null}
            <p
              className={`text-sm font-semibold tabular-nums sm:text-base ${moneyClass}`}
            >
              {primaryMoney}
            </p>
          </div>
        </div>
      </div>
      <p className="mt-1 text-xs leading-snug text-slate-500 sm:text-[13px]">
        {metaBits.map((bit, i) => (
          <span key={`${bit}-${i}`}>
            {i > 0 ? (
              <span className="text-slate-300" aria-hidden>
                {" "}
                ·{" "}
              </span>
            ) : null}
            <span className="tabular-nums">{bit}</span>
          </span>
        ))}
      </p>
    </li>
  );
}

export function TransactionList({
  items,
  mode,
  emptyLabel = "선택한 조건의 거래가 없습니다.",
}: {
  items: AptHistoryItem[];
  mode: TransactionTabType;
  emptyLabel?: string;
}) {
  if (items.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-slate-300 px-4 py-10 text-center text-sm text-slate-500">
        {emptyLabel}
      </p>
    );
  }

  return (
    <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200/80 bg-white">
      {items.map((tx, idx) => (
        <TransactionRow key={`${tx.id}-${idx}`} tx={tx} mode={mode} />
      ))}
    </ul>
  );
}

"use client";

import type { ReactNode } from "react";
import { Flame } from "lucide-react";
import type { AptHistoryItem } from "@/lib/molit/apt-client";
import {
  formatDealDate,
  formatEok,
  formatExclusiveArea,
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

function dealTypeLabel(mode: TransactionTabType): string {
  if (mode === "trade") return "매매";
  if (mode === "jeonse") return "전세";
  return "월세";
}

function monthKeyFromDealDate(dealDate: string): string {
  if (!dealDate || dealDate.length < 7) return "";
  return `${dealDate.slice(0, 4)}${dealDate.slice(5, 7)}`;
}

function monthHeading(ym: string): string {
  if (ym.length !== 6) return ym;
  const y = ym.slice(0, 4);
  const m = Number(ym.slice(4, 6));
  return `${y}년 ${m}월`;
}

function dayShort(dealDate: string): string {
  const full = formatDealDate(dealDate);
  return full.length >= 10 ? full.slice(5) : full;
}

export type MonthGroup = {
  key: string;
  label: string;
  count: number;
  items: AptHistoryItem[];
};

/** Group already-sorted (newest-first) transactions by calendar month. */
export function groupTransactionsByMonth(
  items: AptHistoryItem[],
): MonthGroup[] {
  const groups: MonthGroup[] = [];
  const index = new Map<string, MonthGroup>();
  for (const tx of items) {
    const key = monthKeyFromDealDate(tx.dealDate);
    let g = index.get(key);
    if (!g) {
      g = { key, label: monthHeading(key), count: 0, items: [] };
      index.set(key, g);
      groups.push(g);
    }
    g.items.push(tx);
    g.count += 1;
  }
  return groups;
}

function RowMeta({
  floor,
  exclusiveArea,
  dealingGbn,
}: {
  floor: number;
  exclusiveArea: number;
  dealingGbn?: string | null;
}) {
  const bits = [
    `${floor}층`,
    formatExclusiveArea(exclusiveArea),
    dealingGbn || null,
  ].filter(Boolean) as string[];
  return (
    <p className="mt-0.5 text-xs leading-snug text-slate-500 sm:text-[13px]">
      {bits.map((bit, i) => (
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
  );
}

export function TransactionRow({
  tx,
  mode,
  dense = false,
}: {
  tx: AptHistoryItem;
  mode: TransactionTabType;
  /** Archive page: date left, price right, compact meta under price. */
  dense?: boolean;
}) {
  const dateFull = formatDealDate(tx.dealDate);
  const dateShort = dayShort(tx.dealDate);

  if (mode === "monthly") {
    const m = formatMonthlyRentDisplay(
      tx.dealAmount,
      Number(tx.monthlyRent ?? 0),
    );
    return (
      <li className={dense ? "px-3 py-2 sm:px-3.5 sm:py-2.5" : "px-3.5 py-2.5 sm:px-4 sm:py-3"}>
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
            <p className="text-sm font-semibold tabular-nums text-slate-900 sm:text-base">
              {m.primary}
            </p>
            <p className="mt-0.5 text-xs font-medium tabular-nums text-slate-600 sm:text-[13px]">
              {m.secondary}
            </p>
            <RowMeta
              floor={tx.floor}
              exclusiveArea={tx.exclusiveArea}
              dealingGbn={dense ? null : tx.dealingGbn || "중개거래"}
            />
          </div>
        </div>
      </li>
    );
  }

  const primaryMoney = formatEok(tx.dealAmount);
  const moneyClass =
    mode === "trade" ? "text-[color:var(--lab-teal-700)]" : "text-slate-900";

  return (
    <li className={dense ? "px-3 py-2 sm:px-3.5 sm:py-2.5" : "px-3.5 py-2.5 sm:px-4 sm:py-3"}>
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
          <RowMeta
            floor={tx.floor}
            exclusiveArea={tx.exclusiveArea}
            dealingGbn={dense ? null : tx.dealingGbn || "중개거래"}
          />
        </div>
      </div>
    </li>
  );
}

/** Flat list (Complex Detail recent 5). */
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

function DesktopTableRow({
  tx,
  mode,
}: {
  tx: AptHistoryItem;
  mode: TransactionTabType;
}) {
  const dateFull = formatDealDate(tx.dealDate);
  let amountCell: ReactNode;
  if (mode === "monthly") {
    const m = formatMonthlyRentDisplay(
      tx.dealAmount,
      Number(tx.monthlyRent ?? 0),
    );
    amountCell = (
      <span className="tabular-nums text-slate-900">
        {m.primary}
        <span className="text-slate-400"> · </span>
        {m.secondary}
      </span>
    );
  } else {
    amountCell = (
      <span className="inline-flex items-center gap-1.5 tabular-nums text-slate-900">
        {mode === "trade" && tx.isSingoga ? (
          <span className="inline-flex items-center gap-0.5 rounded-full bg-rose-500 px-1.5 py-0.5 text-[10px] font-semibold text-white">
            <Flame className="h-3 w-3" aria-hidden />
            신고가
          </span>
        ) : null}
        <span
          className={
            mode === "trade"
              ? "font-semibold text-[color:var(--lab-teal-700)]"
              : "font-semibold"
          }
        >
          {formatEok(tx.dealAmount)}
        </span>
      </span>
    );
  }

  return (
    <tr className="border-t border-slate-100 text-sm">
      <td className="whitespace-nowrap px-3 py-2 tabular-nums text-slate-800">
        {dateFull}
      </td>
      <td className="px-3 py-2 text-right">{amountCell}</td>
      <td className="whitespace-nowrap px-3 py-2 text-slate-600">
        {dealTypeLabel(mode)}
      </td>
      <td className="whitespace-nowrap px-3 py-2 tabular-nums text-slate-600">
        {formatExclusiveArea(tx.exclusiveArea)}
      </td>
      <td className="whitespace-nowrap px-3 py-2 tabular-nums text-slate-600">
        {tx.floor}층
      </td>
      <td className="whitespace-nowrap px-3 py-2 text-slate-500">
        {tx.dealingGbn || "—"}
      </td>
    </tr>
  );
}

/** Archive list: month headings + dense mobile rows + desktop table. */
export function GroupedTransactionList({
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

  const groups = groupTransactionsByMonth(items);

  return (
    <div className="space-y-4">
      {/* Mobile / narrow: dense month-grouped list */}
      <div className="space-y-4 md:hidden">
        {groups.map((g) => (
          <section key={g.key} className="overflow-hidden rounded-xl border border-slate-200/80 bg-white">
            <header className="flex items-baseline justify-between gap-2 border-b border-slate-100 bg-slate-50/80 px-3 py-2">
              <h3 className="text-sm font-semibold text-slate-800">{g.label}</h3>
              <p className="text-xs tabular-nums text-slate-500">
                {g.count.toLocaleString("ko-KR")}건
              </p>
            </header>
            <ul className="divide-y divide-slate-100">
              {g.items.map((tx, idx) => (
                <TransactionRow
                  key={`${tx.id}-${idx}`}
                  tx={tx}
                  mode={mode}
                  dense
                />
              ))}
            </ul>
          </section>
        ))}
      </div>

      {/* Desktop: compact table with month separators */}
      <div className="hidden overflow-hidden rounded-xl border border-slate-200/80 bg-white md:block">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50/80 text-xs font-medium text-slate-500">
              <th className="px-3 py-2.5 font-medium">계약일</th>
              <th className="px-3 py-2.5 text-right font-medium">거래금액</th>
              <th className="px-3 py-2.5 font-medium">거래유형</th>
              <th className="px-3 py-2.5 font-medium">전용면적</th>
              <th className="px-3 py-2.5 font-medium">층</th>
              <th className="px-3 py-2.5 font-medium">비고</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <MonthTableBlock key={g.key} group={g} mode={mode} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MonthTableBlock({
  group,
  mode,
}: {
  group: MonthGroup;
  mode: TransactionTabType;
}) {
  return (
    <>
      <tr className="bg-slate-50/60">
        <td
          colSpan={6}
          className="px-3 py-2 text-xs font-semibold text-slate-700"
        >
          <span>{group.label}</span>
          <span className="ml-2 font-normal tabular-nums text-slate-500">
            {group.count.toLocaleString("ko-KR")}건
          </span>
        </td>
      </tr>
      {group.items.map((tx, idx) => (
        <DesktopTableRow key={`${tx.id}-${idx}`} tx={tx} mode={mode} />
      ))}
    </>
  );
}

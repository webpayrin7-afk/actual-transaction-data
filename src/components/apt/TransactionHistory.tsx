"use client";

import { Flame } from "lucide-react";
import type { AptHistoryItem } from "@/lib/molit/apt-client";
import {
  formatDealDate,
  formatEok,
  formatEokDetail,
  formatExclusiveArea,
  formatMonthlyPriceCell,
} from "@/lib/utils/format";
import type { TransactionTabType } from "@/lib/apt/transaction-type";
import { labSecondaryTabClass } from "@/components/ui/lab";
import { TRANSACTION_TABS } from "@/lib/apt/transaction-type";
import {
  archiveBuildingDongLabel,
  archiveStatusLabel,
} from "@/lib/apt/transaction-row-display";


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
  variant = "chips",
}: {
  value: TransactionTabType;
  onChange: (next: TransactionTabType) => void;
  counts?: Partial<Record<TransactionTabType, number>>;
  /** chips = Complex Detail; pills = archive top (reference) */
  variant?: "chips" | "pills" | "segmented";
}) {
  if (variant === "pills" || variant === "segmented") {
    return (
      <div
        className="flex min-w-0 max-w-full flex-1 flex-wrap items-center gap-0.5"
        role="radiogroup"
        aria-label="거래 유형"
      >
        {TRANSACTION_TABS.map((tab) => {
          const active = value === tab.value;
          return (
            <button
              key={tab.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(tab.value)}
              className={[
                "inline-flex h-8 min-w-[4.5rem] shrink-0 items-center justify-center rounded-lg border px-5 text-[12px] font-semibold transition sm:h-9 sm:min-w-[5rem] sm:px-6 sm:text-[13px]",
                active
                  ? "border-[color:var(--lab-teal-600)] bg-[color:var(--lab-teal-50)] text-[color:var(--lab-teal-700)]"
                  : "border-[color:var(--lab-border)] bg-white text-[color:var(--lab-navy-700)] hover:bg-[color:var(--lab-bg)]",
              ].join(" ")}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div
      className="flex w-fit max-w-full shrink-0 flex-wrap gap-1"
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
const ARCHIVE_GRID =
  "minmax(2.2rem,0.55fr) minmax(2rem,0.55fr) minmax(5.2rem,1.85fr) minmax(2rem,0.65fr) minmax(1.9rem,0.55fr) minmax(1.7rem,0.45fr)";

function contractDay(dealDate: string): string {
  if (dealDate.length < 10) return dealDate;
  return `${dealDate.slice(5, 7)}.${dealDate.slice(8, 10)}`;
}

function archivePriceLabel(
  tx: AptHistoryItem,
  mode: TransactionTabType,
): string {
  if (mode === "monthly") {
    return formatMonthlyPriceCell(tx.dealAmount, Number(tx.monthlyRent ?? 0));
  }
  return formatEokDetail(tx.dealAmount);
}

function StatusBadge({ label }: { label: "신규" | "갱신" }) {
  const renewal = label === "갱신";
  return (
    <span
      className={
        renewal
          ? "inline-flex items-center rounded px-1 py-0.5 text-[10px] font-semibold leading-none text-[color:var(--lab-teal-700)] bg-[color:var(--lab-teal-50)]"
          : "inline-flex items-center rounded px-1 py-0.5 text-[10px] font-semibold leading-none text-[color:var(--lab-navy-900)] bg-[color-mix(in_srgb,var(--lab-navy-900)_8%,white)]"
      }
    >
      {label}
    </span>
  );
}

function AreaCell({ exclusiveArea }: { exclusiveArea: number }) {
  const display =
    exclusiveArea % 1 === 0
      ? `${exclusiveArea}`
      : exclusiveArea.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return <span className="tabular-nums text-[color:var(--lab-navy-700)]">{display}</span>;
}

function FloorCell({ floor }: { floor: number | null | undefined }) {
  if (floor == null || !Number.isFinite(floor)) {
    return <span className="text-[color:var(--lab-muted)]">—</span>;
  }
  return <span className="tabular-nums text-[color:var(--lab-navy-700)]">{floor}층</span>;
}

function ArchiveColHeader() {
  return (
    <div
      className="grid items-center gap-x-1 border-b border-[color:var(--lab-border)] bg-[color:var(--lab-bg)] px-2 py-1.5 text-[10px] font-medium text-[color:var(--lab-muted)] sm:gap-x-2 sm:px-3 sm:text-[11px]"
      style={{ gridTemplateColumns: ARCHIVE_GRID }}
      role="row"
    >
      <span>계약일</span>
      <span>상태</span>
      <span>가격</span>
      <span className="hidden sm:inline">면적(㎡)</span>
      <span className="sm:hidden">면적</span>
      <span>거래동</span>
      <span>층</span>
    </div>
  );
}

/**
 * Archive list — month cards + dense 6-column rows (desktop = mobile IA).
 * 계약일 | 상태 | 가격 | 면적 | 거래동 | 층
 */
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
      <p className="rounded-xl border border-dashed border-[color:var(--lab-border)] bg-white px-4 py-8 text-center text-sm text-[color:var(--lab-muted)]">
        {emptyLabel}
      </p>
    );
  }

  const groups = groupTransactionsByMonth(items);

  return (
    <div className="space-y-5">
      {groups.map((group) => (
        <section
          key={group.key}
          className="overflow-hidden rounded-xl border border-[color:var(--lab-border)] bg-white shadow-[var(--lab-shadow)]"
        >
          <div className="flex items-center justify-between gap-2 border-b border-[color:var(--lab-border)] bg-white px-2.5 py-3 sm:px-3">
            <h3 className="text-[13px] font-bold text-[color:var(--lab-navy-950)] sm:text-sm">
              {group.label}
            </h3>
            <span className="text-[11px] tabular-nums text-[color:var(--lab-muted)] sm:text-xs">
              {group.count.toLocaleString("ko-KR")}건
            </span>
          </div>

          <ArchiveColHeader />

          <ul>
            {group.items.map((tx, idx) => {
              const status = archiveStatusLabel(mode, tx.dealingGbn);
              const dong = archiveBuildingDongLabel(tx);
              return (
                <li
                  key={`${tx.id}-${idx}`}
                  className="grid items-center gap-x-1 border-b border-[color:var(--lab-border)]/70 px-2 py-2.5 text-[11px] leading-snug last:border-b-0 sm:gap-x-2 sm:px-3 sm:py-3 sm:text-[12px]"
                  style={{ gridTemplateColumns: ARCHIVE_GRID }}
                >
                  <span className="tabular-nums text-[color:var(--lab-navy-900)]">
                    {contractDay(tx.dealDate)}
                  </span>
                  <span className="min-w-0">
                    {status ? (
                      <StatusBadge label={status} />
                    ) : (
                      <span className="text-[color:var(--lab-muted)]">—</span>
                    )}
                  </span>
                  <span className="min-w-0">
                    <span className="inline-flex max-w-full flex-nowrap items-center gap-1 overflow-hidden">
                      <span className="whitespace-nowrap text-[12px] font-bold tabular-nums text-[color:var(--lab-navy-950)] sm:text-[13px]">
                        {archivePriceLabel(tx, mode)}
                      </span>
                      {mode === "trade" && tx.isSingoga ? (
                        <span className="shrink-0 whitespace-nowrap rounded border border-rose-400 px-1 py-px text-[9px] font-bold leading-none text-rose-600">
                          신고가
                        </span>
                      ) : null}
                    </span>
                  </span>
                  <span className="min-w-0">
                    <AreaCell exclusiveArea={tx.exclusiveArea} />
                  </span>
                  <span className="min-w-0 truncate text-[color:var(--lab-navy-700)]">
                    {dong ?? "—"}
                  </span>
                  <span className="min-w-0">
                    <FloorCell floor={tx.floor} />
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

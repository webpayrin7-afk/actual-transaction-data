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
import type {
  TransactionListMode,
  TransactionTabType,
} from "@/lib/apt/transaction-type";
import { LabTabs } from "@/components/ui/LabTabs";
import {
  dealTypePriceTextClass,
  transactionTabFromItem,
  TRANSACTION_TABS,
} from "@/lib/apt/transaction-type";
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

const DEAL_TAB_ITEMS = TRANSACTION_TABS.map((tab) => ({
  id: tab.value,
  label: tab.label,
}));

/**
 * 매매 / 전세 / 월세 — ZIPLAB §11 LabTabs secondary (공통 segmented).
 * `counts`는 라벨 옆에 건수를 붙일 때 사용 (옵션).
 */
export function TransactionTypeTabs({
  value,
  onChange,
  counts,
  className = "",
}: {
  value: TransactionTabType;
  onChange: (next: TransactionTabType) => void;
  counts?: Partial<Record<TransactionTabType, number>>;
  className?: string;
  /** @deprecated Ignored — always LabTabs secondary. Kept for call-site compatibility. */
  variant?: "chips" | "pills" | "segmented";
}) {
  const items = counts
    ? DEAL_TAB_ITEMS.map((tab) => {
        const count = counts[tab.id];
        return count != null
          ? {
              id: tab.id,
              label: `${tab.label} ${count.toLocaleString("ko-KR")}`,
            }
          : tab;
      })
    : DEAL_TAB_ITEMS;

  return (
    <LabTabs
      variant="secondary"
      ariaLabel="거래 유형"
      className={`min-w-0 max-w-full flex-1 ${className}`.trim()}
      value={value}
      items={items}
      onChange={onChange}
    />
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
    <p className="detail-meta mt-0.5 leading-snug">
      {bits.map((bit, i) => (
        <span key={`${bit}-${i}`}>
          {i > 0 ? (
            <span className="text-[color:var(--lab-border)]" aria-hidden>
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
  layout = "default",
}: {
  tx: AptHistoryItem;
  mode: TransactionListMode;
  /** Archive page: date left, price right, compact meta under price. */
  dense?: boolean;
  /** Embedded detail list: date/area left, price/floor right. */
  layout?: "default" | "split";
}) {
  const dateFull = formatDealDate(tx.dealDate);
  const dateShort = dayShort(tx.dealDate);
  const priceType =
    mode === "rent" ? transactionTabFromItem(tx) : mode;

  if (layout === "split") {
    const price =
      priceType === "monthly"
        ? formatMonthlyPriceCell(tx.dealAmount, Number(tx.monthlyRent ?? 0))
        : formatEokDetail(tx.dealAmount);
    const floorLabel =
      tx.floor != null && Number.isFinite(tx.floor) ? `${tx.floor}층` : "—";
    return (
      <li className="detail-trade-row detail-trade-row--inline">
        <time
          dateTime={tx.dealDate}
          title={dateFull}
          className="detail-trade-row-date"
        >
          {dateShort}
        </time>
        <p className="detail-trade-row-area tabular-nums">
          {formatExclusiveArea(tx.exclusiveArea)}
          {mode === "rent" ? (
            <span className="detail-trade-row-kind">
              {" · "}
              {priceType === "monthly" ? "월세" : "전세"}
            </span>
          ) : null}
        </p>
        <p className="detail-trade-row-floor tabular-nums">{floorLabel}</p>
        <p
          className={`detail-trade-row-price ${dealTypePriceTextClass(priceType)}`}
        >
          {price}
        </p>
      </li>
    );
  }

  if (priceType === "monthly") {
    const m = formatMonthlyRentDisplay(
      tx.dealAmount,
      Number(tx.monthlyRent ?? 0),
    );
    return (
      <li className={dense ? "px-3 py-2 sm:px-3.5 sm:py-2.5" : "px-3.5 py-2.5 sm:px-4 sm:py-3"}>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <time
              dateTime={tx.dealDate}
              title={dateFull}
              aria-label={dateFull}
              className="detail-label block tabular-nums text-[color:var(--lab-navy-950)]"
            >
              <span className="sm:hidden">{dateShort}</span>
              <span className="hidden sm:inline">{dateFull}</span>
            </time>
            <RowMeta
              floor={tx.floor}
              exclusiveArea={tx.exclusiveArea}
              dealingGbn={dense ? null : tx.dealingGbn || "중개거래"}
            />
          </div>
          <div className="shrink-0 text-right">
            <p
            className={`detail-list-title ${dealTypePriceTextClass(priceType)}`}
            >
              {m.primary}
            </p>
            <p className="mt-0.5 text-xs font-medium tabular-nums text-slate-600 sm:text-[13px]">
              {m.secondary}
            </p>
          </div>
        </div>
      </li>
    );
  }

  const primaryMoney = formatEok(tx.dealAmount);
  const moneyClass = dealTypePriceTextClass(priceType);

  return (
    <li className={dense ? "px-3 py-2 sm:px-3.5 sm:py-2.5" : "px-3.5 py-2.5 sm:px-4 sm:py-3"}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
            <time
            dateTime={tx.dealDate}
            title={dateFull}
            aria-label={dateFull}
            className="detail-label block tabular-nums text-[color:var(--lab-navy-950)]"
          >
            <span className="sm:hidden">{dateShort}</span>
            <span className="hidden sm:inline">{dateFull}</span>
          </time>
          <RowMeta
            floor={tx.floor}
            exclusiveArea={tx.exclusiveArea}
            dealingGbn={dense ? null : tx.dealingGbn || "중개거래"}
          />
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {mode === "trade" && tx.isSingoga ? (
            <span className="inline-flex items-center gap-0.5 rounded-full bg-rose-500 px-1.5 py-0.5 text-[10px] font-semibold text-white sm:gap-1 sm:px-2 sm:text-[11px]">
              <Flame className="h-3 w-3" aria-hidden />
              신고가
            </span>
          ) : null}
          <p
            className={`detail-list-title ${moneyClass}`}
          >
            {primaryMoney}
          </p>
        </div>
      </div>
    </li>
  );
}

/** Flat list (Complex Detail recent N). */
export function TransactionList({
  items,
  mode,
  emptyLabel = "선택한 조건의 거래가 없습니다.",
  layout = "default",
}: {
  items: AptHistoryItem[];
  mode: TransactionListMode;
  emptyLabel?: string;
  layout?: "default" | "split";
}) {
  if (items.length === 0) {
    return (
      <p className="lab-state detail-body">{emptyLabel}</p>
    );
  }

  if (layout === "split") {
    const priceHead =
      mode === "rent"
        ? "전세·월세"
        : mode === "jeonse"
          ? "전세가"
          : mode === "monthly"
            ? "보증금·월세"
            : "매매가";
    return (
      <ul className="detail-trade-list">
        <li
          className="detail-trade-list-head detail-trade-row--inline"
          aria-hidden
        >
          <span>계약일</span>
          <span>전용면적</span>
          <span>층</span>
          <span>{priceHead}</span>
        </li>
        {items.map((tx, idx) => (
          <TransactionRow
            key={`${tx.id}-${idx}`}
            tx={tx}
            mode={mode}
            layout="split"
          />
        ))}
      </ul>
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
          ? "inline-flex items-center rounded px-1 py-0.5 text-[11px] font-semibold leading-none text-[color:var(--lab-teal-700)] bg-[color:var(--lab-teal-50)]"
          : "inline-flex items-center rounded px-1 py-0.5 text-[11px] font-semibold leading-none text-[color:var(--lab-navy-900)] bg-[color-mix(in_srgb,var(--lab-navy-900)_8%,white)]"
      }
    >
      {label}
    </span>
  );
}

function AreaCell({ exclusiveArea }: { exclusiveArea: number }) {
  if (!Number.isFinite(exclusiveArea)) {
    return <span className="text-[color:var(--lab-muted)]">—</span>;
  }
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
    <div className="bg-white px-1 pb-1 pt-0.5 sm:px-1.5">
      <div
        className="grid items-center gap-x-1 rounded-md bg-[color:var(--lab-bg)] px-2 py-1.5 text-[11px] font-medium text-[color:var(--lab-muted)] sm:gap-x-2 sm:rounded-lg sm:px-2.5 sm:text-[12px]"
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
    <div className="space-y-4">
      {groups.map((group) => (
        <section
          key={group.key}
          className="overflow-hidden rounded-xl border border-[color:var(--lab-border)] bg-white shadow-[var(--lab-shadow)]"
        >
          <div className="flex items-center justify-between gap-2 bg-white px-2.5 pt-2.5 pb-1 sm:px-3">
            <h3 className="detail-subsection-title">
              {group.label}
            </h3>
            <span className="detail-meta tabular-nums">
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
                  className="grid items-center gap-x-1 border-b border-[color:var(--lab-border)]/70 px-2 py-2 text-[12px] leading-snug last:border-b-0 sm:gap-x-2 sm:px-3 sm:py-2.5 sm:text-[13px]"
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
                      <span
                        className={`detail-number whitespace-nowrap ${dealTypePriceTextClass(mode)}`}
                      >
                        {archivePriceLabel(tx, mode)}
                      </span>
                      {mode === "trade" && tx.isSingoga ? (
                        <span className="shrink-0 whitespace-nowrap rounded border border-rose-400 px-1 py-px text-[10px] font-bold leading-none text-rose-600">
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

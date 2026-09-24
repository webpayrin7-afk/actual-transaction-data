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
import { labSecondaryTabClass, labSegmentedClass } from "@/components/ui/lab";
import {
  dealTypePriceTextClass,
  TRANSACTION_TABS,
} from "@/lib/apt/transaction-type";
import { archiveContractTypeLabel } from "@/lib/apt/transaction-row-display";
import {
  archiveRegistrationDateTitle,
  archiveRegistrationLabel,
} from "@/lib/molit/rgst-date";


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
        className={labSegmentedClass("min-w-0 max-w-full flex-1")}
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
              className={labSecondaryTabClass(active)}
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
      className={labSegmentedClass("max-w-full shrink-0")}
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
            className={`detail-list-title ${dealTypePriceTextClass(mode)}`}
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
  const moneyClass = dealTypePriceTextClass(mode);

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
      <p className="lab-state detail-body">{emptyLabel}</p>
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
/** 매매: 계약일 | 가격 | 면적 | 등기 | 층 */
const ARCHIVE_GRID_TRADE =
  "minmax(2.2rem,0.6fr) minmax(4.8rem,1.9fr) minmax(2rem,0.7fr) minmax(2.4rem,0.85fr) minmax(1.6rem,0.5fr)";

/** 전세/월세: 계약일 | 계약구분 | 가격 | 면적 | 층 */
const ARCHIVE_GRID_RENT =
  "minmax(2.2rem,0.55fr) minmax(2.4rem,0.75fr) minmax(5.2rem,1.95fr) minmax(2rem,0.7fr) minmax(1.7rem,0.5fr)";

function archiveGridFor(mode: TransactionTabType): string {
  return mode === "trade" ? ARCHIVE_GRID_TRADE : ARCHIVE_GRID_RENT;
}

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

function ContractTypeBadge({ label }: { label: "신규" | "갱신" }) {
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

function RegistrationBadge({
  label,
  title,
}: {
  label: "등기완료" | "등기 미확인";
  title?: string;
}) {
  const done = label === "등기완료";
  return (
    <span
      title={title}
      className={
        done
          ? "inline-flex max-w-full items-center truncate rounded px-1 py-0.5 text-[10px] font-semibold leading-none text-[color:var(--lab-teal-700)] bg-[color:var(--lab-teal-50)] sm:text-[11px]"
          : "inline-flex max-w-full items-center truncate rounded px-1 py-0.5 text-[10px] font-medium leading-none text-[color:var(--lab-muted)] bg-[color-mix(in_srgb,var(--lab-muted)_12%,white)] sm:text-[11px]"
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

function ArchiveColHeader({ mode }: { mode: TransactionTabType }) {
  const showContractType = mode !== "trade";
  const showRegistration = mode === "trade";
  return (
    <div className="bg-white px-1 pb-1 pt-0.5 sm:px-1.5">
      <div
        className="grid items-center gap-x-1 rounded-md bg-[color:var(--lab-bg)] px-2 py-1.5 text-[11px] font-medium text-[color:var(--lab-muted)] sm:gap-x-2 sm:rounded-lg sm:px-2.5 sm:text-[12px]"
        style={{ gridTemplateColumns: archiveGridFor(mode) }}
        role="row"
      >
        <span>계약일</span>
        {showContractType ? <span>계약구분</span> : null}
        <span>가격</span>
        <span className="hidden sm:inline">면적(㎡)</span>
        <span className="sm:hidden">면적</span>
        {showRegistration ? <span>등기</span> : null}
        <span>층</span>
      </div>
    </div>
  );
}

/**
 * Archive list — month cards + dense rows (desktop = mobile IA).
 * 매매: 계약일 | 가격 | 면적 | 등기 | 층
 * 전세/월세: 계약일 | 계약구분 | 가격 | 면적 | 층
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
  const grid = archiveGridFor(mode);
  const showContractType = mode !== "trade";
  const showRegistration = mode === "trade";

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

          <ArchiveColHeader mode={mode} />

          <ul>
            {group.items.map((tx, idx) => {
              const contractType = showContractType
                ? archiveContractTypeLabel(mode, tx.dealingGbn)
                : null;
              const registration = showRegistration
                ? archiveRegistrationLabel(tx.dealDate, tx.rgstDate)
                : null;
              const registrationTitle = showRegistration
                ? archiveRegistrationDateTitle(tx.rgstDate)
                : undefined;
              return (
                <li
                  key={`${tx.id}-${idx}`}
                  className="grid items-center gap-x-1 border-b border-[color:var(--lab-border)]/70 px-2 py-2 text-[12px] leading-snug last:border-b-0 sm:gap-x-2 sm:px-3 sm:py-2.5 sm:text-[13px]"
                  style={{ gridTemplateColumns: grid }}
                >
                  <span className="tabular-nums text-[color:var(--lab-navy-900)]">
                    {contractDay(tx.dealDate)}
                  </span>
                  {showContractType ? (
                    <span className="min-w-0">
                      {contractType ? (
                        <ContractTypeBadge label={contractType} />
                      ) : (
                        <span className="text-[color:var(--lab-muted)]">—</span>
                      )}
                    </span>
                  ) : null}
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
                  {showRegistration ? (
                    <span className="min-w-0">
                      {registration ? (
                        <RegistrationBadge
                          label={registration}
                          title={registrationTitle}
                        />
                      ) : (
                        <span className="text-[color:var(--lab-muted)]">—</span>
                      )}
                    </span>
                  ) : null}
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

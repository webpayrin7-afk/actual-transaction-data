"use client";

import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { LabDataLoading } from "@/components/ui/LabLoading";
import { aptDetailHref } from "@/lib/molit/apt-client";
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
  /** Enables complex-detail links on names. */
  regionSlug?: string;
}

function TypeBadge({ dealType }: { dealType: Transaction["dealType"] }) {
  return (
    <span
      className={`inline-flex whitespace-nowrap rounded-md border px-1.5 text-[12px] font-medium leading-5 ${
        dealType === "trade"
          ? "border-[color:var(--lab-brand-border)] bg-[color:var(--lab-brand-subtle)] text-[color:var(--lab-teal-700)]"
          : "border-[color:var(--lab-border)] bg-white text-[color:var(--lab-body)]"
      }`}
    >
      {dealTypeLabel(dealType)}
    </span>
  );
}

function MobileRow({ tx, regionSlug }: { tx: Transaction; regionSlug?: string }) {
  const href = regionSlug ? aptDetailHref(tx.aptName, regionSlug, tx.gu) : null;
  const body = (
    <>
      <div className="min-w-0 flex-1">
        <p className="detail-data-value-emphasis truncate">{tx.aptName}</p>
        <p className="detail-meta truncate">
          {[tx.dong, formatArea(tx.exclusiveArea), `${tx.floor}층`].filter(Boolean).join(" · ")}
        </p>
      </div>
      <div className="shrink-0 text-right">
        <p className="detail-data-value-emphasis whitespace-nowrap tabular-nums">
          {formatDealAmount(tx)}
        </p>
        <p className="mt-0.5 flex items-center justify-end gap-1.5">
          <TypeBadge dealType={tx.dealType} />
          <time className="detail-meta tabular-nums">{formatDealDate(tx.dealDate)}</time>
        </p>
      </div>
      {href ? <ChevronRight className="lab-press-arrow h-4 w-4 shrink-0" aria-hidden /> : null}
    </>
  );
  const cls = "flex min-h-11 items-center gap-3 py-2.5";
  return (
    <li>
      {href ? (
        <Link href={href} className={`${cls} lab-row-press -mx-2 rounded-lg px-2`}>
          {body}
        </Link>
      ) : (
        <div className={cls}>{body}</div>
      )}
    </li>
  );
}

const TH = "detail-meta px-3 py-2.5 font-medium whitespace-nowrap";
const TD = "px-3 py-2.5 whitespace-nowrap";

/** 표 머리 — 데이터와 무관해 불러오는 동안에도 그대로 그린다. */
const TABLE_HEAD = (
  <thead className="border-b border-[color:var(--lab-border)]">
    <tr>
      <th className={TH}>계약일자</th>
      <th className={TH}>유형</th>
      <th className={TH}>단지명</th>
      <th className={TH}>구</th>
      <th className={TH}>법정동</th>
      <th className={`${TH} text-right`}>전용면적</th>
      <th className={`${TH} text-right`}>거래금액</th>
      <th className={`${TH} text-right`}>층</th>
    </tr>
  </thead>
);

export function TransactionTable({ items, isLoading, regionSlug }: TransactionTableProps) {
  if (isLoading) {
    return (
      <>
        <div className="hidden overflow-x-auto md:block">
          <table className="min-w-full text-left text-[14px] leading-5">{TABLE_HEAD}</table>
        </div>
        <LabDataLoading label="거래 불러오는 중" minHeight={264} />
      </>
    );
  }

  if (items.length === 0) {
    return (
      <div className="lab-state flex-col">
        <p className="detail-body text-[color:var(--lab-navy-950)]">조회된 거래가 없습니다</p>
        <p className="detail-meta mt-1">필터 조건이나 계약년월을 바꿔 다시 조회해 보세요.</p>
      </div>
    );
  }

  return (
    <>
      <ul className="divide-y divide-[color:var(--lab-border)] md:hidden">
        {items.map((tx) => (
          <MobileRow key={tx.id} tx={tx} regionSlug={regionSlug} />
        ))}
      </ul>

      <div className="hidden overflow-x-auto md:block">
        <table className="min-w-full text-left text-[14px] leading-5">
          {TABLE_HEAD}
          <tbody className="divide-y divide-[color:var(--lab-border)] tabular-nums">
            {items.map((tx) => {
              const href = regionSlug ? aptDetailHref(tx.aptName, regionSlug, tx.gu) : null;
              return (
                <tr key={tx.id} className="hover:bg-slate-50">
                  <td className={`${TD} text-[color:var(--lab-body)]`}>{formatDealDate(tx.dealDate)}</td>
                  <td className={TD}>
                    <TypeBadge dealType={tx.dealType} />
                  </td>
                  <td className="px-3 py-2.5 font-semibold text-[color:var(--lab-navy-950)]">
                    {href ? (
                      <Link href={href} className="hover:underline">
                        {tx.aptName}
                      </Link>
                    ) : (
                      tx.aptName
                    )}
                  </td>
                  <td className={`${TD} text-[color:var(--lab-body)]`}>{tx.gu}</td>
                  <td className={`${TD} text-[color:var(--lab-body)]`}>{tx.dong}</td>
                  <td className={`${TD} text-right text-[color:var(--lab-body)]`}>
                    {formatArea(tx.exclusiveArea)}
                  </td>
                  <td className={`${TD} text-right font-semibold text-[color:var(--lab-navy-950)]`}>
                    {formatDealAmount(tx)}
                  </td>
                  <td className={`${TD} text-right text-[color:var(--lab-body)]`}>{tx.floor}층</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

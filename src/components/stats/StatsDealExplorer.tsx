"use client";

import Link from "next/link";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import type { MarketDealItem, MarketVolumeItem } from "@/lib/market/home";
import { formatArea, formatDealDate, formatEok } from "@/lib/utils/format";

export type DealExplorerTab =
  | "notables"
  | "singoga"
  | "drops"
  | "active";

const TABS: { id: DealExplorerTab; label: string }[] = [
  { id: "notables", label: "주요 실거래" },
  { id: "singoga", label: "신고가" },
  { id: "drops", label: "하락거래" },
  { id: "active", label: "거래 활발 단지" },
];

function compareLine(item: MarketDealItem): string | null {
  if (item.kind === "singoga" && item.priorMaxAmount != null) {
    const amt =
      item.changeAmount != null
        ? ` +${formatEok(Math.abs(item.changeAmount))}`
        : "";
    const pct =
      item.changePct != null ? ` (+${item.changePct}%)` : "";
    return `신고가${amt}${pct}`;
  }
  if (item.kind === "drop" && item.priorMaxAmount != null) {
    const pct =
      item.changePct != null ? ` ${item.changePct}%` : "";
    return `역대 최고가 대비${pct}`;
  }
  if (item.kind === "high" && item.priorMaxAmount != null && item.changePct != null) {
    return `최고가 대비 ${item.changePct}%`;
  }
  if (item.kind === "high") return "고가 거래";
  return null;
}

export function StatsDealRow({ item }: { item: MarketDealItem }) {
  const up = (item.changePct ?? 0) > 0;
  const down = (item.changePct ?? 0) < 0;
  const compare = compareLine(item);

  return (
    <Link
      href={item.href}
      className="flex items-start justify-between gap-3 border-b border-slate-100 px-1 py-3.5 last:border-0 hover:bg-slate-50/80 sm:px-2"
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="truncate text-sm font-semibold text-slate-900">
            {item.aptName}
          </span>
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">
            {item.kindLabel}
          </span>
        </div>
        <p className="mt-0.5 text-xs text-slate-500">
          {item.gu} {item.dong} · {formatArea(item.exclusiveArea)} ·{" "}
          {formatDealDate(item.dealDate)}
        </p>
        {compare ? (
          <p
            className={`mt-1 text-[11px] font-medium ${
              up ? "text-teal-700" : down ? "text-rose-600" : "text-slate-500"
            }`}
          >
            {compare}
            {item.priorMaxAmount != null
              ? ` · 이전 최고 ${formatEok(item.priorMaxAmount)}`
              : ""}
          </p>
        ) : null}
      </div>
      <div className="shrink-0 text-right">
        <p className="text-base font-semibold tabular-nums text-slate-900">
          {formatEok(item.dealAmount)}
        </p>
        {item.changePct != null ? (
          <p
            className={`mt-0.5 inline-flex items-center gap-0.5 text-xs font-semibold tabular-nums ${
              up ? "text-teal-700" : down ? "text-rose-600" : "text-slate-500"
            }`}
          >
            {up ? (
              <ArrowUpRight className="h-3.5 w-3.5" />
            ) : down ? (
              <ArrowDownRight className="h-3.5 w-3.5" />
            ) : null}
            {item.changePct > 0 ? "+" : ""}
            {item.changePct}%
          </p>
        ) : null}
      </div>
    </Link>
  );
}

function ActiveRow({
  item,
  windowLabel,
  prevWindowLabel,
}: {
  item: MarketVolumeItem;
  windowLabel: string;
  prevWindowLabel: string;
}) {
  return (
    <Link
      href={item.href}
      className="flex items-start justify-between gap-3 border-b border-slate-100 px-1 py-3.5 last:border-0 hover:bg-slate-50/80 sm:px-2"
    >
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-slate-900">
          {item.aptName}
        </p>
        <p className="mt-0.5 text-xs text-slate-500">
          {item.gu} {item.dong}
        </p>
        <p className="mt-1 text-[11px] text-slate-500">
          {windowLabel} {item.recentCount}건 · {prevWindowLabel}{" "}
          {item.priorCount}건
        </p>
      </div>
      <div className="shrink-0 text-right">
        <p className="text-sm font-semibold tabular-nums text-slate-900">
          {item.recentCount}건
        </p>
        {item.increaseCount !== 0 ? (
          <p
            className={`mt-0.5 text-xs tabular-nums ${
              item.increaseCount > 0 ? "text-teal-700" : "text-rose-600"
            }`}
          >
            {item.increaseCount > 0 ? "+" : ""}
            {item.increaseCount}건
            {item.growthPct != null ? ` (${item.growthPct > 0 ? "+" : ""}${item.growthPct}%)` : ""}
          </p>
        ) : (
          <p className="mt-0.5 text-xs text-slate-400">변동 없음</p>
        )}
      </div>
    </Link>
  );
}

export function StatsDealExplorer({
  tab,
  onTabChange,
  notables,
  singoga,
  drops,
  activeComplexes,
  windowLabel,
  prevWindowLabel,
  windowFrom,
  windowTo,
}: {
  tab: DealExplorerTab;
  onTabChange: (t: DealExplorerTab) => void;
  notables: MarketDealItem[];
  singoga: MarketDealItem[];
  drops: MarketDealItem[];
  activeComplexes: MarketVolumeItem[];
  windowLabel: string;
  prevWindowLabel: string;
  windowFrom: string;
  windowTo: string;
}) {
  const items =
    tab === "notables"
      ? notables
      : tab === "singoga"
        ? singoga
        : tab === "drops"
          ? drops
          : null;

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
      <div className="mb-3">
        <h2 className="text-sm font-semibold text-slate-900 sm:text-base">
          실거래 탐색
        </h2>
        <p className="mt-0.5 text-xs text-slate-500">
          {windowLabel} ({formatDealDate(windowFrom)} ~{" "}
          {formatDealDate(windowTo)}) 기준 · 단지 클릭 시 상세로 이동
        </p>
      </div>

      <div
        className="mb-3 flex w-full gap-1 overflow-x-auto rounded-xl border border-slate-200 bg-slate-50 p-1"
        role="tablist"
        aria-label="실거래 탐색"
      >
        {TABS.map((t) => {
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onTabChange(t.id)}
              className={`shrink-0 flex-1 rounded-lg px-2 py-1.5 text-center text-xs font-medium transition sm:text-sm ${
                active
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {tab === "active" ? (
        activeComplexes.length === 0 ? (
          <p className="py-8 text-center text-sm text-slate-500">
            해당 기간 거래 활발 단지가 없습니다.
          </p>
        ) : (
          <ul>
            {activeComplexes.map((item) => (
              <li key={`${item.aptName}-${item.gu}-${item.dong}`}>
                <ActiveRow
                  item={item}
                  windowLabel={windowLabel}
                  prevWindowLabel={prevWindowLabel}
                />
              </li>
            ))}
          </ul>
        )
      ) : items && items.length === 0 ? (
        <p className="py-8 text-center text-sm text-slate-500">
          해당 기간 표시할 거래가 없습니다.
        </p>
      ) : (
        <ul>
          {(items ?? []).map((item) => (
            <li key={item.id}>
              <StatsDealRow item={item} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

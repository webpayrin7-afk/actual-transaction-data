"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import type { MarketDealItem, MarketVolumeItem } from "@/lib/market/home";
import { formatArea, formatDealDate, formatEok } from "@/lib/utils/format";
import { LabSection } from "@/components/ui/LabSection";
import { LAB_LIST } from "@/components/ui/LabListRow";
import { LAB_LIST_PREVIEW, LabMoreButton } from "@/components/ui/LabMoreButton";
import { LabTag } from "@/components/ui/LabTag";
import { LabTabs } from "@/components/ui/LabTabs";

const ROW =
  "flex min-h-11 items-start justify-between gap-3 py-3 hover:bg-slate-50";
const UP = { color: "var(--lab-change-up)" };
const DOWN = { color: "var(--lab-change-down)" };

export type DealExplorerTab =
  | "notables"
  | "singoga"
  | "drops"
  | "active";

const TABS: { id: DealExplorerTab; label: string }[] = [
  { id: "notables", label: "주요 실거래" },
  { id: "singoga", label: "신고가" },
  { id: "drops", label: "하락거래" },
  { id: "active", label: "거래 활발" },
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
      className={ROW}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="detail-data-value-emphasis truncate">{item.aptName}</span>
          <LabTag>{item.kindLabel}</LabTag>
        </div>
        <p className="detail-meta mt-0.5">
          {item.gu} {item.dong} · {formatArea(item.exclusiveArea)} ·{" "}
          {formatDealDate(item.dealDate)}
        </p>
        {compare ? (
          <p className="detail-meta mt-0.5 font-medium" style={up ? UP : down ? DOWN : undefined}>
            {compare}
            {item.priorMaxAmount != null
              ? ` · 이전 최고 ${formatEok(item.priorMaxAmount)}`
              : ""}
          </p>
        ) : null}
      </div>
      <div className="shrink-0 text-right">
        <p className="detail-data-value-emphasis tabular-nums">
          {formatEok(item.dealAmount)}
        </p>
        {item.changePct != null ? (
          <p
            className="detail-meta mt-0.5 inline-flex items-center gap-0.5 font-semibold tabular-nums"
            style={up ? UP : down ? DOWN : undefined}
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
      className={ROW}
    >
      <div className="min-w-0 flex-1">
        <p className="detail-data-value-emphasis truncate">{item.aptName}</p>
        <p className="detail-meta mt-0.5">
          {item.gu} {item.dong}
        </p>
        <p className="detail-meta">
          {windowLabel} {item.recentCount}건 · {prevWindowLabel}{" "}
          {item.priorCount}건
        </p>
      </div>
      <div className="shrink-0 text-right">
        <p className="detail-data-value-emphasis tabular-nums">
          {item.recentCount}건
        </p>
        {item.increaseCount !== 0 ? (
          <p
            className="detail-meta mt-0.5 tabular-nums"
            style={item.increaseCount > 0 ? UP : DOWN}
          >
            {item.increaseCount > 0 ? "+" : ""}
            {item.increaseCount}건
            {item.growthPct != null ? ` (${item.growthPct > 0 ? "+" : ""}${item.growthPct}%)` : ""}
          </p>
        ) : (
          <p className="detail-meta mt-0.5">변동 없음</p>
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
  const [expanded, setExpanded] = useState(false);
  const items =
    tab === "notables"
      ? notables
      : tab === "singoga"
        ? singoga
        : tab === "drops"
          ? drops
          : null;
  const total = tab === "active" ? activeComplexes.length : (items ?? []).length;
  const cut = (n: number) => (expanded ? n : Math.min(n, LAB_LIST_PREVIEW));
  const more =
    total > LAB_LIST_PREVIEW ? (
      <LabMoreButton
        expanded={expanded}
        onToggle={() => setExpanded((v) => !v)}
        label={`${total - LAB_LIST_PREVIEW}${tab === "active" ? "곳" : "건"} 더보기`}
      />
    ) : null;

  return (
    <LabSection
      title="실거래 탐색"
      meta={`${windowLabel} (${formatDealDate(windowFrom)} ~ ${formatDealDate(windowTo)}) 기준`}
      tip={<p>단지를 누르면 상세로 이동합니다.</p>}
    >
      <LabTabs
        variant="secondary"
        items={TABS}
        value={tab}
        onChange={(t) => {
          setExpanded(false);
          onTabChange(t);
        }}
        ariaLabel="실거래 탐색"
      />

      {tab === "active" ? (
        activeComplexes.length === 0 ? (
          <p className="detail-body py-6 text-center">해당 기간 거래 활발 단지가 없습니다.</p>
        ) : (
          <ul className={LAB_LIST}>
            {activeComplexes.slice(0, cut(activeComplexes.length)).map((item) => (
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
        <p className="detail-body py-6 text-center">해당 기간 표시할 거래가 없습니다.</p>
      ) : (
        <ul className={LAB_LIST}>
          {(items ?? []).slice(0, cut((items ?? []).length)).map((item) => (
            <li key={item.id}>
              <StatsDealRow item={item} />
            </li>
          ))}
        </ul>
      )}
      {more}
    </LabSection>
  );
}

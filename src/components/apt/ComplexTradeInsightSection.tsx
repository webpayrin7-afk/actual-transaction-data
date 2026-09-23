"use client";

import { useState } from "react";
import { LAB_SUBSECTION_RULE, LabSection, LabSubsectionHeader } from "@/components/ui/LabSection";
import { LAB_LIST, LabListRow } from "@/components/ui/LabListRow";
import { LAB_LIST_PREVIEW, LabMoreButton } from "@/components/ui/LabMoreButton";
import type { AptHistoryItem } from "@/lib/molit/apt-client";
import { formatDealDate, formatEok } from "@/lib/utils/format";

/** 층별 시세·전월세는 최근 2년 거래만 쓴다 (오래된 거래가 층 차이를 흐리지 않게). */
const WINDOW_MONTHS = 24;
/** 층 구간별 최소 표본. 미만이면 값 대신 "표본 부족". */
const MIN_SAMPLE = 3;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function monthsAgoIso(months: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.toISOString().slice(0, 10);
}

const isJeonse = (i: AptHistoryItem) => i.dealType === "rent" && Number(i.monthlyRent ?? 0) === 0;
const isWolse = (i: AptHistoryItem) => i.dealType === "rent" && Number(i.monthlyRent ?? 0) > 0;

/* ---------- 1. 층별 시세 ---------- */

type FloorBand = { key: string; label: string; range: string; prices: number[] };

function floorBands(trades: AptHistoryItem[], maxFloor: number | null): FloorBand[] {
  const top = maxFloor && maxFloor > 0 ? maxFloor : Math.max(...trades.map((t) => t.floor), 1);
  const lowMax = Math.max(1, Math.round(top / 3));
  const midMax = Math.max(lowMax + 1, Math.round((top * 2) / 3));
  const bands: FloorBand[] = [
    { key: "low", label: "저층", range: `1~${lowMax}층`, prices: [] },
    { key: "mid", label: "중층", range: `${lowMax + 1}~${midMax}층`, prices: [] },
    { key: "high", label: "고층", range: `${midMax + 1}층 이상`, prices: [] },
  ];
  for (const t of trades) {
    if (!(t.floor > 0)) continue;
    const band = t.floor <= lowMax ? bands[0] : t.floor <= midMax ? bands[1] : bands[2];
    band!.prices.push(t.dealAmount);
  }
  return bands;
}

function FloorPrices({ trades, maxFloor }: { trades: AptHistoryItem[]; maxFloor: number | null }) {
  const bands = floorBands(trades, maxFloor);
  const overall = median(trades.map((t) => t.dealAmount));
  const medians = bands.map((b) => (b.prices.length >= MIN_SAMPLE ? median(b.prices) : null));
  const max = Math.max(...medians.map((m) => m ?? 0), 1);

  return (
    <div className="flex flex-col gap-3">
      <LabSubsectionHeader
        title="층별 시세"
        meta={`최근 2년 매매 ${trades.length.toLocaleString("ko-KR")}건 · 중위가`}
        tip="최고층을 3등분해 저층·중층·고층으로 나눈 뒤 구간별 매매가 중위값을 비교합니다. 구간 거래가 3건 미만이면 표시하지 않습니다."
      />
      <ul className={LAB_LIST}>
        {bands.map((b, i) => {
          const m = medians[i];
          const diff = m != null && overall ? Math.round((m / overall - 1) * 100) : null;
          return (
            <LabListRow
              key={b.key}
              title={b.label}
              meta={`${b.range} · ${b.prices.length}건`}
              value={m != null ? formatEok(Math.round(m)) : "표본 부족"}
              sub={
                diff == null ? undefined : diff === 0 ? "전체와 비슷" : `전체 대비 ${diff > 0 ? "+" : "−"}${Math.abs(diff)}%`
              }
              valueTone={diff != null && diff > 0 ? "up" : diff != null && diff < 0 ? "down" : undefined}
            >
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[color:var(--lab-surface-subtle)]" aria-hidden>
                {m != null ? (
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${(m / max) * 100}%`, background: "var(--lab-brand-primary)", opacity: 0.7 }}
                  />
                ) : null}
              </div>
            </LabListRow>
          );
        })}
      </ul>
    </div>
  );
}

/* ---------- 2. 신고가 이력 ---------- */

type SingogaEvent = { item: AptHistoryItem; prevMax: number | null };

function singogaEvents(tradesAsc: AptHistoryItem[]): SingogaEvent[] {
  const events: SingogaEvent[] = [];
  let runningMax: number | null = null;
  for (const t of tradesAsc) {
    if (t.isSingoga) events.push({ item: t, prevMax: runningMax });
    runningMax = runningMax == null ? t.dealAmount : Math.max(runningMax, t.dealAmount);
  }
  return events.reverse();
}

function SingogaHistory({ tradesAsc, ruled }: { tradesAsc: AptHistoryItem[]; ruled: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const events = singogaEvents(tradesAsc);
  if (events.length === 0) return null;
  const visible = expanded ? events : events.slice(0, LAB_LIST_PREVIEW);
  const hidden = events.length - LAB_LIST_PREVIEW;
  const last = events[0]!.item;

  return (
    <div className={`${ruled ? LAB_SUBSECTION_RULE : ""} flex flex-col gap-3`}>
      <LabSubsectionHeader
        title="신고가 이력"
        meta={`${events.length}회 · 최근 ${formatDealDate(last.dealDate)}`}
        tip="그 시점까지의 이 면적 최고 매매가를 넘어선 거래입니다. 괄호 안은 직전 최고가입니다."
      />
      <ul className={LAB_LIST}>
        {visible.map(({ item, prevMax }) => {
          const jump = prevMax ? Math.round((item.dealAmount / prevMax - 1) * 1000) / 10 : null;
          return (
            <LabListRow
              key={item.id}
              title={formatDealDate(item.dealDate)}
              meta={`${item.floor}층`}
              value={formatEok(item.dealAmount)}
              valueTone="up"
              sub={jump != null && prevMax ? `+${jump}% (직전 ${formatEok(prevMax)})` : "첫 거래"}
            />
          );
        })}
      </ul>
      {hidden > 0 ? (
        <LabMoreButton expanded={expanded} onToggle={() => setExpanded((v) => !v)} label={`${hidden}건 더보기`} />
      ) : null}
    </div>
  );
}

/* ---------- 전월세 지표 (실거래 시세 섹션에서 사용) ---------- */

export type RentMetrics = {
  /** 전월세 전환율 % (연), 계산 불가면 null */
  conversionPct: number | null;
  /** 전월세 계약 중 월세 비중 % */
  wolseSharePct: number;
  jeonseCount: number;
  wolseCount: number;
};

/**
 * 최근 2년 전월세 계약에서 전환율·월세 비중.
 * 전환율 = 연 월세 ÷ (전세 중위가 − 월세 보증금), 전세 중위보다 보증금이 낮은 계약의 중위값.
 */
export function computeRentMetrics(items: AptHistoryItem[]): RentMetrics | null {
  const since = monthsAgoIso(WINDOW_MONTHS);
  const rents = items.filter((i) => i.dealType === "rent" && i.dealDate >= since);
  const jeonse = rents.filter(isJeonse);
  const wolse = rents.filter(isWolse);
  if (jeonse.length + wolse.length === 0) return null;
  const jeonseMedian = median(jeonse.map((i) => i.dealAmount));
  const conversion =
    jeonseMedian != null
      ? median(
          wolse
            .filter((i) => jeonseMedian - i.dealAmount > 0)
            .map((i) => ((Number(i.monthlyRent) * 12) / (jeonseMedian - i.dealAmount)) * 100),
        )
      : null;
  return {
    conversionPct: conversion,
    wolseSharePct: Math.round((wolse.length / (jeonse.length + wolse.length)) * 100),
    jeonseCount: jeonse.length,
    wolseCount: wolse.length,
  };
}

/**
 * 거래 분석 — 이미 불러온 실거래(선택 면적)만으로 계산한다. DB·외부 호출 없음.
 */
export function ComplexTradeInsightSection({
  items,
  maxFloor,
  areaLabel,
}: {
  /** 선택 면적으로 걸러진 전체 기간 거래 */
  items: AptHistoryItem[];
  maxFloor: number | null;
  areaLabel: string;
}) {
  const since = monthsAgoIso(WINDOW_MONTHS);
  const trades = items.filter((i) => i.dealType === "trade");
  const recentTrades = trades.filter((i) => i.dealDate >= since);
  const tradesAsc = [...trades].sort((a, b) => (a.dealDate < b.dealDate ? -1 : 1));

  const hasFloor = recentTrades.length >= MIN_SAMPLE;
  const hasSingoga = trades.some((t) => t.isSingoga);
  if (!hasFloor && !hasSingoga) return null;

  return (
    <LabSection id="section-trade-insight" title="거래 분석" meta={`${areaLabel} 기준`} className="gap-4">
      {hasFloor ? <FloorPrices trades={recentTrades} maxFloor={maxFloor} /> : null}
      {hasSingoga ? (
        <SingogaHistory tradesAsc={tradesAsc} ruled={hasFloor} />
      ) : null}
    </LabSection>
  );
}

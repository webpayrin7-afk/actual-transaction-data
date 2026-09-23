"use client";

import { InfoTip } from "@/components/ui/InfoTip";
import { computeRentMetrics } from "@/components/apt/ComplexTradeInsightSection";
import type { AptHistoryItem } from "@/lib/molit/apt-client";

/** 실거래 현황 섹션의 전월세 한 줄 요약 두 개 (policy §12.5): 전월세 전환율 · 월세 비중. */
export function ComplexRentMetrics({ items }: { items: AptHistoryItem[] }) {
  const m = computeRentMetrics(items);
  if (!m) return null;
  return (
    <>
      {m.conversionPct != null ? (
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <p className="detail-label inline-flex items-center">
            전월세 전환율
            <InfoTip aria-label="전월세 전환율 안내">
              최근 2년 월세 계약에서 월세 1년치를 (전세 중위가 − 월세 보증금)으로 나눈 비율의 중위값입니다.
              높을수록 같은 보증금 차이에 월세를 더 받습니다.
            </InfoTip>
          </p>
          <p className="detail-data-value-emphasis tabular-nums">
            연 {m.conversionPct.toFixed(1)}%
          </p>
        </div>
      ) : null}
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="detail-label inline-flex items-center">
          월세 비중
          <InfoTip aria-label="월세 비중 안내">
            최근 2년 전월세 계약 중 월세(보증부 월세 포함) 계약의 비율입니다.
          </InfoTip>
        </p>
        <p className="detail-data-value-emphasis tabular-nums">
          {m.wolseSharePct}%
          <span className="detail-meta ml-1.5">
            전세 {m.jeonseCount.toLocaleString("ko-KR")} · 월세 {m.wolseCount.toLocaleString("ko-KR")}건
          </span>
        </p>
      </div>
    </>
  );
}

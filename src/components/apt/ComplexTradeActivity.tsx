"use client";

import { InfoTip } from "@/components/ui/InfoTip";
import type { AptHistoryItem } from "@/lib/molit/apt-client";

function isoMonthsAgo(months: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.toISOString().slice(0, 10);
}

/**
 * 거래 활발도 한 줄 (policy §12.5 한 줄 요약): 최근 3개월 매매 건수 vs 직전 3개월.
 * 신고 기한(계약 후 30일) 때문에 최근 구간이 덜 잡힐 수 있어 팁에 명시한다 (policy §12.1).
 */
export function ComplexTradeActivity({ items }: { items: AptHistoryItem[] }) {
  const recentFrom = isoMonthsAgo(3);
  const prevFrom = isoMonthsAgo(6);
  const trades = items.filter((i) => i.dealType === "trade");
  const recent = trades.filter((i) => i.dealDate >= recentFrom).length;
  const prev = trades.filter((i) => i.dealDate >= prevFrom && i.dealDate < recentFrom).length;
  if (recent + prev === 0) return null;
  const change = prev > 0 ? Math.round((recent / prev - 1) * 100) : null;

  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <p className="detail-label inline-flex items-center">
        최근 3개월 매매
        <InfoTip aria-label="거래 활발도 안내">
          선택 면적의 계약일 기준 최근 3개월 매매 건수를 직전 3개월과 비교합니다. 신고는 계약 후 30일
          안에 이뤄져 최근 한 달은 아직 덜 집계됐을 수 있습니다.
        </InfoTip>
      </p>
      <p className="detail-data-value-emphasis tabular-nums">
        {recent.toLocaleString("ko-KR")}건
        <span
          className={`detail-meta ml-1.5 ${
            change != null && change > 0
              ? "!text-[color:var(--lab-change-up)]"
              : change != null && change < 0
                ? "!text-[color:var(--lab-change-down)]"
                : ""
          }`}
        >
          {change == null
            ? `직전 3개월 ${prev}건`
            : change === 0
              ? "직전 3개월과 같음"
              : `직전 3개월 대비 ${change > 0 ? "+" : "−"}${Math.abs(change)}%`}
        </span>
      </p>
    </div>
  );
}

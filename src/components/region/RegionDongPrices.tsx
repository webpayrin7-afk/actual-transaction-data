"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { LabTabs } from "@/components/ui/LabTabs";
import {
  MARKET_SECTION_SURFACE,
  MarketSectionHeader,
} from "@/components/region/RegionMarketSections";
import type { RegionDongPrice, RegionPriceTrend } from "@/lib/region/region-price-trend";

const SORTS = [
  { id: "price", label: "시세 높은 순" },
  { id: "change", label: "1년 상승률" },
  { id: "trades", label: "거래 많은 순" },
] as const;
type SortId = (typeof SORTS)[number]["id"];

const PREVIEW = 6;
const BAR = "#0F766E";

function pctText(pct: number | null): string {
  if (pct == null) return "—";
  const abs = Math.abs(pct).toFixed(1);
  return pct > 0 ? `▲ ${abs}%` : pct < 0 ? `▼ ${abs}%` : `${abs}%`;
}

function pctClass(pct: number | null): string {
  if (pct == null || pct === 0) return "text-[color:var(--lab-muted)]";
  return pct > 0 ? "detail-change-up" : "detail-change-down";
}

export function RegionDongPricesSection({
  lawdCd,
  regionName,
}: {
  lawdCd: string;
  regionName: string;
}) {
  const [sort, setSort] = useState<SortId>("price");
  const [expanded, setExpanded] = useState(false);
  const query = useQuery({
    queryKey: ["region-price-trend", lawdCd],
    queryFn: async () => {
      const res = await fetch(`/api/region-price-trend?lawd_cd=${lawdCd}`);
      if (!res.ok) throw new Error("trend");
      return (await res.json()) as RegionPriceTrend;
    },
    staleTime: 30 * 60_000,
    retry: 1,
  });
  const data = query.data?.status === "ok" ? query.data : null;
  const dongs = useMemo(() => {
    const list = (data?.dongs ?? []).filter((d) => d.pyeongPrice != null);
    const metric = (d: RegionDongPrice) =>
      sort === "price" ? d.pyeongPrice ?? 0 : sort === "change" ? d.change1y ?? -Infinity : d.tradeCount12m;
    return [...list].sort((a, b) => metric(b) - metric(a));
  }, [data, sort]);

  if (query.isError) return null;
  if (!query.isLoading && dongs.length < 2) return null;

  const visible = expanded ? dongs : dongs.slice(0, PREVIEW);
  const guPrice = data?.latest?.pyeongPrice ?? null;
  const maxPrice = Math.max(1, ...dongs.map((d) => d.pyeongPrice ?? 0));
  const maxTrades = Math.max(1, ...dongs.map((d) => d.tradeCount12m));
  const maxAbsChange = Math.max(1, ...dongs.map((d) => Math.abs(d.change1y ?? 0)));
  const asOf = data?.latest
    ? `${data.latest.yearMonth.slice(0, 4)}.${data.latest.yearMonth.slice(4, 6)}`
    : null;

  return (
    <section
      aria-label={`${regionName} 동네별 시세`}
      className={`${MARKET_SECTION_SURFACE} flex flex-col gap-3`}
    >
      <MarketSectionHeader
        title="동네별 시세"
        meta={asOf ? `공급면적 기준 · ${asOf}` : "공급면적 기준"}
        tip={
          <p>
            {regionName} 안에서 법정동별 시세 평당가와 1년 변화, 최근 1년 매매 거래량을
            비교합니다. 지역 시세 평당가와 같은 방식으로 산출합니다.
          </p>
        }
      />
      <LabTabs
        variant="secondary"
        ariaLabel="동네별 시세 정렬"
        items={SORTS}
        value={sort}
        onChange={(next) => {
          setSort(next);
          setExpanded(false);
        }}
      />
      {query.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-12 animate-pulse rounded-lg bg-slate-100" />
          ))}
        </div>
      ) : (
        <>
          {guPrice != null ? (
            <p className="detail-meta tabular-nums">
              {regionName} 전체 {guPrice.toLocaleString("ko-KR")}만원/평
            </p>
          ) : null}
          <ol className="flex flex-col divide-y divide-[color:var(--lab-border)]">
            {visible.map((d, index) => {
              const width =
                sort === "price"
                  ? ((d.pyeongPrice ?? 0) / maxPrice) * 100
                  : sort === "trades"
                    ? (d.tradeCount12m / maxTrades) * 100
                    : (Math.abs(d.change1y ?? 0) / maxAbsChange) * 100;
              const barColor =
                sort === "change" && (d.change1y ?? 0) < 0 ? "var(--lab-change-down)" : BAR;
              return (
                <li key={d.bjdongCd} className="flex flex-col gap-1.5 py-2.5">
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="flex min-w-0 items-baseline gap-2">
                      <span className="detail-meta w-4 shrink-0 text-right tabular-nums">
                        {index + 1}
                      </span>
                      <span className="detail-data-value-emphasis truncate">{d.name}</span>
                    </p>
                    <p className="shrink-0 whitespace-nowrap tabular-nums">
                      {sort === "trades" ? (
                        <span className="detail-data-value-emphasis">
                          {d.tradeCount12m.toLocaleString("ko-KR")}건
                        </span>
                      ) : (
                        <span className="detail-data-value-emphasis">
                          {(d.pyeongPrice ?? 0).toLocaleString("ko-KR")}만원
                        </span>
                      )}
                      <span className={`detail-meta ml-2 ${pctClass(d.change1y)}`}>
                        {pctText(d.change1y)}
                      </span>
                    </p>
                  </div>
                  <div className="ml-6 flex items-center gap-2">
                    <div
                      className="h-1.5 flex-1 overflow-hidden rounded-full bg-[color:var(--lab-surface-subtle)]"
                      aria-hidden
                    >
                      <div
                        className="h-full rounded-full"
                        style={{ width: `${Math.max(2, width)}%`, background: barColor, opacity: 0.8 }}
                      />
                    </div>
                    <span className="detail-meta shrink-0 whitespace-nowrap tabular-nums">
                      단지 {d.complexCount}곳
                      {sort !== "trades" ? ` · 1년 ${d.tradeCount12m.toLocaleString("ko-KR")}건` : ""}
                    </span>
                  </div>
                </li>
              );
            })}
          </ol>
          {dongs.length > PREVIEW ? (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              className="lab-button lab-button-secondary w-full"
            >
              {expanded ? "접기" : `${dongs.length - PREVIEW}개 동 더 보기`}
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}

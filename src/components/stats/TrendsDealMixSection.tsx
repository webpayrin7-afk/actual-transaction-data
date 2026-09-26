"use client";

import { useMemo, useState } from "react";
import { LabSection } from "@/components/ui/LabSection";
import { LabShareBars } from "@/components/ui/LabShareBars";
import { LabStackedBar } from "@/components/ui/LabStackedBar";
import { LabTabs } from "@/components/ui/LabTabs";
import {
  AREA_BAND_LABELS,
  PRICE_BAND_LABELS,
  type AreaBand,
  type DealKind,
  type DealStatsPayload,
} from "@/lib/market/deal-stats";
import type { TrendPeriod } from "@/lib/market/trends-regions";
import { ChartLoading, SectionError, sliceByPeriod, ymDot } from "@/components/stats/trends-chart-kit";

const KINDS = [
  { id: "trade", label: "매매" },
  { id: "jeonse", label: "전세" },
] as const;

/** 낮은 가격대 → 높은 가격대. 막대 색이며 범례 이름과 함께 쓴다. */
const BAND_COLORS = ["#CBD5E1", "#99F6E4", "#5EEAD4", "#2DD4BF", "#14B8A6", "#0F766E", "#134E4A"];

type YearMix = {
  year: string;
  months: number;
  count: number;
  bands: number[];
  partial: boolean;
};

function yearlyMix(
  data: DealStatsPayload | null,
  kind: DealKind,
  area: AreaBand,
  period: TrendPeriod,
): YearMix[] {
  const points = (data?.points ?? []).filter((p) => p.kind === kind && p.area === area);
  const sliced = sliceByPeriod(points, period);
  const byYear = new Map<string, YearMix>();
  for (const p of sliced) {
    const year = p.ym.slice(0, 4);
    const row = byYear.get(year) ?? {
      year,
      months: 0,
      count: 0,
      bands: new Array(PRICE_BAND_LABELS[kind].length).fill(0),
      partial: false,
    };
    row.months += 1;
    row.count += p.count;
    p.bands.forEach((n, i) => {
      row.bands[i] = (row.bands[i] ?? 0) + n;
    });
    byYear.set(year, row);
  }
  const years = [...byYear.values()].sort((a, b) => a.year.localeCompare(b.year));
  for (const row of years) row.partial = row.months < 12;
  return years.filter((row) => row.count > 0);
}

export function TrendsDealMixSection({
  regionLabel,
  data,
  period,
  loading,
  error,
  onRetry,
}: {
  regionLabel: string;
  data: DealStatsPayload | null;
  period: TrendPeriod;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
}) {
  const [kind, setKind] = useState<DealKind>("trade");
  const area: AreaBand = "all";
  const years = useMemo(() => yearlyMix(data, kind, area, period), [data, kind, period]);
  const latest = years.at(-1) ?? null;
  const labels = PRICE_BAND_LABELS[kind];

  return (
    <LabSection
      id="deal-mix"
      title="가격대 구성"
      label={`${regionLabel} 아파트 실거래 가격대 구성`}
      meta={latest ? `${latest.year}년 · ${AREA_BAND_LABELS[area]}` : undefined}
      tip={
        <>
          <p>
            연도 안에 신고된 거래 건수를 가격대별로 쌓았습니다. 막대 길이는 그 해 구성비이고, 오른쪽 숫자는 거래
            건수입니다. 가격대 경계는 매매와 전세가 다릅니다.
          </p>
          <p className="mt-1.5">
            출처: 국토교통부 실거래가 ({kind === "trade" ? "매매" : "전세"} · {AREA_BAND_LABELS[area]})
            {data?.from ? ` · ${ymDot(data.from)}부터` : ""}
            {data?.medianMethod === "pooled" ? " · 소속 시군구 거래를 합산" : ""}
          </p>
        </>
      }
    >
      {error ? (
        <SectionError onRetry={onRetry} />
      ) : (
        <>
          <LabTabs variant="secondary" items={KINDS} value={kind} onChange={setKind} ariaLabel="가격대 거래 종류" />
          {loading ? (
            <ChartLoading label="가격대 거래 불러오는 중" />
          ) : years.length === 0 ? (
            <p className="lab-state">{data?.note ?? "표시할 실거래가 없습니다."}</p>
          ) : (
            <>
              <ul className="flex flex-wrap gap-x-3 gap-y-1">
                {labels.map((label, i) => (
                  <li key={label} className="detail-meta inline-flex items-center gap-1">
                    <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: BAND_COLORS[i] }} aria-hidden />
                    {label}
                  </li>
                ))}
              </ul>
              <ul className="flex flex-col gap-2">
                {years.map((row) => (
                  <li key={row.year} className="grid grid-cols-[3.25rem_1fr_auto] items-center gap-2">
                    <span className="detail-label tabular-nums">
                      {row.year}
                      {row.partial ? <span className="sr-only"> {row.months}개월</span> : null}
                    </span>
                    <LabStackedBar
                      className="h-3"
                      segments={labels.map((label, i) => ({
                        key: label,
                        value: row.bands[i] ?? 0,
                        color: BAND_COLORS[i]!,
                      }))}
                    />
                    <span className="detail-meta tabular-nums whitespace-nowrap">
                      {row.count.toLocaleString("ko-KR")}건
                      {row.partial ? ` · ${row.months}개월` : ""}
                    </span>
                  </li>
                ))}
              </ul>
              {latest ? (
                <div className="flex flex-col gap-2">
                  <p className="detail-subsection-title">{latest.year}년 구성</p>
                  <LabShareBars
                    sort="none"
                    items={labels.map((label, i) => ({
                      key: label,
                      label,
                      value: latest.bands[i] ?? 0,
                      sub: `${(latest.bands[i] ?? 0).toLocaleString("ko-KR")}건`,
                    }))}
                  />
                </div>
              ) : null}
            </>
          )}
        </>
      )}
    </LabSection>
  );
}

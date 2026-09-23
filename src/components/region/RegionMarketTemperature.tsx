"use client";

import { useMemo } from "react";
import {
  Area,
  ComposedChart,
  ReferenceLine,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from "recharts";
import { LabSubsectionHeader } from "@/components/ui/LabSection";
import { LabStatTiles, type LabStatTile } from "@/components/ui/LabStatTiles";
import { useRegionMarketDetail } from "@/components/region/useRegionMarketDetail";

const MONTHS_SHOWN = 36;
const POOL = 3;
const LINE = "#087F83";

type Point = { yearMonth: string; label: string; share: number | null; sample: number };

function monthIndex(ym: string): number {
  return Number(ym.slice(0, 4)) * 12 + Number(ym.slice(4, 6)) - 1;
}

function ymFromIndex(idx: number): string {
  return `${Math.floor(idx / 12)}${String((idx % 12) + 1).padStart(2, "0")}`;
}

/** 직전 거래 대비 오른 거래 비율(3개월 묶음). 보합·비교 불가 거래는 분모에서 뺀다. */
export function RegionMarketTemperature({ lawdCd }: { lawdCd: string }) {
  const query = useRegionMarketDetail(lawdCd);
  const points = useMemo<Point[]>(() => {
    const months = query.data?.months ?? {};
    const keys = Object.keys(months).sort();
    if (!keys.length) return [];
    const last = monthIndex(keys[keys.length - 1]!);
    const out: Point[] = [];
    for (let m = last - MONTHS_SHOWN + 1; m <= last; m += 1) {
      let up = 0;
      let down = 0;
      for (let k = m - POOL + 1; k <= m; k += 1) {
        const d = months[ymFromIndex(k)]?.direction;
        if (d) {
          up += d.up;
          down += d.down;
        }
      }
      const ym = ymFromIndex(m);
      out.push({
        yearMonth: ym,
        label: `${ym.slice(0, 4)}.${ym.slice(4, 6)}`,
        share: up + down >= 10 ? Math.round((up / (up + down)) * 1000) / 10 : null,
        sample: up + down,
      });
    }
    return out;
  }, [query.data]);

  if (query.isError) return null;
  const latest = [...points].reverse().find((p) => p.share != null) ?? null;
  const yearAgo =
    latest != null
      ? points.find((p) => monthIndex(p.yearMonth) === monthIndex(latest.yearMonth) - 12) ?? null
      : null;
  const yearTicks = points.filter((p) => p.yearMonth.endsWith("01")).map((p) => p.label);
  const a = query.data?.analysis;
  const shareOf = (n: number | undefined) =>
    a && a.tradeCount > 0 && n != null ? Math.round((n / a.tradeCount) * 100) : null;
  const highShare = shareOf(a?.recordHighCount);
  const peakShare = shareOf(a?.belowPeakCount);
  const tiles: LabStatTile[] = [
    {
      key: "up",
      label: "오른 거래",
      value: latest?.share != null ? `${Math.round(latest.share)}%` : "—",
      sub: yearAgo?.share != null ? `1년 전 ${Math.round(yearAgo.share)}%` : undefined,
      tone: "neutral",
    },
    {
      key: "high",
      label: "신고가",
      value: highShare != null ? `${highShare}%` : "—",
      sub: a ? `${a.recordHighCount.toLocaleString("ko-KR")}건` : undefined,
      tone: "up",
    },
    {
      key: "peak",
      label: "고점 −10%",
      value: peakShare != null ? `${peakShare}%` : "—",
      sub: a ? `${a.belowPeakCount.toLocaleString("ko-KR")}건` : undefined,
      tone: "down",
    },
  ];

  return (
    <div>
      <LabSubsectionHeader
        title="시장 온도"
        meta={a ? `최근 3개월 · 매매 ${a.tradeCount.toLocaleString("ko-KR")}건` : undefined}
        tip={
          <>
            <p>
              오른 거래: 같은 단지·면적의 직전 거래보다 오른 가격에 거래된 비율입니다.
              3개월씩 묶어 계산하며, 그래프가 50%보다 높으면 오른 거래가 내린 거래보다
              많았다는 뜻입니다.
            </p>
            <p className="mt-1.5">신고가: 종전 최고가를 넘은 거래</p>
            <p>고점 −10%: 종전 최고가보다 10% 이상 낮은 거래</p>
          </>
        }
      />
      {query.isLoading ? (
        <div className="mt-2 h-[140px] animate-pulse rounded-lg bg-slate-100" />
      ) : points.length < 2 ? null : (
        <div className="mt-2 h-[140px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={points} margin={{ top: 6, right: 4, bottom: 0, left: -18 }}>
              <XAxis
                dataKey="label"
                ticks={yearTicks}
                tickFormatter={(v: string) => v.slice(0, 4)}
                tick={{ fontSize: 12, fill: "#64748b" }}
                tickLine={false}
                axisLine={{ stroke: "#e2e8f0" }}
                interval={0}
              />
              <YAxis
                domain={[0, 100]}
                ticks={[0, 50, 100]}
                tickFormatter={(v: number) => `${v}%`}
                tick={{ fontSize: 12, fill: "#64748b" }}
                tickLine={false}
                axisLine={false}
                width={44}
              />
              <ReferenceLine y={50} stroke="#94a3b8" strokeDasharray="3 3" />
              <Area
                dataKey="share"
                type="monotone"
                stroke={LINE}
                strokeWidth={2}
                fill={LINE}
                fillOpacity={0.08}
                connectNulls
                isAnimationActive={false}
                dot={false}
                activeDot={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
      <LabStatTiles items={tiles} columns={3} loading={query.isLoading} className="mt-3" />
    </div>
  );
}

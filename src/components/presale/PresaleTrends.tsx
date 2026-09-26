"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bar, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { PresaleQuarter, PresaleTrends as Trends } from "@/lib/applyhome/read";
import { METRO_LABELS } from "@/lib/constants/regions";
import { LabSection } from "@/components/ui/LabSection";
import { LabStatTiles } from "@/components/ui/LabStatTiles";
import { LAB_LIST, LabListRow } from "@/components/ui/LabListRow";
import { LAB_LIST_PREVIEW, LabMoreButton } from "@/components/ui/LabMoreButton";
import {
  CHART_AXIS_LINE,
  CHART_BOX,
  CHART_DOWN,
  CHART_JEONSE,
  CHART_TICK,
  CHART_TRADE,
  CHART_VOLUME,
  ChartLegend,
  ChartLoading,
  ChartTooltipBox,
  niceTicks,
  signedPct,
  toneOf,
} from "@/components/stats/trends-chart-kit";
import { LabDataLoading } from "@/components/ui/LabLoading";

async function fetchTrends(): Promise<Trends> {
  const res = await fetch("/api/applyhome/trends");
  if (!res.ok) throw new Error("분양 동향을 불러오지 못했습니다.");
  return res.json();
}

/** "2026Q3" → 축 "26.3Q", 툴팁 "2026년 3분기" */
const qAxis = (q: string) => `${q.slice(2, 4)}.${q.slice(5)}Q`;
const qLong = (q: string) => `${q.slice(0, 4)}년 ${q.slice(5)}분기`;
const man = (v: number) => `${Math.round(v).toLocaleString("ko-KR")}만`;
const pctChange = (a: number | null, b: number | null) => (a != null && b ? ((a - b) / b) * 100 : null);

/** 눈금이 최댓값을 덮지 못하면 한 칸 더 (선이 차트 위로 잘리지 않게) */
function coverTicks(ticks: number[], max: number): number[] {
  if (ticks.length < 2) return ticks;
  const step = ticks[1]! - ticks[0]!;
  const out = [...ticks];
  while (out.at(-1)! < max) out.push(out.at(-1)! + step);
  return out;
}

function Change({ pct, label = "직전 12개월 대비" }: { pct: number | null; label?: string }) {
  if (pct == null) return <>직전 자료 없음</>;
  const t = toneOf(pct);
  return (
    <span className={t === "up" ? "detail-change-up" : t === "down" ? "detail-change-down" : ""}>
      {label} {signedPct(pct)}
    </span>
  );
}

function useTrends() {
  return useQuery({ queryKey: ["applyhome-trends"], queryFn: fetchTrends, staleTime: 60 * 60_000 });
}

const TIP_BASIS =
  "한국부동산원 청약홈 분양 공고(임대 제외)를 1순위 접수 마감일 기준으로 모았습니다. 원천 값을 그대로 셌고 추정하지 않았습니다.";

/** 분양 동향 요약 — 최근 12개월 vs 직전 12개월 */
export function PresaleTrendSummary() {
  const q = useTrends();
  const d = q.data;
  if (q.isError) return null;
  return (
    <LabSection
      title="최근 12개월 분양"
      tip={
        <p>
          {TIP_BASIS} 경쟁률은 1순위 접수 ÷ 일반공급 세대, 미달 비율은 1·2순위 접수를 합쳐도 일반공급 세대에 못
          미친 주택형의 비율입니다.
        </p>
      }
    >
      <LabStatTiles
        columns={4}
        loading={!d}
        items={[
          {
            key: "n",
            label: "분양 공고",
            value: d ? `${d.recent.notices.toLocaleString("ko-KR")}곳` : "—",
            sub: d ? <Change pct={pctChange(d.recent.notices, d.prior.notices)} label="직전 대비" /> : undefined,
          },
          {
            key: "h",
            label: "공급 세대",
            value: d ? `${(d.recent.households / 10_000).toFixed(1)}만` : "—",
            sub: d ? <Change pct={pctChange(d.recent.households, d.prior.households)} label="직전 대비" /> : undefined,
          },
          {
            key: "r",
            label: "1순위 경쟁률",
            value: d?.recent.rate != null ? `${d.recent.rate}:1` : "—",
            sub: d?.prior.rate != null ? `직전 ${d.prior.rate}:1` : undefined,
          },
          {
            key: "s",
            label: "청약 미달",
            value: d?.recent.shortPct != null ? `${d.recent.shortPct}%` : "—",
            sub: d?.prior.shortPct != null ? `직전 ${d.prior.shortPct}%` : undefined,
          },
        ]}
      />
    </LabSection>
  );
}

function QuarterChart({
  rows,
  children,
  yTicks,
  yFormat,
  tooltip,
  right,
}: {
  rows: PresaleQuarter[];
  children: React.ReactNode;
  yTicks: number[];
  yFormat: (v: number) => string;
  tooltip: (row: PresaleQuarter) => React.ReactNode;
  right?: { ticks: number[]; format: (v: number) => string };
}) {
  return (
    <div className={CHART_BOX}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows} margin={{ top: 8, right: right ? 0 : 4, bottom: 0, left: -8 }} barCategoryGap="30%">
          <XAxis
            dataKey="q"
            tickFormatter={qAxis}
            tick={CHART_TICK}
            tickLine={false}
            axisLine={CHART_AXIS_LINE}
            interval="preserveStartEnd"
            minTickGap={12}
          />
          <YAxis
            yAxisId="l"
            domain={[yTicks[0] ?? 0, yTicks.at(-1) ?? "auto"]}
            ticks={yTicks}
            tick={CHART_TICK}
            tickLine={false}
            axisLine={false}
            width={48}
            tickFormatter={yFormat}
          />
          {right ? (
            <YAxis
              yAxisId="r"
              orientation="right"
              domain={[0, right.ticks.at(-1) ?? "auto"]}
              ticks={right.ticks}
              tick={CHART_TICK}
              tickLine={false}
              axisLine={false}
              width={36}
              tickFormatter={right.format}
            />
          ) : null}
          <Tooltip
            cursor={{ fill: "rgba(148,163,184,0.12)" }}
            content={({ active, label }) => {
              const row = active ? rows.find((r) => r.q === label) : null;
              return row ? tooltip(row) : null;
            }}
          />
          {children}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

/** 분기별 분양 물량 (공급 세대 + 공고 수) */
export function PresaleVolumeChart() {
  const q = useTrends();
  const rows = q.data?.quarters ?? [];
  if (q.isError) return null;
  const hMax = rows.length ? Math.max(...rows.map((r) => r.households)) : 0;
  const ticks = rows.length ? coverTicks(niceTicks(0, hMax), hMax) : [0];
  return (
    <LabSection title="분기별 분양 물량" meta="1순위 마감 분기" tip={<p>{TIP_BASIS} 마지막 분기는 진행 중이라 적게 보일 수 있습니다.</p>}>
      {!rows.length ? (
        <ChartLoading label="분양 물량 불러오는 중" />
      ) : (
        <>
          <QuarterChart
            rows={rows}
            yTicks={ticks}
            yFormat={(v) => (v >= 10_000 ? `${v / 10_000}만` : v.toLocaleString("ko-KR"))}
            tooltip={(r) => (
              <ChartTooltipBox
                title={qLong(r.q)}
                rows={[
                  { key: "h", name: "공급 세대", color: CHART_VOLUME, value: `${r.households.toLocaleString("ko-KR")}세대` },
                  { key: "n", name: "분양 공고", color: CHART_TRADE, value: `${r.notices}곳` },
                ]}
              />
            )}
          >
            <Bar yAxisId="l" dataKey="households" fill={CHART_VOLUME} fillOpacity={0.4} isAnimationActive={false} radius={[3, 3, 0, 0]} />
          </QuarterChart>
          <ChartLegend items={[{ key: "h", label: "공급 세대", color: CHART_VOLUME, shape: "bar" }]} />
        </>
      )}
    </LabSection>
  );
}

/** 평당 분양가 추이 — 수도권 vs 지방 (공급면적 기준 중위) */
export function PresalePriceChart() {
  const q = useTrends();
  const rows = q.data?.quarters ?? [];
  if (q.isError) return null;
  const vals = rows.flatMap((r) => [r.pppCapital, r.pppOther]).filter((v): v is number => v != null);
  const ticks = vals.length ? coverTicks(niceTicks(Math.min(...vals) * 0.9, Math.max(...vals)), Math.max(...vals)) : [0];
  const last = rows.at(-1);
  return (
    <LabSection
      title="평당 분양가 추이"
      meta="공급면적 3.3㎡당 중위"
      tip={
        <p>
          주택형별 최고 분양가를 공급면적(평)으로 나눈 값의 분기 중위값입니다. 수도권은 서울·경기·인천, 나머지는
          지방입니다. 한 분기 주택형이 5개 미만이면 비웁니다.
        </p>
      }
    >
      {!rows.length ? (
        <ChartLoading label="분양가 불러오는 중" />
      ) : (
        <>
          {last ? (
            <p className="detail-meta tabular-nums">
              {qLong(last.q)} 수도권 {last.pppCapital != null ? man(last.pppCapital) : "—"} · 지방{" "}
              {last.pppOther != null ? man(last.pppOther) : "—"}
            </p>
          ) : null}
          <QuarterChart
            rows={rows}
            yTicks={ticks}
            yFormat={(v) => v.toLocaleString("ko-KR")}
            tooltip={(r) => (
              <ChartTooltipBox
                title={qLong(r.q)}
                rows={[
                  { key: "c", name: "수도권", color: CHART_TRADE, value: r.pppCapital != null ? man(r.pppCapital) : "—" },
                  { key: "o", name: "지방", color: CHART_JEONSE, value: r.pppOther != null ? man(r.pppOther) : "—" },
                ]}
              />
            )}
          >
            <Line yAxisId="l" dataKey="pppCapital" stroke={CHART_TRADE} strokeWidth={2} dot={{ r: 2.5 }} connectNulls isAnimationActive={false} />
            <Line yAxisId="l" dataKey="pppOther" stroke={CHART_JEONSE} strokeWidth={2} dot={{ r: 2.5 }} connectNulls isAnimationActive={false} />
          </QuarterChart>
          <ChartLegend
            items={[
              { key: "c", label: "수도권", color: CHART_TRADE, shape: "line" },
              { key: "o", label: "지방", color: CHART_JEONSE, shape: "line" },
            ]}
          />
        </>
      )}
    </LabSection>
  );
}

/** 1순위 경쟁률 · 청약 미달 비율 추이 */
export function PresaleRateChart() {
  const q = useTrends();
  const rows = q.data?.quarters ?? [];
  if (q.isError) return null;
  const rates = rows.map((r) => r.rate ?? 0);
  const ticks = rates.length ? coverTicks(niceTicks(0, Math.max(...rates)), Math.max(...rates)) : [0];
  const shortMax = Math.max(50, ...rows.map((r) => r.shortPct ?? 0));
  const shortTicks = coverTicks(niceTicks(0, shortMax), shortMax);
  return (
    <LabSection
      title="경쟁률 · 미달 비율"
      meta="분기"
      tip={
        <p>
          선은 1순위 경쟁률(1순위 접수 ÷ 일반공급, 왼쪽 축), 막대는 1·2순위 접수를 합쳐도 일반공급 세대에 못 미친
          주택형 비율(오른쪽 축)입니다. 예비 입주자 비율은 반영하지 않았습니다.
        </p>
      }
    >
      {!rows.length ? (
        <ChartLoading label="경쟁률 불러오는 중" />
      ) : (
        <>
          <QuarterChart
            rows={rows}
            yTicks={ticks}
            yFormat={(v) => `${v}:1`}
            right={{ ticks: shortTicks, format: (v) => `${v}%` }}
            tooltip={(r) => (
              <ChartTooltipBox
                title={qLong(r.q)}
                rows={[
                  { key: "r", name: "1순위 경쟁률", color: CHART_TRADE, value: r.rate != null ? `${r.rate}:1` : "—" },
                  { key: "s", name: "청약 미달", color: CHART_DOWN, value: r.shortPct != null ? `${r.shortPct}%` : "—" },
                ]}
              />
            )}
          >
            <Bar yAxisId="r" dataKey="shortPct" fill={CHART_DOWN} fillOpacity={0.22} isAnimationActive={false} radius={[3, 3, 0, 0]} />
            <Line yAxisId="l" dataKey="rate" stroke={CHART_TRADE} strokeWidth={2} dot={{ r: 2.5 }} isAnimationActive={false} />
          </QuarterChart>
          <ChartLegend
            items={[
              { key: "r", label: "1순위 경쟁률", color: CHART_TRADE, shape: "line" },
              { key: "s", label: "청약 미달 비율", color: CHART_DOWN, shape: "bar" },
            ]}
          />
        </>
      )}
    </LabSection>
  );
}

/** 시·도별 청약 성적 — 최근 12개월, 1순위 경쟁률 높은 순 */
export function PresaleMetroTable() {
  const q = useTrends();
  const [expanded, setExpanded] = useState(false);
  const items = q.data?.metros ?? [];
  if (q.isError || (q.isSuccess && items.length === 0)) return null;
  const visible = expanded ? items : items.slice(0, LAB_LIST_PREVIEW);
  return (
    <LabSection
      title="시·도별 청약 성적"
      meta="최근 12개월"
      tip={<p>{TIP_BASIS} 1순위 경쟁률이 높은 시·도부터 보여줍니다. 평당 분양가는 공급면적 기준 중위값입니다.</p>}
    >
      {!q.data ? (
        <LabDataLoading label="청약 성적 불러오는 중" minHeight={240} />
      ) : (
        <>
          <ul className={LAB_LIST}>
            {visible.map((m) => (
              <LabListRow
                key={m.metro}
                title={METRO_LABELS[m.metro as keyof typeof METRO_LABELS] ?? m.metro}
                meta={[
                  `공고 ${m.notices}곳`,
                  `${m.households.toLocaleString("ko-KR")}세대`,
                  m.ppp != null ? `평당 ${man(m.ppp)}` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
                value={m.rate != null ? `${m.rate}:1` : "—"}
                sub={m.shortPct != null ? `미달 ${m.shortPct}%` : null}
              />
            ))}
          </ul>
          {items.length > LAB_LIST_PREVIEW ? (
            <LabMoreButton
              expanded={expanded}
              onToggle={() => setExpanded((v) => !v)}
              label={`${items.length - LAB_LIST_PREVIEW}곳 더보기`}
            />
          ) : null}
        </>
      )}
    </LabSection>
  );
}

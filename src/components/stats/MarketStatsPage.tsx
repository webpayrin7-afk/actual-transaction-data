"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Area,
  AreaChart,
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  TrendingUp,
} from "lucide-react";
import type { MarketStatsResponse, StatsRegionRank } from "@/lib/market/stats";
import type { StatsPeriod, StatsScope } from "@/lib/market/keys";
import { formatDealDate, formatEok } from "@/lib/utils/format";

async function fetchStats(
  period: StatsPeriod,
  scope: StatsScope,
): Promise<MarketStatsResponse> {
  const res = await fetch(
    `/api/market-stats?period=${period}&scope=${scope}`,
  );
  if (!res.ok) throw new Error("통계 데이터를 불러오지 못했습니다.");
  return res.json();
}

function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="flex w-full gap-1 rounded-xl border border-slate-200 bg-slate-50 p-1">
      {options.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={`min-w-0 flex-1 rounded-lg px-2 py-1.5 text-center text-sm font-medium transition sm:px-3 ${
              active
                ? "bg-white text-slate-900 shadow-sm"
                : "text-slate-600 hover:text-slate-900"
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function ChangeText({ pct }: { pct: number | null }) {
  if (pct == null) return <span className="text-slate-400">대비 없음</span>;
  const up = pct > 0;
  const down = pct < 0;
  return (
    <span
      className={`inline-flex items-center gap-0.5 tabular-nums ${
        up ? "text-teal-700" : down ? "text-rose-600" : "text-slate-500"
      }`}
    >
      {up ? (
        <ArrowUpRight className="h-3.5 w-3.5" />
      ) : down ? (
        <ArrowDownRight className="h-3.5 w-3.5" />
      ) : null}
      {pct > 0 ? "+" : ""}
      {pct}%
    </span>
  );
}

function KpiCard({
  label,
  value,
  sub,
  change,
}: {
  label: string;
  value: string;
  sub?: string;
  change: number | null;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3.5">
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums text-slate-900">
        {value}
      </p>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500">
        <ChangeText pct={change} />
        {sub ? <span>{sub}</span> : null}
      </div>
    </div>
  );
}

function RankList({
  title,
  items,
  mode,
}: {
  title: string;
  items: StatsRegionRank[];
  mode: "volume" | "growth" | "singoga" | "drop";
}) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white">
      <div className="border-b border-slate-100 px-4 py-3 sm:px-5">
        <h2 className="text-sm font-semibold text-slate-900 sm:text-base">
          {title}
        </h2>
      </div>
      {items.length === 0 ? (
        <p className="px-4 py-10 text-center text-sm text-slate-500">
          표시할 지역이 없습니다.
        </p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {items.map((item, idx) => (
            <li key={item.lawdCd}>
              <Link
                href={item.href}
                className="flex items-center justify-between gap-3 px-4 py-3 transition hover:bg-slate-50 sm:px-5"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-slate-900">
                    <span className="mr-2 text-xs font-medium text-slate-400">
                      {idx + 1}
                    </span>
                    {item.regionName}
                  </p>
                  <p className="mt-0.5 text-[11px] text-slate-500">
                    {item.metro === "seoul" ? "서울" : "경기"} · 직전{" "}
                    {item.tradePrev.toLocaleString("ko-KR")}건
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  {mode === "volume" || mode === "growth" ? (
                    <>
                      <p className="text-sm font-semibold tabular-nums text-slate-900">
                        {item.tradeCount.toLocaleString("ko-KR")}건
                      </p>
                      <p className="mt-0.5 text-xs">
                        <ChangeText pct={item.growthPct} />
                      </p>
                    </>
                  ) : mode === "singoga" ? (
                    <>
                      <p className="text-sm font-semibold tabular-nums text-teal-800">
                        신고가 {item.singogaCount.toLocaleString("ko-KR")}
                      </p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        비중 {item.singogaSharePct ?? "-"}% · 거래{" "}
                        {item.tradeCount}
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="text-sm font-semibold tabular-nums text-rose-700">
                        하락 {item.dropCount.toLocaleString("ko-KR")}
                      </p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        비중 {item.dropSharePct ?? "-"}% · 거래{" "}
                        {item.tradeCount}
                      </p>
                    </>
                  )}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ChartCard({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
      <div className="mb-3">
        <h2 className="text-sm font-semibold text-slate-900 sm:text-base">
          {title}
        </h2>
        {hint ? (
          <p className="mt-0.5 text-xs text-slate-500">{hint}</p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function StatsXAxis({ interval }: { interval: number }) {
  return (
    <XAxis
      dataKey="label"
      interval={interval}
      minTickGap={28}
      tick={{ fill: "#64748b", fontSize: 11 }}
      tickMargin={8}
      height={32}
      axisLine={{ stroke: "#cbd5e1" }}
      tickLine={false}
    />
  );
}

export function MarketStatsPage() {
  const [period, setPeriod] = useState<StatsPeriod>("weekly");
  const [scope, setScope] = useState<StatsScope>("all");

  const query = useQuery({
    queryKey: ["market-stats", period, scope],
    queryFn: () => fetchStats(period, scope),
    staleTime: 60_000,
  });

  const data = query.data;

  const chartData = useMemo(
    () =>
      (data?.series ?? []).map((p) => ({
        ...p,
        medianEok:
          p.medianAmount != null
            ? Math.round((p.medianAmount / 10000) * 100) / 100
            : null,
      })),
    [data?.series],
  );

  // 기간별 최대 눈금 수에 맞춰 interval 계산 (0=전부, n=n+1개마다 1개)
  const axisInterval = useMemo(() => {
    const n = chartData.length;
    if (n <= 1) return 0;
    const maxTicks =
      period === "daily" ? 6 : period === "weekly" ? 6 : 7;
    if (n <= maxTicks) return 0;
    return Math.ceil(n / maxTicks) - 1;
  }, [chartData.length, period]);

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
      <div className="max-w-3xl">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">
          아파트 시장 통계
        </h1>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          거래량과 가격 흐름, 신고가·하락거래 변화를 일·주·월 단위로 확인하세요.
        </p>
        {data?.asOfDate ? (
          <p className="mt-2 text-xs text-slate-500">
            데이터 기준 {formatDealDate(data.asOfDate)}
            {data.kpi ? ` · ${data.kpi.windowLabel}` : null}
          </p>
        ) : null}
        {data?.dateBasisNote ? (
          <p className="mt-1 text-[11px] text-slate-400">{data.dateBasisNote}</p>
        ) : null}
      </div>

      <div className="grid w-full grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4">
        <Segmented
          value={period}
          onChange={setPeriod}
          options={[
            { value: "daily", label: "일간" },
            { value: "weekly", label: "주간" },
            { value: "monthly", label: "월간" },
          ]}
        />
        <Segmented
          value={scope}
          onChange={setScope}
          options={[
            { value: "all", label: "전체" },
            { value: "seoul", label: "서울" },
            { value: "gyeonggi", label: "경기" },
          ]}
        />
      </div>

      {query.isLoading ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-24 animate-pulse rounded-2xl border border-slate-200 bg-slate-50"
            />
          ))}
        </div>
      ) : null}

      {query.isError ? (
        <p className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          {(query.error as Error).message}
        </p>
      ) : null}

      {data?.warning ? (
        <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {data.warning}
        </p>
      ) : null}

      {data?.kpi ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <KpiCard
            label={`${data.kpi.windowLabel} 거래량`}
            value={`${data.kpi.tradeCount.toLocaleString("ko-KR")}건`}
            sub={`${data.kpi.prevWindowLabel} ${data.kpi.tradePrev.toLocaleString("ko-KR")}건`}
            change={data.kpi.tradeChangePct}
          />
          <KpiCard
            label={`${data.kpi.windowLabel} 신고가`}
            value={`${data.kpi.singogaCount.toLocaleString("ko-KR")}건`}
            sub={`${data.kpi.prevWindowLabel} ${data.kpi.singogaPrev.toLocaleString("ko-KR")}건`}
            change={data.kpi.singogaChangePct}
          />
          <KpiCard
            label={`${data.kpi.windowLabel} 하락거래`}
            value={`${data.kpi.dropCount.toLocaleString("ko-KR")}건`}
            sub={`${data.kpi.prevWindowLabel} ${data.kpi.dropPrev.toLocaleString("ko-KR")}건`}
            change={data.kpi.dropChangePct}
          />
          <KpiCard
            label={`${data.kpi.windowLabel} 중위가`}
            value={
              data.kpi.medianAmount != null
                ? formatEok(data.kpi.medianAmount)
                : "-"
            }
            sub={
              data.kpi.medianPpsqm != null
                ? `㎡당 ${Math.round(data.kpi.medianPpsqm).toLocaleString("ko-KR")}만`
                : "구성 변화에 주의"
            }
            change={
              data.kpi.medianAmount != null &&
              data.kpi.medianAmountPrev != null &&
              data.kpi.medianAmountPrev > 0
                ? Math.round(
                    ((data.kpi.medianAmount - data.kpi.medianAmountPrev) /
                      data.kpi.medianAmountPrev) *
                      1000,
                  ) / 10
                : null
            }
          />
        </div>
      ) : null}

      {data && chartData.length > 0 ? (
        <>
          <ChartCard
            title="거래량 추이"
            hint="선택 기간의 매매 거래 건수 흐름"
          >
            <div className="h-56 w-full sm:h-64">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  data={chartData}
                  margin={{ top: 8, right: 12, left: 0, bottom: 4 }}
                >
                  <defs>
                    <linearGradient id="volFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#0d9488" stopOpacity={0.25} />
                      <stop offset="100%" stopColor="#0d9488" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="#e2e8f0"
                    vertical={false}
                  />
                  <StatsXAxis interval={axisInterval} />
                  <YAxis
                    tick={{ fill: "#64748b", fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                    width={40}
                    tickFormatter={(v: number) => `${v}`}
                  />
                  <Tooltip
                    contentStyle={{
                      borderRadius: 12,
                      borderColor: "#e2e8f0",
                      fontSize: 12,
                    }}
                    formatter={(value: number) => [
                      `${value.toLocaleString("ko-KR")}건`,
                      "거래량",
                    ]}
                  />
                  <Area
                    type="monotone"
                    dataKey="tradeCount"
                    stroke="#0f766e"
                    fill="url(#volFill)"
                    strokeWidth={2}
                    name="거래량"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </ChartCard>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <ChartCard
              title="중위 거래가격"
              hint="거래 구성(지역·면적) 변화에 영향을 받습니다. 시장 전체 시세 대용으로만 참고하세요."
            >
              <div className="h-56 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChartSafe data={chartData} interval={axisInterval} />
                </ResponsiveContainer>
              </div>
            </ChartCard>

            <ChartCard
              title="신고가 vs 하락거래"
              hint="홈과 동일한 단지·면적 기준"
            >
              <div className="h-56 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart
                    data={chartData}
                    margin={{ top: 8, right: 12, left: 0, bottom: 4 }}
                  >
                    <CartesianGrid
                      strokeDasharray="3 3"
                      stroke="#e2e8f0"
                      vertical={false}
                    />
                    <StatsXAxis interval={axisInterval} />
                    <YAxis
                      tick={{ fill: "#64748b", fontSize: 11 }}
                      axisLine={false}
                      tickLine={false}
                      width={36}
                    />
                    <Tooltip
                      contentStyle={{
                        borderRadius: 12,
                        borderColor: "#e2e8f0",
                        fontSize: 12,
                      }}
                    />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Bar
                      dataKey="singogaCount"
                      name="신고가"
                      fill="#0d9488"
                      radius={[4, 4, 0, 0]}
                    />
                    <Bar
                      dataKey="dropCount"
                      name="하락"
                      fill="#e11d48"
                      radius={[4, 4, 0, 0]}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </ChartCard>
          </div>

          <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
            <TrendingUp className="h-4 w-4 text-teal-700" />
            지역별 시장
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <RankList
              title="거래량 TOP 지역"
              items={data.rankings.volumeTop}
              mode="volume"
            />
            <RankList
              title="거래 증가 지역"
              items={data.rankings.growthTop}
              mode="growth"
            />
            <RankList
              title="신고가 많은 지역"
              items={data.rankings.singogaTop}
              mode="singoga"
            />
            <RankList
              title="하락거래 많은 지역"
              items={data.rankings.dropTop}
              mode="drop"
            />
          </div>
        </>
      ) : null}

      {!query.isLoading && data && chartData.length === 0 && !data.warning ? (
        <p className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-12 text-center text-sm text-slate-500">
          표시할 통계가 없습니다.
        </p>
      ) : null}

      <div className="flex flex-wrap gap-3 text-sm">
        <Link
          href="/"
          className="inline-flex items-center gap-1 font-medium text-teal-700 hover:underline"
        >
          오늘의 시장
          <ArrowRight className="h-3.5 w-3.5" />
        </Link>
        <Link
          href="/regions"
          className="inline-flex items-center gap-1 font-medium text-slate-600 hover:underline"
        >
          지역별 조회
          <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>
    </div>
  );
}

function LineChartSafe({
  data,
  interval,
}: {
  data: Array<{ label: string; medianEok: number | null }>;
  interval: number;
}) {
  return (
    <ComposedChart
      data={data}
      margin={{ top: 8, right: 12, left: 0, bottom: 4 }}
    >
      <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
      <StatsXAxis interval={interval} />
      <YAxis
        tick={{ fill: "#64748b", fontSize: 11 }}
        axisLine={false}
        tickLine={false}
        width={42}
        tickFormatter={(v: number) => `${v}억`}
      />
      <Tooltip
        contentStyle={{
          borderRadius: 12,
          borderColor: "#e2e8f0",
          fontSize: 12,
        }}
        formatter={(value: number) => [`${value}억`, "중위가"]}
      />
      <Line
        type="monotone"
        dataKey="medianEok"
        stroke="#334155"
        strokeWidth={2}
        dot={false}
        connectNulls
        name="중위가"
      />
    </ComposedChart>
  );
}

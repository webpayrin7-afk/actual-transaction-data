"use client";

import Link from "next/link";
import { useMemo, useState, useEffect, useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
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
import { useLoadProgressWhen } from "@/components/layout/LoadProgress";
import type { MarketStatsResponse, StatsRegionRank } from "@/lib/market/stats";
import type { StatsPeriod, StatsScope } from "@/lib/market/keys";
import { formatDealDate, formatEok } from "@/lib/utils/format";
import {
  StatsDealExplorer,
  type DealExplorerTab,
} from "@/components/stats/StatsDealExplorer";
import { StatsRegionSelect } from "@/components/stats/StatsRegionSelect";
import { PAGE_SHELL, PageHeader } from "@/components/layout/PageHeader";
import { LabKpiCard } from "@/components/lab/LabKpiCard";
import { isStatsScope } from "@/lib/market/region-scope";

async function fetchStats(
  period: StatsPeriod,
  scope: StatsScope,
  date: string | null,
): Promise<MarketStatsResponse> {
  const params = new URLSearchParams();
  params.set("period", period);
  params.set("scope", scope);
  if (date) params.set("date", date);
  const res = await fetch(`/api/market-stats?${params.toString()}`);
  if (!res.ok) throw new Error("시장동향 데이터를 불러오지 못했습니다.");
  return res.json();
}

function parsePeriod(v: string | null): StatsPeriod {
  if (v === "daily" || v === "weekly" || v === "monthly") return v;
  return "weekly";
}

function parseScope(v: string | null): StatsScope {
  if (isStatsScope(v)) return v;
  return "all";
}

/** Compact segmented control for market filters */
function Segmented<T extends string>({
  value,
  onChange,
  options,
  fullWidth = false,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  fullWidth?: boolean;
}) {
  return (
    <div
      className={`gap-0.5 rounded-lg border border-slate-200 bg-white p-0.5 ${
        fullWidth
          ? "flex w-full lg:inline-flex lg:w-auto"
          : "inline-flex"
      }`}
    >
      {options.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={`lab-tab min-h-8 min-w-0 px-2.5 py-1 text-center text-xs sm:px-3 sm:text-[13px] ${
              fullWidth ? "flex-1 lg:flex-none" : ""
            } ${active ? "lab-tab-active" : ""}`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function ChangeText({
  pct,
  compareLabel,
}: {
  pct: number | null;
  compareLabel?: string;
}) {
  if (pct == null)
    return (
      <span className="text-slate-400">
        {compareLabel ? `${compareLabel} 없음` : "대비 없음"}
      </span>
    );
  const up = pct > 0;
  const down = pct < 0;
  return (
    <span
      className={`inline-flex flex-wrap items-center gap-x-1 gap-y-0.5 tabular-nums ${
        up ? "text-rose-600" : down ? "text-blue-600" : "text-slate-500"
      }`}
    >
      <span className="inline-flex items-center gap-0.5">
        {up ? (
          <ArrowUpRight className="h-3.5 w-3.5" />
        ) : down ? (
          <ArrowDownRight className="h-3.5 w-3.5" />
        ) : null}
        {pct > 0 ? "+" : ""}
        {pct}%
      </span>
      {compareLabel ? (
        <span className="font-normal text-slate-400">{compareLabel}</span>
      ) : null}
    </span>
  );
}

function KpiCard({
  label,
  value,
  sub,
  change,
  compareLabel,
  share,
}: {
  label: string;
  value: string;
  sub?: string;
  change: number | null;
  compareLabel?: string;
  share?: string | null;
}) {
  return (
    <LabKpiCard
      label={label}
      value={value}
      hint={share}
      footer={
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500">
          <ChangeText pct={change} compareLabel={compareLabel} />
          {sub ? <span>{sub}</span> : null}
        </div>
      }
    />
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
    <div>
      <div className="sr-only">{title}</div>
      {items.length === 0 ? (
        <p className="px-1 py-10 text-center text-sm text-slate-500">
          표시할 지역이 없습니다.
        </p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {items.map((item, idx) => (
            <li key={item.lawdCd}>
              <Link
                href={item.href}
                className="flex items-center justify-between gap-3 px-1 py-3 transition hover:bg-slate-50 sm:px-2"
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
                      <p className="text-sm font-semibold tabular-nums text-rose-700">
                        신고가 {item.singogaCount.toLocaleString("ko-KR")}
                      </p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        비중 {item.singogaSharePct ?? "-"}% · 거래{" "}
                        {item.tradeCount}
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="text-sm font-semibold tabular-nums text-blue-700">
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
    </div>
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
    <section className="lab-card p-4 sm:p-5">
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

function chartXAxisProps(interval: number) {
  return {
    type: "category" as const,
    dataKey: "label",
    interval,
    tick: { fill: "#475569", fontSize: 11 },
    axisLine: { stroke: "#cbd5e1" },
    tickLine: false as const,
    // "05.11"처럼 숫자로 보이는 문자열이 number scale로 깨지지 않게 함
    allowDuplicatedCategory: false,
  };
}

export function MarketStatsPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [period, setPeriod] = useState<StatsPeriod>(() =>
    parsePeriod(searchParams.get("period")),
  );
  const [scope, setScope] = useState<StatsScope>(() =>
    parseScope(searchParams.get("scope")),
  );
  const [date, setDate] = useState<string | null>(() =>
    searchParams.get("date"),
  );
  const [dealTab, setDealTab] = useState<DealExplorerTab>("notables");
  const [regionTab, setRegionTab] = useState<
    "volume" | "growth" | "singoga" | "drop"
  >("volume");

  const syncUrl = useCallback(
    (nextPeriod: StatsPeriod, nextScope: StatsScope, nextDate: string | null) => {
      const params = new URLSearchParams();
      params.set("period", nextPeriod);
      params.set("scope", nextScope);
      if (nextDate) params.set("date", nextDate);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [pathname, router],
  );

  useEffect(() => {
    syncUrl(period, scope, date);
  }, [period, scope, date, syncUrl]);

  const query = useQuery({
    queryKey: ["market-stats", period, scope, date],
    queryFn: () => fetchStats(period, scope, date),
    staleTime: 60_000,
  });

  const data = query.data;
  useLoadProgressWhen(query.isLoading && !data, "시장동향 불러오는 중…");

  // API가 정규화한 anchor를 URL/state에 반영 (effect setState 회피)
  if (data?.selectedDate && data.selectedDate !== date) {
    setDate(data.selectedDate);
  }

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
    <div className={PAGE_SHELL}>
      <PageHeader
        title="아파트 시장동향"
        description="실제 계약일 기준으로 거래량·신고가·하락거래와 주요 거래를 확인하세요."
      />

      {/* Market control bar — period / date / region filter */}
      <div className="flex flex-col gap-2 rounded-xl border border-slate-200 bg-slate-50/70 p-2 sm:gap-2.5 lg:flex-row lg:items-center lg:justify-between lg:gap-3 lg:px-2.5 lg:py-1.5">
        <Segmented
          value={period}
          onChange={setPeriod}
          fullWidth
          options={[
            { value: "daily", label: "일간" },
            { value: "weekly", label: "주간" },
            { value: "monthly", label: "월간" },
          ]}
        />

        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 sm:justify-center lg:justify-end">
          <div className="inline-flex min-w-0 items-center gap-0.5 rounded-lg border border-slate-200 bg-white px-0.5 py-0.5">
            <button
              type="button"
              disabled={!data?.kpi?.canGoPrev}
              onClick={() => data?.kpi && setDate(data.kpi.prevAnchor)}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-base text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-35"
              aria-label="이전 기간"
            >
              ‹
            </button>
            <p className="min-w-0 truncate px-1.5 text-center text-xs font-semibold tabular-nums text-slate-900 sm:min-w-[11rem] sm:px-2 sm:text-[13px]">
              {data?.kpi?.windowLabel ?? "—"}
            </p>
            <button
              type="button"
              disabled={!data?.kpi?.canGoNext}
              onClick={() => data?.kpi && setDate(data.kpi.nextAnchor)}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-base text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-35"
              aria-label="다음 기간"
            >
              ›
            </button>
          </div>

          {/* 시·도 filter — 추후 시·군·구 filter를 옆에 추가 가능 */}
          <div className="flex shrink-0 items-center gap-1.5">
            <StatsRegionSelect value={scope} onChange={setScope} />
          </div>
        </div>
      </div>

      {(data?.asOfDate || data?.dateBasisNote) && (
        <div className="-mt-3 space-y-0.5 text-xs text-slate-500">
          {data?.asOfDate ? (
            <p>
              데이터 기준(최신 계약일) {formatDealDate(data.asOfDate)}
              {data.kpi
                ? ` · 선택 ${data.kpi.windowLabel} (${formatDealDate(data.kpi.windowFrom)} ~ ${formatDealDate(data.kpi.windowTo)})`
                : null}
            </p>
          ) : null}
          {data?.dateBasisNote ? (
            <p className="text-[11px] text-slate-400">{data.dateBasisNote}</p>
          ) : null}
        </div>
      )}

      {query.isLoading ? (
        <div className="lab-skeleton" />
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
            label="거래량"
            value={`${data.kpi.tradeCount.toLocaleString("ko-KR")}건`}
            sub={`${data.kpi.prevWindowLabel} ${data.kpi.tradePrev.toLocaleString("ko-KR")}건`}
            change={data.kpi.reportingLagRisk ? null : data.kpi.tradeChangePct}
            compareLabel={
              data.kpi.reportingLagRisk
                ? "신고 지연 가능 · 단순 증감 비표시"
                : data.kpi.compareLabel
            }
          />
          <KpiCard
            label="신고가"
            value={`${data.kpi.singogaCount.toLocaleString("ko-KR")}건`}
            share={
              data.kpi.singogaSharePct != null
                ? `전체 거래의 ${data.kpi.singogaSharePct}%`
                : null
            }
            sub={`${data.kpi.prevWindowLabel} ${data.kpi.singogaPrev.toLocaleString("ko-KR")}건`}
            change={data.kpi.singogaChangePct}
            compareLabel={data.kpi.compareLabel}
          />
          <KpiCard
            label="하락거래"
            value={`${data.kpi.dropCount.toLocaleString("ko-KR")}건`}
            share={
              data.kpi.dropSharePct != null
                ? `전체 거래의 ${data.kpi.dropSharePct}%`
                : null
            }
            sub={`${data.kpi.prevWindowLabel} ${data.kpi.dropPrev.toLocaleString("ko-KR")}건`}
            change={data.kpi.dropChangePct}
            compareLabel={data.kpi.compareLabel}
          />
          <KpiCard
            label="중위가"
            value={
              data.kpi.medianAmount != null
                ? formatEok(data.kpi.medianAmount)
                : "-"
            }
            sub={
              data.kpi.medianIsApprox
                ? "일별 중위의 중위(근사) · 구성 변화 주의"
                : data.kpi.medianPpsqm != null
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
            compareLabel={data.kpi.compareLabel}
          />
        </div>
      ) : null}

      {data && chartData.length > 0 ? (
        <>
          <ChartCard
            title="거래량 추이"
            hint={
              data.kpi
                ? `선택 기간 KPI와 별도 · 추세 ${formatDealDate(data.kpi.chartFrom)} ~ ${formatDealDate(data.kpi.chartTo)}`
                : "선택 기간까지의 추세"
            }
          >
            <div className="h-60 w-full pb-1 sm:h-72">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  data={chartData}
                  margin={{ top: 8, right: 8, left: 0, bottom: 8 }}
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
                  <XAxis {...chartXAxisProps(axisInterval)} />
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
                    <XAxis {...chartXAxisProps(axisInterval)} />
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
                      fill="#e11d48"
                      radius={[4, 4, 0, 0]}
                    />
                    <Bar
                      dataKey="dropCount"
                      name="하락"
                      fill="#2563eb"
                      radius={[4, 4, 0, 0]}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </ChartCard>
          </div>

          {data.feeds ? (
            <StatsDealExplorer
              tab={dealTab}
              onTabChange={setDealTab}
              notables={data.feeds.notables}
              singoga={data.feeds.singoga}
              drops={data.feeds.drops}
              activeComplexes={data.feeds.activeComplexes}
              windowLabel={data.feeds.windowLabel}
              prevWindowLabel={data.feeds.prevWindowLabel}
              windowFrom={data.feeds.windowFrom}
              windowTo={data.feeds.windowTo}
            />
          ) : null}

          <section className="lab-card p-4 sm:p-5">
            <div className="mb-3 flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-rose-600" />
              <div>
                <h2 className="text-sm font-semibold text-slate-900 sm:text-base">
                  지역별 시장
                </h2>
                <p className="mt-0.5 text-xs text-slate-500">
                  선택 기간 기준 지역 순위
                </p>
              </div>
            </div>
            <div className="mb-3 flex w-full gap-1 overflow-x-auto rounded-xl border border-slate-200 bg-slate-50 p-1">
              {(
                [
                  { id: "volume", label: "거래량" },
                  { id: "growth", label: "증가" },
                  { id: "singoga", label: "신고가" },
                  { id: "drop", label: "하락" },
                ] as const
              ).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setRegionTab(t.id)}
                  className={`min-w-0 flex-1 rounded-lg px-2 py-1.5 text-center text-xs font-medium transition sm:text-sm ${
                    regionTab === t.id
                      ? "bg-white text-slate-900 shadow-sm"
                      : "text-slate-600 hover:text-slate-900"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <RankList
              title={
                regionTab === "volume"
                  ? "거래량 TOP 지역"
                  : regionTab === "growth"
                    ? "거래 증가 지역"
                    : regionTab === "singoga"
                      ? "신고가 많은 지역"
                      : "하락거래 많은 지역"
              }
              items={
                regionTab === "volume"
                  ? data.rankings.volumeTop
                  : regionTab === "growth"
                    ? data.rankings.growthTop
                    : regionTab === "singoga"
                      ? data.rankings.singogaTop
                      : data.rankings.dropTop
              }
              mode={regionTab}
            />
          </section>
        </>
      ) : null}

      {!query.isLoading && data && chartData.length === 0 && !data.warning ? (
        <p className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-12 text-center text-sm text-slate-500">
          표시할 시장동향이 없습니다.
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
          지역 조회
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
      <XAxis {...chartXAxisProps(interval)} />
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

"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  Activity,
  MapPinned,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { AptQuickSearch } from "@/components/home/AptQuickSearch";
import type {
  MarketDealItem,
  MarketHomeResponse,
  MarketVolumeItem,
} from "@/lib/market/home";
import { formatArea, formatDealDate, formatEok } from "@/lib/utils/format";

async function fetchMarketHome(): Promise<MarketHomeResponse> {
  const res = await fetch("/api/market-home");
  if (!res.ok) throw new Error("시장 데이터를 불러오지 못했습니다.");
  return res.json();
}

function KpiCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  tone: "up" | "down" | "neutral" | "hot";
}) {
  const tones = {
    up: "border-teal-200 bg-teal-50/80 text-teal-900",
    down: "border-rose-200 bg-rose-50/80 text-rose-900",
    hot: "border-amber-200 bg-amber-50/80 text-amber-950",
    neutral: "border-slate-200 bg-white text-slate-900",
  } as const;

  return (
    <div className={`rounded-2xl border px-4 py-3.5 ${tones[tone]}`}>
      <p className="text-xs font-medium opacity-80">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">
        {value}
      </p>
      <p className="mt-1 text-[11px] leading-4 opacity-70">{hint}</p>
    </div>
  );
}

function DealRow({ item }: { item: MarketDealItem }) {
  const up = (item.changePct ?? 0) > 0;
  const down = (item.changePct ?? 0) < 0;

  return (
    <Link
      href={item.href}
      className="flex items-start justify-between gap-3 border-b border-slate-100 px-1 py-3.5 last:border-0 hover:bg-slate-50/80 sm:px-2"
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="truncate text-sm font-semibold text-slate-900">
            {item.aptName}
          </span>
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">
            {item.kindLabel}
          </span>
        </div>
        <p className="mt-0.5 text-xs text-slate-500">
          {item.gu} {item.dong} · {formatArea(item.exclusiveArea)} ·{" "}
          {formatDealDate(item.dealDate)}
        </p>
        {item.priorMaxAmount != null ? (
          <p className="mt-1 text-[11px] text-slate-500">
            이전 최고 {formatEok(item.priorMaxAmount)}
            {item.changeAmount != null
              ? ` · ${item.changeAmount >= 0 ? "+" : ""}${formatEok(Math.abs(item.changeAmount))}`
              : ""}
          </p>
        ) : null}
      </div>
      <div className="shrink-0 text-right">
        <p className="text-base font-semibold tabular-nums text-slate-900">
          {formatEok(item.dealAmount)}
        </p>
        {item.changePct != null ? (
          <p
            className={`mt-0.5 inline-flex items-center gap-0.5 text-xs font-semibold tabular-nums ${
              up ? "text-teal-700" : down ? "text-rose-600" : "text-slate-500"
            }`}
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

function VolumeRow({ item }: { item: MarketVolumeItem }) {
  return (
    <Link
      href={item.href}
      className="flex items-start justify-between gap-3 border-b border-slate-100 px-1 py-3.5 last:border-0 hover:bg-slate-50/80 sm:px-2"
    >
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-slate-900">
          {item.aptName}
        </p>
        <p className="mt-0.5 text-xs text-slate-500">
          {item.gu} {item.dong}
        </p>
        <p className="mt-1 text-[11px] text-slate-500">
          최근 30일 {item.recentCount}건 · 직전 30일 {item.priorCount}건
        </p>
      </div>
      <div className="shrink-0 text-right">
        <p className="text-sm font-semibold text-teal-700">
          +{item.increaseCount}건
        </p>
        {item.growthPct != null ? (
          <p className="mt-0.5 text-xs tabular-nums text-slate-500">
            +{item.growthPct}%
          </p>
        ) : null}
      </div>
    </Link>
  );
}

function Section({
  title,
  icon,
  children,
  empty,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  empty?: boolean;
}) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white">
      <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3 sm:px-5">
        {icon}
        <h2 className="text-sm font-semibold text-slate-900 sm:text-base">
          {title}
        </h2>
      </div>
      <div className="px-3 py-1 sm:px-4">
        {empty ? (
          <p className="px-1 py-10 text-center text-sm text-slate-500">
            해당 조건의 최근 거래가 없습니다.
          </p>
        ) : (
          children
        )}
      </div>
    </section>
  );
}

export function MarketHome() {
  const query = useQuery({
    queryKey: ["market-home"],
    queryFn: fetchMarketHome,
    staleTime: 5 * 60 * 1000,
  });

  const data = query.data;

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
      <section className="relative overflow-hidden rounded-3xl border border-slate-200 bg-gradient-to-br from-slate-50 via-white to-teal-50/60 px-5 py-7 sm:px-8 sm:py-9">
        <div
          className="pointer-events-none absolute inset-0 opacity-40"
          style={{
            backgroundImage:
              "radial-gradient(circle at 90% 10%, rgba(13,148,136,0.12), transparent 40%)",
          }}
        />
        <div className="relative max-w-2xl">
          <p className="text-xs font-medium tracking-wide text-teal-700">
            아파트 데이터랩
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">
            오늘의 아파트 시장
          </h1>
          <p className="mt-2 text-sm leading-6 text-slate-600 sm:text-base">
            오늘의 아파트 실거래와 신고가, 하락거래, 거래량 변화를 한눈에
            확인하세요.
          </p>
          {data?.asOfDate ? (
            <p className="mt-3 text-xs text-slate-500">
              최근 계약일 기준 {formatDealDate(data.recentFrom ?? "")} ~{" "}
              {formatDealDate(data.recentTo ?? "")} · {data.dateBasisNote}
            </p>
          ) : null}
        </div>
      </section>

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

      {data ? (
        <>
          {data.warning ? (
            <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              {data.warning}
            </p>
          ) : null}

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <KpiCard
              label="신고가 거래"
              value={`${data.kpis.singogaCount}건`}
              hint="타입면적 기준 최고가 갱신"
              tone="up"
            />
            <KpiCard
              label="큰 폭 하락"
              value={`${data.kpis.dropCount}건`}
              hint="최고가 대비 −10% 이상"
              tone="down"
            />
            <KpiCard
              label="거래량 급증"
              value={`${data.kpis.volumeSurgeCount}곳`}
              hint="최근 30일 vs 직전 30일"
              tone="hot"
            />
            <KpiCard
              label="주요 거래"
              value={`${data.kpis.notableCount}건`}
              hint="신고가·하락·고가 등"
              tone="neutral"
            />
          </div>
        </>
      ) : null}

      <section className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
        <div className="mb-3 flex items-end justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">빠른 단지 검색</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              시장을 보다가 관심 단지로 바로 이동하세요.
            </p>
          </div>
          <Link
            href="/complexes"
            className="shrink-0 text-xs font-medium text-teal-700 hover:underline"
          >
            단지별 조회
          </Link>
        </div>
        <AptQuickSearch compact inputId="market-home-search" />
      </section>

      {data ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Section
            title="오늘의 신고가"
            icon={<TrendingUp className="h-4 w-4 text-teal-700" />}
            empty={data.singoga.length === 0}
          >
            {data.singoga.map((item) => (
              <DealRow key={item.id} item={item} />
            ))}
          </Section>

          <Section
            title="큰 폭 하락 거래"
            icon={<TrendingDown className="h-4 w-4 text-rose-600" />}
            empty={data.drops.length === 0}
          >
            {data.drops.map((item) => (
              <DealRow key={item.id} item={item} />
            ))}
          </Section>

          <Section
            title="거래량 급증 단지"
            icon={<Activity className="h-4 w-4 text-amber-700" />}
            empty={data.volumeSurges.length === 0}
          >
            {data.volumeSurges.map((item) => (
              <VolumeRow
                key={`${item.aptName}-${item.gu}`}
                item={item}
              />
            ))}
          </Section>

          <Section
            title="주요 거래"
            icon={<ArrowUpRight className="h-4 w-4 text-slate-700" />}
            empty={data.notables.length === 0}
          >
            {data.notables.map((item) => (
              <DealRow key={`n-${item.id}`} item={item} />
            ))}
          </Section>
        </div>
      ) : null}

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Link
          href="/regions#seoul"
          className="inline-flex items-center justify-between gap-3 rounded-2xl bg-gradient-to-r from-teal-600 to-teal-500 px-5 py-4 text-white shadow-sm transition hover:from-teal-700 hover:to-teal-600"
        >
          <span className="inline-flex items-center gap-2 text-sm font-semibold">
            <MapPinned className="h-4 w-4" />
            서울 지역별 조회
          </span>
          <ArrowRight className="h-4 w-4" />
        </Link>
        <Link
          href="/regions#gyeonggi"
          className="inline-flex items-center justify-between gap-3 rounded-2xl bg-gradient-to-r from-slate-800 to-slate-700 px-5 py-4 text-white shadow-sm transition hover:from-slate-900 hover:to-slate-800"
        >
          <span className="inline-flex items-center gap-2 text-sm font-semibold">
            <MapPinned className="h-4 w-4" />
            경기 지역별 조회
          </span>
          <ArrowRight className="h-4 w-4" />
        </Link>
      </section>

      <footer className="border-t border-slate-200 pt-4 pb-8 text-center text-xs text-slate-400">
        국토교통부 아파트 실거래 기반 · 아파트 데이터랩
      </footer>
    </div>
  );
}

"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  Activity,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { AptQuickSearch } from "@/components/home/AptQuickSearch";
import { UNIFIED_SEARCH_PLACEHOLDER } from "@/lib/nav/site-menu";
import { LabSection } from "@/components/lab/LabSection";
import { LabKpiCard } from "@/components/lab/LabKpiCard";
import { useLoadProgressWhen } from "@/components/layout/LoadProgress";
import { PAGE_SHELL, PageHeader } from "@/components/layout/PageHeader";
import { InfoChip } from "@/components/ui/InfoChip";
import {
  CONTRACT_DATE_BASIS_HELP,
  SEEN_DATE_BASIS_HELP,
} from "@/lib/region/market-insight";
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
  // 신고가/상승 = 빨강, 하락 = 파랑 (한국 시세 관례)
  const tones = {
    up: "text-rose-700",
    down: "text-blue-700",
    hot: "text-amber-800",
    neutral: "text-slate-900",
  } as const;

  return <LabKpiCard label={label} value={value} hint={hint} valueClassName={tones[tone]} />;
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
        <p className="truncate text-sm font-semibold text-slate-900">
          {item.aptName}
        </p>
        <p className="mt-0.5 text-xs text-slate-500">
          계약일 {formatDealDate(item.dealDate)} · {item.gu} {item.dong} ·{" "}
          {formatArea(item.exclusiveArea)}
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
              up ? "text-rose-600" : down ? "text-blue-600" : "text-slate-500"
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
        <p className="text-sm font-semibold text-rose-600">
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
    <section className="lab-card overflow-hidden">
      <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3 sm:px-5">
        {icon}
        <h2 className="text-sm font-semibold text-slate-900 sm:text-base">
          {title}
        </h2>
      </div>
      <div className="px-3 py-1 sm:px-4">
        {empty ? (
          <p className="px-1 py-10 text-center text-sm text-slate-500">
            해당 조건의 항목이 없습니다.
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
  useLoadProgressWhen(query.isLoading && !data, "시장 불러오는 중…");

  return (
    <div className={PAGE_SHELL}>
      <PageHeader
        title="오늘의 아파트 시장"
        description="한눈에 확인하세요."
        className="mt-1.5 sm:mt-2"
        meta={
          data?.lastUpdatedLabel || data?.computedAt || data?.discoveryDate ? (
            <div className="flex flex-wrap items-center gap-1.5">
              {data?.lastUpdatedLabel || data?.computedAt ? (
                <InfoChip
                  label={`최종 업데이트 ${data.lastUpdatedLabel ?? data.computedAt}`}
                >
                  집랩 데이터가 마지막으로 갱신된 시점입니다. 각 거래 카드의
                  날짜와 시장동향은 계약일 기준입니다. {CONTRACT_DATE_BASIS_HELP}
                </InfoChip>
              ) : null}
              {data?.discoveryDate ? (
                <InfoChip label={`확인일 ${data.discoveryDate}`}>
                  {SEEN_DATE_BASIS_HELP} 공식 신고일이나 공개일을 뜻하지
                  않습니다.
                </InfoChip>
              ) : null}
            </div>
          ) : null
        }
      />

      {query.isLoading ? (
        <div className="lab-skeleton" />
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
              label="오늘 새로 확인"
              value={`${data.kpis.newDealCount ?? 0}건`}
              hint="집랩이 처음 확인한 기준"
              tone="neutral"
            />
            <KpiCard
              label="신규 신고가"
              value={`${data.kpis.singogaCount}건`}
              hint="계약일 이전 최고가 갱신"
              tone="up"
            />
            <KpiCard
              label="신규 하락거래"
              value={`${data.kpis.dropCount}건`}
              hint="최고가 대비 −10% 이상"
              tone="down"
            />
            <KpiCard
              label="거래량 급증"
              value={`${data.kpis.volumeSurgeCount ?? 0}곳`}
              hint="최근 30일 vs 직전 30일"
              tone="hot"
            />
          </div>

          <div className="flex justify-end">
            <Link
              href="/stats"
              className="inline-flex items-center gap-1 text-sm font-medium text-teal-700 hover:underline"
            >
              시장동향 자세히 보기
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </>
      ) : null}

      <section className="lab-card p-4 sm:p-5">
        <h2 className="mb-3 text-sm font-semibold text-slate-900">빠른 검색</h2>
        <AptQuickSearch
          compact
          inputId="market-home-search"
          placeholder={UNIFIED_SEARCH_PLACEHOLDER}
          showPrice={false}
          includeRegions
        />
      </section>

      {data ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Section
            title="신규 신고가"
            icon={<TrendingUp className="h-4 w-4 text-rose-600" />}
            empty={data.singoga.length === 0}
          >
            {data.singoga.map((item) => (
              <DealRow key={item.id} item={item} />
            ))}
          </Section>

          <Section
            title="신규 하락거래"
            icon={<TrendingDown className="h-4 w-4 text-blue-600" />}
            empty={data.drops.length === 0}
          >
            {data.drops.map((item) => (
              <DealRow key={item.id} item={item} />
            ))}
          </Section>

          <Section
            title="거래량 급증"
            icon={<Activity className="h-4 w-4 text-amber-700" />}
            empty={(data.volumeSurges ?? []).length === 0}
          >
            {(data.volumeSurges ?? []).map((item) => (
              <VolumeRow
                key={`${item.aptName}|${item.gu}|${item.dong}`}
                item={item}
              />
            ))}
          </Section>

          <Section
            title="새로 확인된 주요 거래"
            icon={<ArrowUpRight className="h-4 w-4 text-slate-700" />}
            empty={data.notables.length === 0}
          >
            {data.notables.map((item) => (
              <DealRow key={`n-${item.id}`} item={item} />
            ))}
          </Section>
        </div>
      ) : null}

      {/* 오늘의 시장 콘텐츠 아래 — 실험실은 두 번째 콘텐츠 영역 */}
      <LabSection />
    </div>
  );
}

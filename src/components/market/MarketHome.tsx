"use client";

import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { AptQuickSearch } from "@/components/home/AptQuickSearch";
import { UNIFIED_SEARCH_PLACEHOLDER } from "@/lib/nav/site-menu";
import { LabSection as LabExperiments } from "@/components/lab/LabSection";
import { useLoadProgressWhen } from "@/components/layout/LoadProgress";
import { PAGE_SHELL, PageHeader } from "@/components/layout/PageHeader";
import { JipLabLogo } from "@/components/brand/JipLabLogo";
import { HomeNavigation } from "@/components/home/HomeNavigation";
import { InfoTip } from "@/components/ui/InfoTip";
import { LabSection } from "@/components/ui/LabSection";
import { LAB_LIST, LabListRow, LabTextLink } from "@/components/ui/LabListRow";
import { LAB_LIST_PREVIEW, LabMoreButton } from "@/components/ui/LabMoreButton";
import { LabStatTiles } from "@/components/ui/LabStatTiles";
import { LabTag } from "@/components/ui/LabTag";
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

function ChangePct({ pct }: { pct: number }) {
  const color =
    pct > 0 ? "var(--lab-change-up)" : pct < 0 ? "var(--lab-change-down)" : undefined;
  return (
    <span className="inline-flex items-center gap-0.5 font-semibold" style={{ color }}>
      {pct > 0 ? (
        <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
      ) : pct < 0 ? (
        <ArrowDownRight className="h-3.5 w-3.5" aria-hidden />
      ) : null}
      {pct > 0 ? "+" : ""}
      {pct}%
    </span>
  );
}

function DealRow({ item }: { item: MarketDealItem }) {
  return (
    <LabListRow
      href={item.href}
      title={item.aptName}
      meta={
        <>
          <span className="block truncate">
            계약일 {formatDealDate(item.dealDate)} · {item.gu} {item.dong} ·{" "}
            {formatArea(item.exclusiveArea)}
          </span>
          {item.priorMaxAmount != null ? (
            <span className="block truncate">
              이전 최고 {formatEok(item.priorMaxAmount)}
              {item.changeAmount != null
                ? ` · ${item.changeAmount >= 0 ? "+" : ""}${formatEok(Math.abs(item.changeAmount))}`
                : ""}
            </span>
          ) : null}
        </>
      }
      value={formatEok(item.dealAmount)}
      sub={item.changePct != null ? <ChangePct pct={item.changePct} /> : null}
    />
  );
}

function VolumeRow({ item }: { item: MarketVolumeItem }) {
  return (
    <LabListRow
      href={item.href}
      title={item.aptName}
      meta={
        <>
          <span className="block truncate">
            {item.gu} {item.dong}
          </span>
          <span className="block truncate">
            최근 30일 {item.recentCount}건 · 직전 30일 {item.priorCount}건
          </span>
        </>
      }
      value={`+${item.increaseCount}건`}
      valueTone="up"
      sub={item.growthPct != null ? `+${item.growthPct}%` : null}
    />
  );
}

function ListSection<T>({
  title,
  items,
  renderItem,
  getKey,
}: {
  title: string;
  items: T[];
  renderItem: (item: T) => React.ReactNode;
  getKey: (item: T) => string;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? items : items.slice(0, LAB_LIST_PREVIEW);
  const rest = items.length - LAB_LIST_PREVIEW;
  return (
    <LabSection title={title}>
      {items.length === 0 ? (
        <p className="lab-state">해당 조건의 항목이 없습니다.</p>
      ) : (
        <>
          <ul className={LAB_LIST}>
            {visible.map((item) => (
              <Fragment key={getKey(item)}>{renderItem(item)}</Fragment>
            ))}
          </ul>
          {rest > 0 ? (
            <LabMoreButton
              expanded={expanded}
              onToggle={() => setExpanded((v) => !v)}
              label={`${rest}건 더보기`}
            />
          ) : null}
        </>
      )}
    </LabSection>
  );
}

function MetaTag({ label, tip }: { label: string; tip: React.ReactNode }) {
  return (
    <span className="inline-flex items-center">
      <LabTag size="md">{label}</LabTag>
      <InfoTip aria-label={`${label} 안내`}>{tip}</InfoTip>
    </span>
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
    <>
    <div className={PAGE_SHELL}>
      {/* 모바일 홈 첫 화면: 로고 + 바로가기 카드 (헤더는 검색창만, 메뉴는 하단 독). */}
      <div className="-mt-1 flex flex-col gap-3 sm:hidden">
        <JipLabLogo priority />
        <HomeNavigation />
      </div>
      <PageHeader
        title="오늘의 아파트 시장"
        description="오늘 새로 확인된 시장 변화를 한눈에 확인하세요."
        className="mt-1.5 sm:mt-2"
        meta={
          data?.lastUpdatedLabel || data?.computedAt || data?.discoveryDate ? (
            <div className="flex flex-wrap items-center gap-x-1 gap-y-1">
              {data?.lastUpdatedLabel || data?.computedAt ? (
                <MetaTag
                  label={`최종 업데이트 ${data.lastUpdatedLabel ?? data.computedAt}`}
                  tip={
                    <>
                      집랩 데이터가 마지막으로 갱신된 시점입니다. 각 거래 카드의
                      날짜와 시장동향은 계약일 기준입니다. {CONTRACT_DATE_BASIS_HELP}
                    </>
                  }
                />
              ) : null}
              {data?.discoveryDate ? (
                <MetaTag
                  label={`확인일 ${data.discoveryDate}`}
                  tip={
                    <>
                      {SEEN_DATE_BASIS_HELP} 공식 신고일이나 공개일을 뜻하지
                      않습니다.
                    </>
                  }
                />
              ) : null}
            </div>
          ) : null
        }
      />

      {query.isLoading ? (
        <div className="lab-skeleton" />
      ) : null}

      {query.isError ? (
        <p className="lab-state lab-state-error">
          {(query.error as Error).message}
        </p>
      ) : null}

      {data ? (
        <>
          {data.warning ? (
            <p className="detail-body rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-[color:var(--lab-warning-text)]">
              {data.warning}
            </p>
          ) : null}

          <LabSection title="오늘의 요약">
            <LabStatTiles
              columns={4}
              items={[
                {
                  key: "new",
                  label: "오늘 새로 확인",
                  value: `${data.kpis.newDealCount ?? 0}건`,
                  sub: "집랩이 처음 확인한 기준",
                },
                {
                  key: "singoga",
                  label: "신규 신고가",
                  value: `${data.kpis.singogaCount}건`,
                  sub: "계약일 이전 최고가 갱신",
                  tone: "up",
                },
                {
                  key: "drop",
                  label: "신규 하락거래",
                  value: `${data.kpis.dropCount}건`,
                  sub: "최고가 대비 −10% 이상",
                  tone: "down",
                },
                {
                  key: "surge",
                  label: "거래량 급증",
                  value: `${data.kpis.volumeSurgeCount ?? 0}곳`,
                  sub: "최근 30일 vs 직전 30일",
                },
              ]}
            />
            <LabTextLink href="/stats">시장동향 자세히 보기</LabTextLink>
          </LabSection>
        </>
      ) : null}

      <LabSection title="빠른 검색">
        <AptQuickSearch
          compact
          inputId="market-home-search"
          placeholder={UNIFIED_SEARCH_PLACEHOLDER}
          showPrice={false}
          includeRegions
        />
      </LabSection>

      {data ? (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 lg:gap-8">
          <ListSection
            title="신규 신고가"
            items={data.singoga}
            getKey={(item) => item.id}
            renderItem={(item) => <DealRow item={item} />}
          />
          <ListSection
            title="신규 하락거래"
            items={data.drops}
            getKey={(item) => item.id}
            renderItem={(item) => <DealRow item={item} />}
          />
          <ListSection
            title="거래량 급증"
            items={data.volumeSurges ?? []}
            getKey={(item) => `${item.aptName}|${item.gu}|${item.dong}`}
            renderItem={(item) => <VolumeRow item={item} />}
          />
          <ListSection
            title="새로 확인된 주요 거래"
            items={data.notables}
            getKey={(item) => `n-${item.id}`}
            renderItem={(item) => <DealRow item={item} />}
          />
        </div>
      ) : null}

      {/* 오늘의 시장 콘텐츠 아래 — 실험실은 두 번째 콘텐츠 영역 */}
      <LabExperiments />
    </div>
    </>
  );
}

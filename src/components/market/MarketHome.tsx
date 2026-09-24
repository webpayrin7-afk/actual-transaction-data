"use client";

import Link from "next/link";
import { Fragment, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownRight, ArrowUpRight, ChevronRight } from "lucide-react";
import { LabSection as LabExperiments } from "@/components/lab/LabSection";
import { useLoadProgressWhen } from "@/components/layout/LoadProgress";
import { PAGE_SHELL_MENU as PAGE_SHELL, PageHeader } from "@/components/layout/PageHeader";
import { MarketPolicyNews } from "@/components/market/MarketPolicyNews";
import { MarketRegionBreakdown } from "@/components/market/MarketRegionBreakdown";
import { LAB_SECTION_SURFACE, LabSection } from "@/components/ui/LabSection";
import { MarketFlowSummary } from "@/components/market/MarketFlowSummary";
import { MarketHeadlines } from "@/components/market/MarketHeadlines";
import { LabSectionBoundary } from "@/components/ui/LabSectionBoundary";
import { LAB_LIST, LabListRow } from "@/components/ui/LabListRow";
import { LAB_LIST_PREVIEW, LabMoreButton } from "@/components/ui/LabMoreButton";
import { LabStickySectionNav } from "@/components/ui/LabStickySectionNav";
import { LabTabs, labTabPanelId } from "@/components/ui/LabTabs";
import { LabTag } from "@/components/ui/LabTag";
import { InfoTip } from "@/components/ui/InfoTip";
import {
  CONTRACT_DATE_BASIS_HELP,
  SEEN_DATE_BASIS_HELP,
} from "@/lib/region/market-insight";
import type {
  MarketDealItem,
  MarketHomeResponse,
  MarketVolumeItem,
} from "@/lib/market/home";
import type { MarketRecord, MarketRecordsResponse } from "@/lib/market/records";
import { formatArea, formatDealDate, formatEok } from "@/lib/utils/format";

async function fetchMarketHome(): Promise<MarketHomeResponse> {
  const res = await fetch("/api/market-home");
  if (!res.ok) throw new Error("시장 데이터를 불러오지 못했습니다.");
  return res.json();
}

/** 섹션 앵커 — 스티키 섹션 탭 (policy §12.3). 렌더되지 않은 섹션은 탭에서 빠진다. */
const MARKET_SECTIONS = [
  { id: "market-summary", label: "요약" },
  { id: "market-price-issues", label: "가격" },
  { id: "market-headlines", label: "뉴스" },
  { id: "market-policy", label: "정책" },
  { id: "market-regions", label: "지역" },
  { id: "market-volume", label: "거래량" },
  { id: "price-index", label: "흐름" },
  { id: "market-lab", label: "실험실" },
] as const;

const KIND_TAG: Record<MarketDealItem["kind"], string> = {
  singoga: "신고가",
  drop: "고점 −10%",
  high: "20억 이상",
  surge: "거래 급증",
};

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

function DealRow({ item, showKind = false }: { item: MarketDealItem; showKind?: boolean }) {
  return (
    <LabListRow
      href={item.href}
      wrap
      title={item.aptName}
      meta={
        <>
          <span className="block">
            {item.gu} {item.dong} · {formatArea(item.exclusiveArea)}
          </span>
          <span className="block tabular-nums">
            {item.priorMaxAmount != null ? `직전 ${formatEok(item.priorMaxAmount)} · ` : ""}
            {formatDealDate(item.dealDate)} 계약
          </span>
        </>
      }
      value={formatEok(item.dealAmount)}
      sub={item.changePct != null ? <ChangePct pct={item.changePct} /> : null}
    >
      {showKind ? (
        <span className="mt-1 flex">
          <LabTag>{KIND_TAG[item.kind] ?? item.kindLabel}</LabTag>
        </span>
      ) : null}
    </LabListRow>
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

/** 5개 + 더보기 (policy §12.4). `resetKey`가 바뀌면 펼침을 닫는다. */
function PreviewList<T>({
  items,
  render,
  getKey,
  emptyLabel,
  resetKey,
  moreUnit = "건",
}: {
  items: T[];
  render: (item: T) => React.ReactNode;
  getKey: (item: T) => string;
  emptyLabel: string;
  resetKey?: string;
  moreUnit?: string;
}) {
  const [state, setState] = useState({ key: resetKey, expanded: false });
  const expanded = state.key === resetKey ? state.expanded : false;
  if (items.length === 0) return <p className="lab-state">{emptyLabel}</p>;
  const visible = expanded ? items : items.slice(0, LAB_LIST_PREVIEW);
  const hidden = items.length - LAB_LIST_PREVIEW;
  return (
    <>
      <ul className={LAB_LIST}>
        {visible.map((item) => (
          <Fragment key={getKey(item)}>{render(item)}</Fragment>
        ))}
      </ul>
      {hidden > 0 ? (
        <LabMoreButton
          expanded={expanded}
          onToggle={() => setState({ key: resetKey, expanded: !expanded })}
          label={`${hidden}${moreUnit} 더보기`}
        />
      ) : null}
    </>
  );
}

type IssueTab = "records" | "singoga" | "drop";

async function fetchRecords(date: string): Promise<MarketRecordsResponse> {
  const res = await fetch(`/api/market/records?date=${encodeURIComponent(date)}`);
  if (!res.ok) throw new Error("오늘의 기록을 불러오지 못했습니다.");
  return res.json();
}

/** 오늘의 기록 한 줄 — 이유 태그가 먼저, 오른쪽은 가격(또는 건수) */
function RecordRow({ r }: { r: MarketRecord }) {
  const spec = [
    r.place,
    r.exclusiveArea ? `${Math.round(r.exclusiveArea * 10) / 10}㎡` : null,
    r.floor != null ? `${r.floor}층` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <LabListRow
      href={r.href}
      wrap
      title={r.aptName}
      meta={
        <>
          <span className="mb-0.5 block">
            <LabTag tone={r.tone ?? "brand"}>{r.reason}</LabTag>
          </span>
          <span className="block">{spec}</span>
          {r.detail ? (
            <span className="block tabular-nums">
              {r.detail}
              {r.dealDate && r.kind !== "top-price" ? ` · ${r.dealDate.slice(5).replace("-", ".")} 계약` : ""}
            </span>
          ) : null}
        </>
      }
      value={r.dealAmount != null ? formatEok(r.dealAmount) : r.sub}
      valueTone={r.tone ?? undefined}
      sub={r.dealAmount != null ? r.sub : null}
    />
  );
}

/** 오늘의 기록 — 날마다 다섯 가지 기록 (가장 비싼 · 가장 크게 오른 · 가장 오래된 고점 · 가장 많이 떨어진 · 거래 많은 단지) */
function TodayRecords({ date }: { date: string }) {
  const query = useQuery({
    queryKey: ["market-records", date],
    queryFn: () => fetchRecords(date),
    staleTime: 5 * 60 * 1000,
  });
  if (query.isLoading) return <div className="lab-skeleton" aria-label="오늘의 기록 불러오는 중" />;
  if (query.isError) return <p className="lab-state">오늘의 기록을 불러오지 못했습니다.</p>;
  const records = query.data?.records ?? [];
  if (records.length === 0) return <p className="lab-state">오늘 확인된 매매가 아직 없어 기록이 없습니다.</p>;
  return (
    <ul className={LAB_LIST}>
      {records.map((r) => (
        <RecordRow key={r.kind} r={r} />
      ))}
    </ul>
  );
}

/** 오늘의 가격 이슈 — 오늘의 기록 · 신고가 · 하락거래 (신고가·하락 전체는 전용 페이지). */
function PriceIssuesSection({ id, data }: { id: string; data: MarketHomeResponse }) {
  const tabs: { id: IssueTab; label: string; count?: string; items: MarketDealItem[] }[] = [
    { id: "records", label: "오늘의 기록", items: [] },
    { id: "singoga", label: "신고가", count: String(data.kpis.singogaCount), items: data.singoga },
    { id: "drop", label: "하락거래", count: String(data.kpis.dropCount), items: data.drops },
  ];
  const [active, setActive] = useState<IssueTab>("records");
  const tab = tabs.find((t) => t.id === active) ?? tabs[0]!;
  const prefix = "market-issues";

  return (
    <LabSection
      id={id}
      title="오늘의 가격 이슈"
      tip={
        <ul className="flex list-disc flex-col gap-1 pl-4">
          <li>오늘 집랩이 처음 확인한 매매를 계약일 이전 거래와 비교합니다.</li>
          <li>오늘의 기록: 오늘 확인된 매매 중 가장 비싼 거래, 가장 크게 오른 신고가, 가장 오래된 고점을 넘은 신고가, 가장 많이 떨어진 거래, 거래가 가장 많은 단지</li>
          <li>신고가: 같은 단지·면적에서 계약일 이전 최고가보다 높은 거래</li>
          <li>하락거래(고점 −10%): 계약일 이전 최고가보다 10% 이상 낮은 거래</li>
        </ul>
      }
    >
      <LabTabs
        variant="secondary"
        ariaLabel="가격 이슈 구분"
        idPrefix={prefix}
        items={tabs.map(({ id: tid, label, count }) => ({ id: tid, label, count }))}
        value={active}
        onChange={setActive}
      />
      <div id={labTabPanelId(prefix, active)} role="tabpanel" className="flex flex-col">
        {/* 홈은 요약 — 5건만, 더보기 없이. 전체는 아래 '전체 보기'(신고가·하락 거래 페이지) */}
        {active === "records" ? (
          data.discoveryDate ? (
            <TodayRecords date={data.discoveryDate} />
          ) : (
            <p className="lab-state">오늘 확인된 매매가 아직 없어 기록이 없습니다.</p>
          )
        ) : tab.items.length === 0 ? (
          <p className="lab-state">
            {active === "singoga" ? "오늘 확인된 신고가가 없습니다." : "오늘 확인된 하락거래가 없습니다."}
          </p>
        ) : (
          <ul className={LAB_LIST}>
            {tab.items.slice(0, LAB_LIST_PREVIEW).map((item) => (
              <DealRow key={`${active}-${item.id}`} item={item} />
            ))}
          </ul>
        )}
      </div>
      <Link
        href={`/market/price-moves?period=1d${active === "drop" ? "&kind=drop" : ""}`}
        className="lab-button lab-button-secondary w-full"
      >
        {active === "drop" ? "하락거래 전체 보기" : active === "singoga" ? "신고가 전체 보기" : "신고가 · 하락 거래 전체 보기"}
        <span aria-hidden className="ml-1">
          →
        </span>
      </Link>
    </LabSection>
  );
}

/** "2026-09-24" → "9월 24일" */
function monthDay(iso: string): string {
  return `${Number(iso.slice(5, 7))}월 ${Number(iso.slice(8, 10))}일`;
}

/** 업데이트 시각 HH:MM (KST) — 표기 라벨에서, 없으면 computedAt(ISO)에서 */
function clockOf(label: string | null | undefined, iso?: string | null): string | null {
  const m = label?.match(/(d{1,2}:d{2})s*$/);
  if (m) return m[1]!;
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
}

/** 요약 아래 숫자 한 칸 — 누르면 해당 목록으로 이동 */
function SummaryStat({
  href,
  label,
  value,
  tone,
}: {
  href: string;
  label: string;
  value: string;
  tone?: "up" | "down";
}) {
  return (
    <Link
      href={href}
      className="lab-press flex min-h-11 flex-col justify-center py-2 pl-3 pr-2"
    >
      <span className="flex items-center justify-between gap-1">
        <span className="detail-meta min-w-0">{label}</span>
        <ChevronRight className="lab-press-arrow h-4 w-4 shrink-0" aria-hidden />
      </span>
      <span
        className="text-[18px] font-bold leading-6 tabular-nums text-[color:var(--lab-navy-950)]"
        style={tone ? { color: tone === "up" ? "var(--lab-change-up)" : "var(--lab-change-down)" } : undefined}
      >
        {value}
      </span>
    </Link>
  );
}

export function MarketHome() {
  const query = useQuery({
    queryKey: ["market-home"],
    queryFn: fetchMarketHome,
    staleTime: 5 * 60 * 1000,
  });
  const stickyAnchorRef = useRef<HTMLDivElement | null>(null);

  const data = query.data;
  useLoadProgressWhen(query.isLoading && !data, "시장 불러오는 중…");
  const hasNewDeals = (data?.kpis.newDealCount ?? 0) > 0;
  const hasIssues =
    !!data &&
    (data.notables.length > 0 || data.singoga.length > 0 || data.drops.length > 0);

  return (
    <div className={PAGE_SHELL}>
      <PageHeader
        title="시장 정보"
        titleClassName="detail-page-title"
        showDivider={false}
        titleInHeader
        className="sm:mt-2"
      />
      <div ref={stickyAnchorRef} className="-mb-3 h-0 sm:-mb-6" aria-hidden />
      <LabStickySectionNav
        anchor={stickyAnchorRef}
        sections={MARKET_SECTIONS}
        title="시장 정보"
        subtitle={data?.discoveryDate ?? undefined}
        ariaLabel="시장 섹션"
      />

      {query.isLoading ? <div className="lab-skeleton" /> : null}

      {query.isError ? (
        <LabSection id="market-summary" title="오늘의 요약">
          <p className="lab-state lab-state-error">{(query.error as Error).message}</p>
          <button
            type="button"
            className="lab-button lab-button-primary w-full"
            onClick={() => void query.refetch()}
          >
            다시 시도
          </button>
        </LabSection>
      ) : null}

      {data ? (
        <section id="market-summary" aria-label="오늘의 요약" className={`${LAB_SECTION_SURFACE} flex flex-col gap-3`}>
          <p className="text-[20px] font-bold leading-7 tracking-tight text-[color:var(--lab-navy-950)]">
            {hasNewDeals ? (
              <>
                오늘 매매{" "}
                <span className="tabular-nums text-[color:var(--lab-teal-700)]">
                  {(data.kpis.newDealCount ?? 0).toLocaleString("ko-KR")}건
                </span>
                이 새로 확인됐어요
              </>
            ) : (
              "오늘은 아직 새로 확인된 매매가 없어요"
            )}
          </p>
          <div className="grid grid-cols-3 gap-2">
            <SummaryStat
              href="/market/price-moves?period=1d"
              label="신고가"
              value={`${data.kpis.singogaCount.toLocaleString("ko-KR")}건`}
              tone={data.kpis.singogaCount > 0 ? "up" : undefined}
            />
            <SummaryStat
              href="/market/price-moves?period=1d&kind=drop"
              label="고점 −10%"
              value={`${data.kpis.dropCount.toLocaleString("ko-KR")}건`}
              tone={data.kpis.dropCount > 0 ? "down" : undefined}
            />
            <SummaryStat
              href="#market-volume"
              label="거래량 급증"
              value={`${(data.kpis.volumeSurgeCount ?? 0).toLocaleString("ko-KR")}곳`}
            />
          </div>
          {data.warning && hasNewDeals ? (
            <p className="detail-body text-[color:var(--lab-warning-text)]">{data.warning}</p>
          ) : null}
          {/* 확인일·업데이트 — 페이지 제목 줄 대신 요약 카드 맨 아래 오른쪽 */}
          <div className="-mt-1 -mb-1.5 flex items-center justify-end">
            <p className="detail-meta tabular-nums">
              {data.discoveryDate ? `${monthDay(data.discoveryDate)} 확인` : ""}
              {clockOf(data.lastUpdatedLabel, data.computedAt) ? ` · ${clockOf(data.lastUpdatedLabel, data.computedAt)} 업데이트` : ""}
            </p>
            <InfoTip aria-label="시장 정보 안내">
          <>
            <p>오늘 집랩이 새로 확인한 거래·가격 이슈와 정책 발표, 시장 흐름을 한눈에 봅니다.</p>
            <p className="mt-1.5">
              확인일: {SEEN_DATE_BASIS_HELP} 공식 신고일이나 공개일을 뜻하지 않습니다.
            </p>
            <p className="mt-1.5">
              업데이트: 집랩 데이터가 마지막으로 갱신된 시각입니다. 각 거래의 날짜와 시장 흐름은 계약일
              기준입니다. {CONTRACT_DATE_BASIS_HELP}
            </p>
          </>
            </InfoTip>
          </div>
        </section>
      ) : null}

      {/* 정책 발표는 시장 데이터와 별도로 불러와 먼저 보일 수 있다 */}
      <div className="grid grid-cols-1 gap-3 sm:gap-6 lg:grid-cols-2 lg:items-start lg:gap-8">
        {data && hasIssues ? (
          <PriceIssuesSection id="market-price-issues" data={data} />
        ) : null}

        <LabSectionBoundary id="market-headlines" title="부동산 뉴스">
          <MarketHeadlines id="market-headlines" />
        </LabSectionBoundary>

        <LabSectionBoundary id="market-policy" title="정책·규제 발표">
          <MarketPolicyNews id="market-policy" />
        </LabSectionBoundary>

        {data && hasNewDeals && data.regionBreakdown ? (
          <MarketRegionBreakdown id="market-regions" data={data.regionBreakdown} />
        ) : null}

        {data ? (
          <LabSection
            id="market-volume"
            title="거래량 급증 단지"
            tip={
              <p>
                계약일 기준 최근 30일 매매가 5건 이상이면서 직전 30일(3건 이상)의 2배 이상으로 늘어난
                단지입니다. 늘어난 건수가 많은 순입니다.
              </p>
            }
          >
            <PreviewList
              items={data.volumeSurges ?? []}
              getKey={(item) => `${item.aptName}|${item.gu}|${item.dong}`}
              emptyLabel="조건에 맞는 단지가 없습니다."
              moreUnit="곳"
              render={(item) => <VolumeRow item={item} />}
            />
          </LabSection>
        ) : null}
      </div>

      {/* 오늘 이슈 아래: 장기 흐름 요약 (전국) — 자세히는 /stats */}
      <MarketFlowSummary />

      {/* 시장 콘텐츠 아래 — 실험실은 두 번째 콘텐츠 영역 */}
      <LabExperiments />
    </div>
  );
}

"use client";

import { useCallback, useId, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { BackLink } from "@/components/layout/BackLink";
import { PAGE_SHELL, PageHeader } from "@/components/layout/PageHeader";
import { LabSection } from "@/components/ui/LabSection";
import { LAB_LIST, LabListRow } from "@/components/ui/LabListRow";
import { LabMoreButton } from "@/components/ui/LabMoreButton";
import { LabShareBars } from "@/components/ui/LabShareBars";
import { LabTabs } from "@/components/ui/LabTabs";
import { LabTag } from "@/components/ui/LabTag";
import { getRegion } from "@/lib/constants/regions-registry";
import {
  PRICE_MOVES_PERIODS,
  PRICE_MOVES_SIDO,
  type PriceMoveItem,
  type PriceMovesArea,
  type PriceMovesPeriod,
  type PriceMovesResponse,
  type PriceMovesSort,
} from "@/lib/market/price-moves";
import { formatEok } from "@/lib/utils/format";

type Kind = "singoga" | "drop";
const PAGE = 20;

const AREA_ITEMS: Array<{ id: PriceMovesArea; label: string }> = [
  { id: "all", label: "전체" },
  { id: "small", label: "소형" },
  { id: "mid", label: "중형" },
  { id: "large", label: "대형" },
];
const SORT_ITEMS: Array<{ id: PriceMovesSort; label: string }> = [
  { id: "amount", label: "금액순" },
  { id: "pct", label: "비율순" },
  { id: "recent", label: "최신순" },
];

function ym(iso: string | null): string {
  return iso ? `${iso.slice(0, 4)}.${iso.slice(5, 7)}` : "";
}

function yearsBetween(a: string | null, b: string): number {
  if (!a) return 0;
  return (new Date(b).getTime() - new Date(a).getTime()) / (365.25 * 86_400_000);
}

function signedEok(man: number): string {
  return `${man > 0 ? "+" : man < 0 ? "−" : ""}${formatEok(Math.abs(man))}`;
}

function MoveRow({ item, kind }: { item: PriceMoveItem; kind: Kind }) {
  const gapYears = yearsBetween(item.priorMaxDate, item.dealDate);
  // 맥락 라벨: 신고가는 "N년 만의 최고가", 하락은 고점 시점
  const context =
    kind === "singoga"
      ? gapYears >= 1
        ? `${Math.floor(gapYears)}년 만의 최고가`
        : null
      : item.priorMaxDate
        ? `${ym(item.priorMaxDate)} 고점 대비`
        : null;
  return (
    <LabListRow
      href={item.href}
      title={
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate">{item.aptName}</span>
          {item.moreCount > 0 ? <LabTag>외 {item.moreCount}건</LabTag> : null}
        </span>
      }
      meta={
        <>
          <span className="block truncate">
            {[
              `${item.regionLabel} ${item.dong}`.trim(),
              `전용 ${Math.round(item.exclusiveArea * 10) / 10}㎡`,
              item.floor != null ? `${item.floor}층` : null,
              `계약 ${item.dealDate.slice(5).replace("-", ".")}`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
          <span className="block truncate">
            {kind === "singoga" ? "직전 최고" : "고점"} {formatEok(item.priorMaxAmount)}
            {item.priorMaxDate ? ` (${ym(item.priorMaxDate)})` : ""}
            {context ? ` · ${context}` : ""}
          </span>
        </>
      }
      value={formatEok(item.dealAmount)}
      valueTone={kind === "singoga" ? "up" : "down"}
      sub={`${signedEok(item.changeAmount)} · ${item.changePct > 0 ? "+" : ""}${item.changePct}%`}
    />
  );
}

function ScopeSelect({
  value,
  regionLabel,
  onChange,
}: {
  value: string;
  regionLabel: string | null;
  onChange: (v: string) => void;
}) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col">
      <div className="relative">
        <select
          id={id}
          aria-label="지역"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="lab-input h-12 w-full appearance-none pr-10 pl-3 text-[16px] font-medium"
        >
          <option value="">전국</option>
          {regionLabel ? <option value={`region:${value.replace(/^region:/, "")}`}>{regionLabel}</option> : null}
          {PRICE_MOVES_SIDO.map((s) => (
            <option key={s.id} value={`sido:${s.id}`}>
              {s.label}
            </option>
          ))}
        </select>
        <ChevronDown
          className="pointer-events-none absolute top-1/2 right-3 h-5 w-5 -translate-y-1/2 text-[color:var(--lab-muted)]"
          aria-hidden
        />
      </div>
    </div>
  );
}

/** 시장 > 신고가 · 하락 거래 — 시장 홈 '오늘의 가격 이슈'의 전체 목록. */
export function PriceMovesPage() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  const [kind, setKind] = useState<Kind>(sp.get("kind") === "drop" ? "drop" : "singoga");
  const [period, setPeriod] = useState<PriceMovesPeriod>(() => {
    const p = sp.get("period");
    return p && p in PRICE_MOVES_PERIODS ? (p as PriceMovesPeriod) : "7d";
  });
  const [scope, setScope] = useState<string>(() =>
    sp.get("region") ? `region:${sp.get("region")}` : sp.get("sido") ? `sido:${sp.get("sido")}` : "",
  );
  const [area, setArea] = useState<PriceMovesArea>("all");
  const [sort, setSort] = useState<PriceMovesSort>("amount");

  const region = scope.startsWith("region:") ? scope.slice(7) : null;
  const sido = scope.startsWith("sido:") ? scope.slice(5) : null;
  const regionLabel = region ? getRegion(region)?.name ?? null : null;

  const syncUrl = useCallback(
    (next: { kind?: Kind; period?: PriceMovesPeriod; scope?: string }) => {
      const k = next.kind ?? kind;
      const p = next.period ?? period;
      const s = next.scope ?? scope;
      const params = new URLSearchParams();
      if (k !== "singoga") params.set("kind", k);
      if (p !== "7d") params.set("period", p);
      if (s.startsWith("region:")) params.set("region", s.slice(7));
      if (s.startsWith("sido:")) params.set("sido", s.slice(5));
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [kind, period, scope, pathname, router],
  );

  const query = useInfiniteQuery({
    queryKey: ["price-moves", kind, period, region, sido, area, sort],
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const qs = new URLSearchParams({ kind, period, area, sort, offset: String(pageParam), limit: String(PAGE) });
      if (region) qs.set("region", region);
      if (sido) qs.set("sido", sido);
      const res = await fetch(`/api/market/price-moves?${qs}`);
      if (!res.ok) throw new Error("신고가·하락 거래를 불러오지 못했습니다.");
      return (await res.json()) as PriceMovesResponse;
    },
    getNextPageParam: (last, pages) => (last.hasMore ? pages.length * PAGE : undefined),
    staleTime: 5 * 60_000,
  });

  const first = query.data?.pages[0];
  const items = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);
  const kindCount = first ? first.counts[kind] : 0;
  const share = first && first.seenTrades > 0 ? Math.round((kindCount / first.seenTrades) * 1000) / 10 : null;
  const kindLabel = kind === "singoga" ? "신고가" : "하락거래";

  return (
    <div className={PAGE_SHELL}>
      <PageHeader
        leading={<BackLink fallback="/" compact hideLabel />}
        title="신고가 · 하락 거래"
        showDivider={false}
        titleTip={
          <p>
            집랩이 처음 확인한 날 기준으로, 같은 단지·같은 동·같은 전용면적의 이전(계약일 기준) 최고가보다 비싸게
            팔린 거래를 신고가, 10% 이상 싸게 팔린 거래를 하락거래로 모았습니다. 같은 단지는 한 줄로 묶고 변화가 가장
            큰 거래를 보여 줍니다.
          </p>
        }
      />

      <LabTabs
        ariaLabel="거래 종류"
        items={[
          { id: "singoga" as Kind, label: "신고가", count: first ? first.counts.singoga.toLocaleString("ko-KR") : undefined },
          { id: "drop" as Kind, label: "하락거래", count: first ? first.counts.drop.toLocaleString("ko-KR") : undefined },
        ]}
        value={kind}
        onChange={(k) => {
          setKind(k);
          syncUrl({ kind: k });
        }}
      />

      <div className="flex flex-col gap-3">
        <ScopeSelect
          value={scope}
          regionLabel={regionLabel}
          onChange={(v) => {
            setScope(v);
            syncUrl({ scope: v });
          }}
        />
        <LabTabs
          variant="compact"
          ariaLabel="기간"
          equalWidth
          items={(Object.keys(PRICE_MOVES_PERIODS) as PriceMovesPeriod[]).map((id) => ({ id, label: PRICE_MOVES_PERIODS[id].label }))}
          value={period}
          onChange={(p) => {
            setPeriod(p);
            syncUrl({ period: p });
          }}
        />
        <LabTabs variant="compact" ariaLabel="면적" equalWidth items={AREA_ITEMS} value={area} onChange={setArea} />
      </div>

      {query.isLoading ? <div className="lab-skeleton" aria-label="불러오는 중" /> : null}
      {query.isError ? (
        <div className="flex flex-col gap-3">
          <p className="lab-state lab-state-error">{(query.error as Error).message}</p>
          <button type="button" className="lab-button lab-button-primary w-full" onClick={() => void query.refetch()}>
            다시 시도
          </button>
        </div>
      ) : null}
      {first?.status === "not_ready" ? (
        <p className="lab-state">신고가·하락 거래 기록을 준비하고 있어요. 곧 이 페이지에서 볼 수 있어요.</p>
      ) : null}

      {first?.status === "ok" ? (
        <>
          <LabSection
            title={`${first.scopeLabel} ${kindLabel}`}
            meta={`${PRICE_MOVES_PERIODS[period].label} · ${first.from.slice(5).replace("-", ".")} ~ ${first.to.slice(5).replace("-", ".")}`}
          >
            <p className="detail-body tabular-nums">
              <strong className="text-[22px] font-bold leading-8 text-[color:var(--lab-navy-950)]">
                {kindCount.toLocaleString("ko-KR")}건
              </strong>
              {share != null ? (
                <span className="ml-2 text-[color:var(--lab-muted)]">
                  처음 확인된 매매 {first.seenTrades.toLocaleString("ko-KR")}건의 {share}%
                </span>
              ) : null}
            </p>
            {first.topRegions.length > 1 && !region ? (
              <LabShareBars
                sort="none"
                items={first.topRegions.map((r) => ({
                  key: r.lawdCd,
                  label: r.label,
                  value: r.count,
                  sub: `${r.count.toLocaleString("ko-KR")}건`,
                }))}
                color={kind === "singoga" ? "var(--lab-change-up)" : "var(--lab-change-down)"}
              />
            ) : null}
          </LabSection>

          <LabSection title={`${kindLabel} 단지`} meta={`${first.totalGroups.toLocaleString("ko-KR")}개 단지`}>
            {/* 정렬은 이 목록에만 영향 — 요약 위 조건(지역·기간·면적)과 분리 */}
            <LabTabs variant="compact" ariaLabel="정렬" equalWidth items={SORT_ITEMS} value={sort} onChange={setSort} />
            {items.length === 0 ? (
              <p className="lab-state">이 조건에 해당하는 {kindLabel}가 없어요.</p>
            ) : (
              <ul className={LAB_LIST}>
                {items.map((it) => (
                  <MoveRow key={it.txId} item={it} kind={kind} />
                ))}
              </ul>
            )}
            {query.hasNextPage ? (
              <LabMoreButton
                expanded={false}
                onToggle={() => void query.fetchNextPage()}
                label={query.isFetchingNextPage ? "불러오는 중…" : `${PAGE}개 단지 더보기`}
              />
            ) : null}
          </LabSection>
        </>
      ) : null}
    </div>
  );
}

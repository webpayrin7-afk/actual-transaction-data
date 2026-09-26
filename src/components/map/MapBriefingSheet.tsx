"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, ChevronUp, MapPin } from "lucide-react";
import { LabDataLoading, LabLoadingDots } from "@/components/ui/LabLoading";
import { LabTabs, labTabPanelId } from "@/components/ui/LabTabs";
import type { MarketDealItem, MarketHomeResponse, MarketVolumeItem } from "@/lib/market/home";
import { fetchMarketHome, MARKET_HOME_QUERY_KEY, MARKET_HOME_STALE_MS } from "@/lib/market/home-client";
import {
  localScope,
  scopedCount,
  scopedList,
  topicJosa,
  type BriefScope,
  type MapRegionAt,
} from "@/lib/market/briefing-scope";
import type { MapLocateResult } from "@/lib/map/locate";
import { seoulToday } from "@/lib/market/time";
import { formatArea, formatEok } from "@/lib/utils/format";

/**
 * 지도 첫 화면 '오늘의 시장 브리핑' — 접힌 한 줄(신고가 · 하락 · 거래 급증)과, 끌어 올리거나 누르면 펼쳐지는 짧은 목록.
 * 데이터는 /market 과 같은 /api/market-home (같은 React Query 키) — 새 집계·대량 조회 없음, 목록마다 5개만 그린다.
 * 항목을 누르면 그 단지(못 찾으면 동·구) 위치만 /api/map/locate 로 한 곳씩 찾아 지도를 옮기고 시트를 접는다.
 *
 * 범위 [지역 이름 | 전국] — 기본은 지도 가운데 지역. 가운데 시·도(서울·경기·부산 …)로 거르고, 구 수준까지 확대했고(2D 줌 ≥ 13,
 * 3D 줌 ≥ 12) 그 구에 오늘 항목이 있으면 구(송파구)로 좁힌다. 가운데 지역은 지도가 멈추고 400ms 뒤 /api/map/region-at
 * (좌표 약 100m 단위로 기억)으로 한 번 찾는다. 거르기는 받은 목록으로 브라우저에서 (lib/market/briefing-scope).
 *
 * 모바일: 아래 독(탭 막대) 바로 위 떠 있는 시트, 접힘 88px · 펼침 화면 높이의 55%.
 * 데스크톱(≥ sm): 오른쪽 위 패널 (누르면 아래로 펼침).
 */

export const BRIEFING_PEEK_PX = 88;
/** 목록마다 최대 개수 — 전체는 /market */
const LIST_MAX = 5;
const EXPANDED_RATIO = 0.55;
/** 지도가 멈춘 뒤 이만큼 기다렸다 가운데 지역을 찾는다 */
const SCOPE_DEBOUNCE_MS = 400;
/** 구 수준 확대 — 네이버 2D 줌 / MapLibre 3D 줌 (512px 타일이라 1 작다) */
const GU_ZOOM_2D = 13;
const GU_ZOOM_3D = 12;
const ALL_SCOPE: BriefScope = { kind: "all", label: "전국" };

/** 지도가 지금 보는 곳 (2D: 네이버 줌, 3D: MapLibre 줌) */
export type BriefingView = { lat: number; lng: number; zoom: number; mode: "2d" | "3d" };

async function fetchRegionAt(lat: string, lng: string): Promise<MapRegionAt | null> {
  const res = await fetch(`/api/map/region-at?${new URLSearchParams({ lat, lng })}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("region-at failed");
  const body = (await res.json()) as MapRegionAt & { status: string };
  return body.status === "ok" ? { lawdCd: body.lawdCd, name: body.name, metro: body.metro, metroLabel: body.metroLabel } : null;
}

type BriefTab = "singoga" | "drop" | "surge";
type BriefItem = {
  key: string;
  name: string;
  gu: string;
  dong: string;
  meta: string;
  value: string;
  sub: string | null;
  tone: "up" | "down" | null;
  href: string;
};

export type BriefingTarget = MapLocateResult & { name: string; href: string };

function dealItem(item: MarketDealItem): BriefItem {
  const pct = item.changePct;
  return {
    key: `${item.kind}-${item.id}`,
    name: item.aptName,
    gu: item.gu,
    dong: item.dong,
    meta: `${item.gu} ${item.dong} · ${formatArea(item.exclusiveArea)}`,
    value: formatEok(item.dealAmount),
    sub: pct != null ? `${pct > 0 ? "+" : ""}${pct}%` : null,
    tone: pct == null || pct === 0 ? null : pct > 0 ? "up" : "down",
    href: item.href,
  };
}

function surgeItem(item: MarketVolumeItem): BriefItem {
  return {
    key: `surge-${item.aptName}|${item.gu}|${item.dong}`,
    name: item.aptName,
    gu: item.gu,
    dong: item.dong,
    meta: `${item.gu} ${item.dong} · 최근 30일 ${item.recentCount}건`,
    value: `+${item.increaseCount}건`,
    sub: item.growthPct != null ? `+${item.growthPct}%` : null,
    tone: "up",
    href: item.href,
  };
}

function monthDay(iso: string): string {
  return `${Number(iso.slice(5, 7))}월 ${Number(iso.slice(8, 10))}일`;
}

const TONE_COLOR = { up: "var(--lab-change-up)", down: "var(--lab-change-down)" } as const;

type ScopeCounts = { singoga: number; drop: number; surge: number };

function PeekLine({ data, scope, counts }: { data: MarketHomeResponse; scope: BriefScope; counts: ScopeCounts }) {
  const day = data.discoveryDate && data.discoveryDate !== seoulToday() ? monthDay(data.discoveryDate) : "오늘";
  const where = scope.label;
  if (!counts.singoga && !counts.drop && !counts.surge) {
    return (
      <>
        {day === "오늘"
          ? `${where}${topicJosa(where)} 오늘 새 신고가·하락 거래가 없어요`
          : `${where} ${day} 새 신고가·하락 거래 없음`}
      </>
    );
  }
  return (
    <>
      <span className="text-[color:var(--lab-teal-700)]">{where}</span> {day} 신고가{" "}
      <span className="tabular-nums" style={counts.singoga ? { color: TONE_COLOR.up } : undefined}>
        {counts.singoga.toLocaleString("ko-KR")}
      </span>
      <span className="px-[3px] text-[color:var(--lab-muted)]" aria-hidden>
        ·
      </span>
      하락{" "}
      <span className="tabular-nums" style={counts.drop ? { color: TONE_COLOR.down } : undefined}>
        {counts.drop.toLocaleString("ko-KR")}
      </span>
      <span className="px-[3px] text-[color:var(--lab-muted)]" aria-hidden>
        ·
      </span>
      거래 급증 <span className="tabular-nums text-[color:var(--lab-teal-700)]">{counts.surge.toLocaleString("ko-KR")}곳</span>
    </>
  );
}

export function MapBriefingSheet({
  hidden = false,
  view,
  onTarget,
}: {
  /** 단지 카드가 떠 있을 때 등 — 시트를 숨긴다 (상태는 그대로) */
  hidden?: boolean;
  /** 지도가 지금 보는 곳 — '지역' 범위를 정한다 (null = 아직 모름) */
  view: BriefingView | null;
  /** 항목 위치를 찾았을 때 — 지도를 옮긴다 */
  onTarget: (t: BriefingTarget) => void;
}) {
  const query = useQuery({
    queryKey: MARKET_HOME_QUERY_KEY,
    queryFn: fetchMarketHome,
    staleTime: MARKET_HOME_STALE_MS,
  });
  const qc = useQueryClient();
  const data = query.data;
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState<BriefTab>("singoga");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [failKey, setFailKey] = useState<string | null>(null);
  /** 끄는 중 높이(px) — null 이면 접힘/펼침 높이 */
  const [dragH, setDragH] = useState<number | null>(null);
  const drag = useRef<{ y: number; h: number; max: number; moved: boolean; id: number } | null>(null);
  /** 끌기로 끝난 누름은 탭(열고 닫기)으로 치지 않는다 */
  const suppressClick = useRef(false);
  const panelId = useId();
  const tabPrefix = "map-briefing";

  /* ── 범위: 지도 가운데 지역 | 전국 ── */
  const [scopeMode, setScopeMode] = useState<"local" | "all">("local");
  /** 멈춘 지 SCOPE_DEBOUNCE_MS 지난 지도 위치 (처음 한 번은 바로) */
  const [settled, setSettled] = useState<BriefingView | null>(null);
  const hasSettled = settled != null;
  useEffect(() => {
    if (!view) return;
    const t = window.setTimeout(() => setSettled(view), hasSettled ? SCOPE_DEBOUNCE_MS : 0);
    return () => window.clearTimeout(t);
  }, [view, hasSettled]);
  const latKey = settled ? settled.lat.toFixed(3) : null;
  const lngKey = settled ? settled.lng.toFixed(3) : null;
  const regionQuery = useQuery({
    queryKey: ["map-region-at", latKey, lngKey],
    queryFn: () => fetchRegionAt(latKey!, lngKey!),
    enabled: latKey != null && lngKey != null,
    staleTime: Infinity,
    gcTime: 30 * 60 * 1000,
    retry: 1,
    placeholderData: keepPreviousData,
  });
  const region = regionQuery.data ?? null;
  const zoomedIn = settled ? settled.zoom >= (settled.mode === "3d" ? GU_ZOOM_3D : GU_ZOOM_2D) : false;
  const local = localScope(data, region, zoomedIn);
  /** 가운데 지역을 처음 찾는 중 — 그동안 개수 자리는 불러오는 중으로 (못 찾으면 전국) */
  const regionPending = scopeMode === "local" && !local && view != null && (settled == null || regionQuery.isPending);
  const scope: BriefScope = scopeMode === "all" || !local ? ALL_SCOPE : local;
  const localLabel = local?.label ?? "이 지역";

  // 펼친 채 Esc — 접는다
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  const lists: Record<BriefTab, BriefItem[]> = data
    ? {
        singoga: scopedList(data, "singoga", scope, LIST_MAX).map(dealItem),
        drop: scopedList(data, "drops", scope, LIST_MAX).map(dealItem),
        surge: scopedList(data, "volumeSurges", scope, LIST_MAX).map(surgeItem),
      }
    : { singoga: [], drop: [], surge: [] };
  const counts: ScopeCounts | null = data
    ? {
        singoga: scopedCount(data, "singoga", scope),
        drop: scopedCount(data, "drops", scope),
        surge: scopedCount(data, "volumeSurges", scope),
      }
    : null;
  /** 지금 탭에서 지역과 전국이 같으면(예: 오늘 신고가가 모두 이 지역) — 범위 칸이 의미 없어 숨긴다 (탭마다 따로) */
  const tabKey = ({ singoga: "singoga", drop: "drops", surge: "volumeSurges" } as const)[tab];
  const sameAsAll = !!data && !!local && scopedCount(data, tabKey, local) === scopedCount(data, tabKey, ALL_SCOPE);
  const tabs: { id: BriefTab; label: string; count?: string }[] = [
    { id: "singoga", label: "신고가", count: counts ? String(counts.singoga) : undefined },
    { id: "drop", label: "하락", count: counts ? String(counts.drop) : undefined },
    { id: "surge", label: "거래 급증", count: counts ? String(counts.surge) : undefined },
  ];
  const items = lists[tab];
  const chooseScope = (m: "local" | "all") => {
    setScopeMode(m);
    setFailKey(null);
  };
  const emptyText = (() => {
    if (scope.kind === "all") {
      return tab === "singoga"
        ? "오늘 확인된 신고가가 없습니다."
        : tab === "drop"
          ? "오늘 확인된 하락 거래가 없습니다."
          : "거래가 급증한 단지가 없습니다.";
    }
    const topic = `${scope.label}${topicJosa(scope.label)}`;
    if (tab === "surge") return `${topic} 거래가 급증한 단지가 없어요`;
    if (counts && !counts.singoga && !counts.drop) return `${topic} 오늘 새 신고가·하락 거래가 없어요`;
    return tab === "singoga" ? `${topic} 오늘 새 신고가가 없어요` : `${topic} 오늘 새 하락 거래가 없어요`;
  })();

  const pick = async (item: BriefItem) => {
    if (busyKey) return;
    setBusyKey(item.key);
    setFailKey(null);
    try {
      const hit = await qc.fetchQuery({
        queryKey: ["map-locate", item.name, item.gu, item.dong, item.href],
        staleTime: Infinity,
        queryFn: async (): Promise<MapLocateResult | null> => {
          const qs = new URLSearchParams({ name: item.name, gu: item.gu, dong: item.dong });
          // 단지 링크의 지역 — 같은 구 이름이 여러 시에 있을 때 가른다
          const region = new URL(item.href, "http://x").searchParams.get("region");
          if (region) qs.set("region", region);
          const res = await fetch(`/api/map/locate?${qs}`);
          if (res.status === 404) return null;
          if (!res.ok) throw new Error("locate failed");
          const body = (await res.json()) as MapLocateResult & { status: string };
          return body.status === "ok" ? body : null;
        },
      });
      if (!hit) {
        setFailKey(item.key);
        return;
      }
      setExpanded(false);
      onTarget({ ...hit, name: item.name, href: item.href });
    } catch {
      setFailKey(item.key);
    } finally {
      setBusyKey(null);
    }
  };

  /* ── 끌어서 열고 닫기 (모바일) ── */
  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const sheet = e.currentTarget.parentElement;
    const max = Math.round(window.innerHeight * EXPANDED_RATIO);
    drag.current = { y: e.clientY, h: sheet?.getBoundingClientRect().height ?? BRIEFING_PEEK_PX, max, moved: false, id: e.pointerId };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dy = e.clientY - d.y;
    if (!d.moved) {
      if (Math.abs(dy) < 6) return;
      d.moved = true;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }
    setDragH(Math.max(BRIEFING_PEEK_PX, Math.min(d.max, d.h - dy)));
  };
  const endDrag = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d || !d.moved) return;
    suppressClick.current = true;
    const h = Math.max(BRIEFING_PEEK_PX, Math.min(d.max, d.h - (e.clientY - d.y)));
    // 방향 우선 — 조금만 끌어도 끈 쪽으로
    const moved = h - d.h;
    setExpanded(Math.abs(moved) > 24 ? moved > 0 : h > (BRIEFING_PEEK_PX + d.max) / 2);
    setDragH(null);
  };

  // 펼치면 내용 높이만큼만 (최대 화면의 55%) — 목록이 짧을 때 아래 빈 여백이 생기지 않게
  const sheetStyle =
    dragH != null
      ? { height: `${dragH}px` }
      : expanded
        ? { height: "auto", maxHeight: `${EXPANDED_RATIO * 100}dvh` }
        : { height: `${BRIEFING_PEEK_PX}px` };
  const animate = dragH == null;

  return (
    <div
      className={`pointer-events-none absolute inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+76px)] z-30 flex justify-center px-3 sm:inset-x-auto sm:bottom-auto sm:right-4 sm:top-[60px] sm:px-0 ${
        hidden ? "hidden" : ""
      }`}
      data-map-briefing={expanded ? "expanded" : "peek"}
    >
      <section
        aria-label="오늘의 시장 브리핑"
        className={`pointer-events-auto flex w-full max-w-md flex-col overflow-hidden rounded-2xl border border-[color:var(--lab-border)] bg-[color:var(--lab-surface)] shadow-[0_8px_24px_rgb(15_23_42/0.16)] sm:w-[340px] sm:!h-auto ${
          animate ? "transition-[height] duration-200 ease-out motion-reduce:transition-none" : ""
        }`}
        style={sheetStyle}
      >
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={panelId}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={() => {
            drag.current = null;
            setDragH(null);
          }}
          onClick={() => {
            if (suppressClick.current) {
              suppressClick.current = false;
              return;
            }
            setExpanded((v) => !v);
          }}
          className="flex h-[88px] w-full shrink-0 touch-none select-none flex-col items-stretch px-4 pb-2.5 pt-2 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[color:var(--lab-teal-600)] sm:h-auto sm:touch-auto sm:pt-3"
        >
          <span className="mx-auto mb-1.5 h-1 w-9 shrink-0 rounded-full bg-[color:var(--lab-navy-950)]/20 sm:hidden" aria-hidden />
          <span className="flex items-center gap-1.5 text-[12px] font-semibold leading-4 text-[color:var(--lab-teal-700)]">
            <span className="relative inline-flex h-2 w-2" aria-hidden>
              <span className="absolute inset-0 rounded-full bg-[color:var(--lab-brand-primary)]" />
            </span>
            오늘의 시장 브리핑
            {data?.lastUpdatedLabel ? (
              <span className="font-medium text-[color:var(--lab-muted)]">· {data.lastUpdatedLabel}</span>
            ) : null}
          </span>
          <span className="mt-1 flex min-h-7 items-center gap-1 sm:gap-2">
            <span className="min-w-0 flex-1 truncate text-[15px] font-bold leading-6 tracking-[-0.04em] sm:text-[16px] sm:tracking-tight text-[color:var(--lab-navy-950)]">
              {data && counts && !regionPending ? (
                <PeekLine data={data} scope={scope} counts={counts} />
              ) : query.isError ? (
                <span className="text-[14px] font-medium text-[color:var(--lab-muted)]">시장 브리핑을 불러오지 못했어요</span>
              ) : (
                <span className="inline-flex items-center gap-2 text-[14px] font-medium text-[color:var(--lab-muted)]">
                  <LabLoadingDots />
                  오늘의 시장 불러오는 중…
                </span>
              )}
            </span>
            <ChevronUp
              className={`h-5 w-5 shrink-0 text-[color:var(--lab-muted)] transition-transform motion-reduce:transition-none ${
                expanded ? "rotate-180 sm:rotate-0" : "sm:rotate-180"
              }`}
              aria-hidden
            />
          </span>
        </button>

        <div
          id={panelId}
          hidden={!expanded && dragH == null}
          className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain px-4 pb-3 sm:max-h-[55dvh] sm:flex-none"
          style={expanded && dragH == null ? { maxHeight: `calc(${EXPANDED_RATIO * 100}dvh - ${BRIEFING_PEEK_PX}px)` } : undefined}
        >
          {query.isError ? (
            <div className="flex flex-col gap-2 py-2">
              <p className="lab-state lab-state-error">시장 데이터를 불러오지 못했습니다.</p>
              <button type="button" className="lab-button lab-button-secondary w-full" onClick={() => void query.refetch()}>
                다시 시도
              </button>
            </div>
          ) : !data ? (
            <LabDataLoading label="오늘의 시장 불러오는 중" minHeight={160} />
          ) : (
            <>
              {/* 범위 — 두 칸 같은 너비라 지역 이름이 바뀌어도 자리가 흔들리지 않는다 (긴 이름은 말줄임). 지역 = 전국이면 숨김 */}
              {sameAsAll ? null : (
              <div
                className="grid h-9 shrink-0 grid-cols-2 rounded-full border border-[color:var(--lab-navy-950)] bg-[color:var(--lab-surface)] p-0.5"
                role="group"
                aria-label="브리핑 범위"
              >
                {(
                  [
                    ["local", localLabel, local ? `${local.label} 브리핑 보기` : "지도 가운데 지역 브리핑 보기"],
                    ["all", "전국", "전국 브리핑 보기"],
                  ] as const
                ).map(([id, label, aria]) => {
                  const on = (scopeMode === "local" && local ? "local" : "all") === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      aria-pressed={on}
                      aria-label={aria}
                      disabled={id === "local" && !local}
                      onClick={() => chooseScope(id)}
                      className={`relative min-w-0 truncate rounded-full px-3 text-[14px] leading-5 transition-colors motion-reduce:transition-none before:absolute before:inset-x-0 before:-inset-y-1 before:content-[''] disabled:opacity-50 ${
                        on
                          ? "bg-[color:var(--lab-navy-950)] font-semibold text-white"
                          : "font-medium text-[color:var(--lab-navy-950)]"
                      }`}
                    >
                      {regionPending && id === "local" ? <LabLoadingDots /> : label}
                    </button>
                  );
                })}
              </div>
              )}
              <LabTabs
                variant="secondary"
                ariaLabel="브리핑 구분"
                idPrefix={tabPrefix}
                items={tabs}
                value={tab}
                onChange={(t) => {
                  setTab(t);
                  setFailKey(null);
                }}
              />
              <div id={labTabPanelId(tabPrefix, tab)} role="tabpanel">
                {items.length === 0 ? (
                  <div className="flex flex-col gap-2">
                    <p className="lab-state">{emptyText}</p>
                    {scope.kind !== "all" ? (
                      <button type="button" className="lab-button lab-button-secondary w-full" onClick={() => chooseScope("all")}>
                        전국 보기
                      </button>
                    ) : null}
                  </div>
                ) : (
                  <ul className="flex flex-col divide-y divide-[color:var(--lab-border)]">
                    {items.map((item) => (
                      <li key={item.key}>
                        <button
                          type="button"
                          onClick={() => void pick(item)}
                          aria-busy={busyKey === item.key}
                          className="flex min-h-12 w-full items-center gap-3 py-2 text-left hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--lab-teal-600)]"
                        >
                          <MapPin className="h-4 w-4 shrink-0 text-[color:var(--lab-teal-700)]" aria-hidden />
                          <span className="min-w-0 flex-1">
                            <span className="detail-data-value-emphasis block truncate">{item.name}</span>
                            <span className="detail-meta block truncate">{item.meta}</span>
                          </span>
                          <span className="shrink-0 text-right">
                            {busyKey === item.key ? (
                              <LabLoadingDots />
                            ) : (
                              <>
                                <span className="block text-[15px] font-bold leading-5 tabular-nums text-[color:var(--lab-navy-950)]">
                                  {item.value}
                                </span>
                                {item.sub ? (
                                  <span
                                    className="block text-[12px] font-semibold leading-4 tabular-nums"
                                    style={item.tone ? { color: TONE_COLOR[item.tone] } : undefined}
                                  >
                                    {item.sub}
                                  </span>
                                ) : null}
                              </>
                            )}
                          </span>
                        </button>
                        {failKey === item.key ? (
                          <p className="detail-meta pb-2 pl-7" role="status">
                            지도에서 위치를 찾지 못했어요 ·{" "}
                            <Link href={item.href} className="font-semibold text-[color:var(--lab-teal-700)] underline">
                              단지 상세 보기
                            </Link>
                          </p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <Link href="/market" className="lab-button lab-button-secondary mt-1 w-full">
                시장에서 더 보기
                <ChevronRight className="ml-0.5 h-4 w-4" aria-hidden />
              </Link>
            </>
          )}
        </div>
      </section>
    </div>
  );
}

"use client";

import { LAB_SECTION_SURFACE, LabSectionHeader } from "@/components/ui/LabSection";
import { LAB_LIST_PREVIEW, LabMoreButton } from "@/components/ui/LabMoreButton";
import { useMemo, useState } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { LabTabs } from "@/components/ui/LabTabs";
import { LabStatTiles, type LabStatTile } from "@/components/ui/LabStatTiles";
import { LabTag } from "@/components/ui/LabTag";
import { LabTextLink } from "@/components/ui/LabListRow";
import { useRegionPriceTrend } from "@/components/region/useRegionScopeQueries";
import { districtNameFromCode } from "@/lib/constants/regions";
import { regionDongHref } from "@/lib/molit/region-paths";
import type { RegionDongPrice } from "@/lib/region/region-price-trend";

const SORTS = [
  { id: "price", label: "시세 높은 순" },
  { id: "change", label: "1년 상승률" },
  { id: "trades", label: "거래 많은 순" },
] as const;
type SortId = (typeof SORTS)[number]["id"];

const PREVIEW = LAB_LIST_PREVIEW;
const BAR = "#0F766E";

function pctText(pct: number | null): string {
  if (pct == null) return "—";
  const abs = Math.abs(pct).toFixed(1);
  return pct > 0 ? `▲ ${abs}%` : pct < 0 ? `▼ ${abs}%` : `${abs}%`;
}

function pctClass(pct: number | null): string {
  if (pct == null || pct === 0) return "text-[color:var(--lab-muted)]";
  return pct > 0 ? "detail-change-up" : "detail-change-down";
}

function signedPct(pct: number | null, digits = 1): string {
  if (pct == null) return "—";
  return `${pct > 0 ? "+" : pct < 0 ? "−" : ""}${Math.abs(pct).toFixed(digits)}%`;
}

function toneOf(pct: number | null): LabStatTile["tone"] {
  return pct == null || pct === 0 ? "neutral" : pct > 0 ? "up" : "down";
}

/**
 * 구 안 법정동별 시세 비교.
 * - 구 페이지: "동네별 시세" 목록. 각 동은 동 상세로 이동한다.
 * - 동 페이지(`currentDong`): "주변 동 비교" — 이 동 vs 구 전체 요약 박스 + 같은 목록에서
 *   현재 동을 강조한다(미리보기 5개 밖이면 마지막 칸에 끼워 보여 준다).
 */
export function RegionDongPricesSection({
  lawdCd,
  regionName,
  regionSlug,
  currentDong,
  guLink,
}: {
  lawdCd: string;
  regionName: string;
  regionSlug: string;
  currentDong?: string;
  /** 동 페이지: 목록 아래 구 시장 현황으로 가는 보조 링크. */
  guLink?: { href: string; label: string };
}) {
  const [sort, setSort] = useState<SortId>("price");
  const [expanded, setExpanded] = useState(false);
  const query = useRegionPriceTrend({ lawdCd });
  const data = query.data?.status === "ok" ? query.data : null;
  const dongs = useMemo(() => {
    const list = (data?.dongs ?? []).filter((d) => d.pyeongPrice != null);
    const metric = (d: RegionDongPrice) =>
      sort === "price" ? d.pyeongPrice ?? 0 : sort === "change" ? d.change1y ?? -Infinity : d.tradeCount12m;
    return [...list].sort((a, b) => metric(b) - metric(a));
  }, [data, sort]);

  if (query.isError) return null;
  if (!query.isLoading && dongs.length < 2) return null;

  const compare = Boolean(currentDong);
  const currentIndex = compare ? dongs.findIndex((d) => d.name === currentDong) : -1;
  const ranked = dongs.map((d, index) => ({ d, rank: index + 1 }));
  let visible = expanded ? ranked : ranked.slice(0, PREVIEW);
  if (!expanded && currentIndex >= PREVIEW) {
    visible = [...ranked.slice(0, PREVIEW - 1), ranked[currentIndex]!];
  }
  const guPrice = data?.latest?.pyeongPrice ?? null;
  const guChange1y = data?.latest?.changes["1Y"] ?? null;
  const maxPrice = Math.max(1, ...dongs.map((d) => d.pyeongPrice ?? 0));
  const maxTrades = Math.max(1, ...dongs.map((d) => d.tradeCount12m));
  const maxAbsChange = Math.max(1, ...dongs.map((d) => Math.abs(d.change1y ?? 0)));
  const asOf = data?.latest
    ? `${data.latest.yearMonth.slice(0, 4)}.${data.latest.yearMonth.slice(4, 6)}`
    : null;

  const current = currentIndex >= 0 ? dongs[currentIndex]! : null;
  const priceRank = current
    ? [...dongs]
        .sort((a, b) => (b.pyeongPrice ?? 0) - (a.pyeongPrice ?? 0))
        .findIndex((d) => d.name === currentDong) + 1
    : null;
  const vsGu =
    current?.pyeongPrice != null && guPrice
      ? ((current.pyeongPrice - guPrice) / guPrice) * 100
      : null;
  const tiles: LabStatTile[] = [
    {
      key: "price",
      label: "평당가",
      value: current?.pyeongPrice != null ? `${current.pyeongPrice.toLocaleString("ko-KR")}만원` : "—",
      sub: vsGu != null ? `${regionName} 대비 ${signedPct(vsGu, 0)}` : undefined,
    },
    {
      key: "change",
      label: "1년 변화",
      value: signedPct(current?.change1y ?? null),
      tone: toneOf(current?.change1y ?? null),
      sub: guChange1y != null ? `${regionName} ${signedPct(guChange1y)}` : undefined,
    },
    {
      key: "rank",
      label: "시세 순위",
      value: priceRank ? `${priceRank}위` : "—",
      sub: `${dongs.length.toLocaleString("ko-KR")}개 동 중`,
    },
  ];

  return (
    <section
      id={compare ? "market-compare" : "market-dong"}
      aria-label={compare ? `${currentDong} 주변 동 비교` : `${regionName} 동네별 시세`}
      className={`${LAB_SECTION_SURFACE} flex flex-col gap-3`}
    >
      <LabSectionHeader
        title={compare ? "주변 동 비교" : "동네별 시세"}
        meta={asOf ? `공급면적 기준 · ${asOf}` : "공급면적 기준"}
        tip={
          <p>
            {regionName} 안에서 법정동별 시세 평당가와 1년 변화, 최근 1년 매매 거래량을
            비교합니다. 지역 시세 평당가와 같은 방식으로 산출합니다.
            {compare ? " 동을 누르면 그 동의 상세로 이동합니다." : ""}
          </p>
        }
      />
      {compare && !query.isLoading ? (
        current ? (
          <LabStatTiles items={tiles} columns={3} />
        ) : (
          <p className="detail-body">
            이 동은 최근 시세를 계산할 단지가 없어 비교에서 빠졌어요.
          </p>
        )
      ) : null}
      <LabTabs
        variant="secondary"
        ariaLabel="동네별 시세 정렬"
        items={SORTS}
        value={sort}
        onChange={(next) => {
          setSort(next);
          setExpanded(false);
        }}
      />
      {query.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-12 animate-pulse rounded-lg bg-slate-100" />
          ))}
        </div>
      ) : (
        <>
          {guPrice != null ? (
            <p className="detail-meta tabular-nums">
              {regionName} 전체 {guPrice.toLocaleString("ko-KR")}만원/평
            </p>
          ) : null}
          <ol className="flex flex-col divide-y divide-[color:var(--lab-border)]">
            {visible.map(({ d, rank }) => {
              const isCurrent = d.name === currentDong;
              const width =
                sort === "price"
                  ? ((d.pyeongPrice ?? 0) / maxPrice) * 100
                  : sort === "trades"
                    ? (d.tradeCount12m / maxTrades) * 100
                    : (Math.abs(d.change1y ?? 0) / maxAbsChange) * 100;
              const barColor =
                sort === "change" && (d.change1y ?? 0) < 0 ? "var(--lab-change-down)" : BAR;
              const body = (
                <>
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="flex min-w-0 items-baseline gap-2">
                      <span className="detail-meta w-4 shrink-0 text-right tabular-nums">
                        {rank}
                      </span>
                      <span
                        className="detail-data-value-emphasis truncate"
                        style={isCurrent ? { color: "var(--lab-brand-primary)" } : undefined}
                      >
                        {d.name}
                      </span>
                      {isCurrent ? <LabTag>현재 동</LabTag> : null}
                    </p>
                    <p className="shrink-0 whitespace-nowrap tabular-nums">
                      {sort === "trades" ? (
                        <span className="detail-data-value-emphasis">
                          {d.tradeCount12m.toLocaleString("ko-KR")}건
                        </span>
                      ) : (
                        <span className="detail-data-value-emphasis">
                          {(d.pyeongPrice ?? 0).toLocaleString("ko-KR")}만원
                        </span>
                      )}
                      <span className={`detail-meta ml-2 ${pctClass(d.change1y)}`}>
                        {pctText(d.change1y)}
                      </span>
                    </p>
                  </div>
                  <div className="ml-6 flex items-center gap-2">
                    <div
                      className="h-1.5 flex-1 overflow-hidden rounded-full bg-[color:var(--lab-surface-subtle)]"
                      aria-hidden
                    >
                      <div
                        className="h-full rounded-full"
                        style={{ width: `${Math.max(2, width)}%`, background: barColor, opacity: 0.8 }}
                      />
                    </div>
                    <span className="detail-meta shrink-0 whitespace-nowrap tabular-nums">
                      단지 {d.complexCount}곳
                      {sort !== "trades" ? ` · 1년 ${d.tradeCount12m.toLocaleString("ko-KR")}건` : ""}
                    </span>
                  </div>
                </>
              );
              return (
                <li key={d.bjdongCd}>
                  {isCurrent ? (
                    <div className="flex flex-col gap-1.5 py-2.5 pr-6" aria-current="page">
                      {body}
                    </div>
                  ) : (
                    <Link
                      href={regionDongHref(
                        regionSlug,
                        d.name,
                        // 여러 구로 나뉜 시 목록(10자리 코드)은 구를 붙여 같은 이름 동을 구분한다.
                        d.bjdongCd.length === 10
                          ? districtNameFromCode(d.bjdongCd.slice(0, 5)) || undefined
                          : undefined,
                      )}
                      className="lab-row-press relative -mx-2 flex min-h-11 flex-col gap-1.5 rounded-lg px-2 py-2.5 pr-8"
                    >
                      {body}
                      <ChevronRight
                        className="lab-press-arrow absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2"
                        aria-hidden
                      />
                    </Link>
                  )}
                </li>
              );
            })}
          </ol>
          {dongs.length > PREVIEW ? (
            <LabMoreButton
              expanded={expanded}
              onToggle={() => setExpanded((v) => !v)}
              label={`${dongs.length - PREVIEW}개 동 더보기`}
            />
          ) : null}
          {guLink ? <LabTextLink href={guLink.href}>{guLink.label}</LabTextLink> : null}
        </>
      )}
    </section>
  );
}

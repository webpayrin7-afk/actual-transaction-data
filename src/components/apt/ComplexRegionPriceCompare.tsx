"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { InfoTip } from "@/components/ui/InfoTip";
import { LabTabs } from "@/components/ui/LabTabs";
import { LAB_SUBSECTION_RULE, LabSubsectionHeader } from "@/components/ui/LabSection";
import {
  PARTIAL_HISTORY_TIP,
  PRICE_COMPARE_TABS,
  PRICE_COMPARE_TIP,
  PRICE_COMPARE_TIP_TITLE,
  PRICE_COMPARE_TITLE,
  PRICE_COMPARE_UNSUPPORTED_COPY,
  TREND_PERIOD_TABS,
  TREND_SAMPLE_TIP,
  TREND_SAMPLE_TIP_TITLE,
  barWidthPct,
  fetchComplexPricePosition,
  formatSignedPct,
  formatTrendAxisPct,
  formatWonPerPyeong,
  isTrendHorizonUnavailable,
  partialHistoryHelperCopy,
  priceCompareMetaLine,
  priceCompareRowCopy,
  priceCompareScopeLabel,
  priceCompareStatusCopy,
  priceLevelScale,
  trendAbsScale,
  trendBarLayout,
  trendSampleStatusLabel,
  type PriceCompareTab,
  type PriceLevelPublicCell,
  type TrendPeriodId,
  type TrendPublicCell,
} from "@/lib/region-ranking/public";

/** 지역·단지 이름은 회색 라벨이 아니라 데이터 글꼴 (policy §12.2). */
const SCOPE_LABEL_CLASS = "detail-data-value-emphasis min-w-0 truncate";
const PRICE_UNIT = "만원/평";

function formatPriceNumber(value: number | null | undefined): string {
  const text = formatWonPerPyeong(value);
  if (!text) return "—";
  return text.endsWith(PRICE_UNIT) ? text.slice(0, -PRICE_UNIT.length) : text;
}

/** Number 16/600 + unit 13/500 — one non-wrapping bundle. */
function PriceFigure({ value }: { value: number | null | undefined }) {
  const num = formatPriceNumber(value);
  if (num === "—") {
    return <span className="detail-meta shrink-0">—</span>;
  }
  return (
    <span className="inline-flex shrink-0 items-baseline whitespace-nowrap tabular-nums">
      <span className="detail-number text-[color:var(--lab-navy-950)]">{num}</span>
      <span className="detail-meta ml-0.5 font-medium text-[color:var(--lab-muted)]">
        {PRICE_UNIT}
      </span>
    </span>
  );
}

function PercentFigure({
  text,
  tone,
}: {
  text: string;
  tone: "up" | "down" | "flat";
}) {
  const toneClass =
    tone === "up"
      ? "text-[color:var(--lab-change-up)]"
      : tone === "down"
        ? "text-[color:var(--lab-change-down)]"
        : "text-[color:var(--lab-muted)]";
  if (!text.endsWith("%")) {
    return (
      <span
        className={`detail-number whitespace-nowrap tabular-nums ${toneClass}`}
      >
        {text}
      </span>
    );
  }
  return (
    <span
      className={`inline-flex shrink-0 items-baseline whitespace-nowrap tabular-nums ${toneClass}`}
    >
      <span className="text-[1rem] font-semibold leading-6 tracking-[-0.02em]">
        {text.slice(0, -1)}
      </span>
      <span className="ml-px text-[0.8125rem] font-medium leading-5">%</span>
    </span>
  );
}

function usePriceCompareEnter() {
  const ref = useRef<HTMLDivElement>(null);
  const [entered, setEntered] = useState(() =>
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  useEffect(() => {
    const node = ref.current;
    if (!node || entered) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        setEntered(true);
        observer.disconnect();
      },
      { threshold: 0.18, rootMargin: "0px 0px -6% 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [entered]);

  return { ref, entered };
}

function PriceCompareChart({
  replayKey,
  className = "",
  children,
}: {
  replayKey: string;
  className?: string;
  children: (entered: boolean) => ReactNode;
}) {
  const { ref, entered } = usePriceCompareEnter();
  return (
    <div ref={ref} data-chart-key={replayKey} className={className}>
      {children(entered)}
    </div>
  );
}

function barPlayClass(entered: boolean, origin: "left" | "right") {
  return [
    origin === "right" ? "price-compare-bar-left" : "price-compare-bar",
    entered ? "price-compare-bar-play" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function barDelayStyle(index: number) {
  return { ["--bar-delay"]: `${index * 45}ms` } as CSSProperties;
}

function RowHeader({
  scopeLabel,
  accent,
  value,
  /** stack = 가격 수준(이름→가격→bar); inline = 변동률(이름·% 한 줄) */
  layout = "stack",
}: {
  scopeLabel: string;
  accent: boolean;
  value: ReactNode;
  layout?: "stack" | "inline";
}) {
  return (
    <div
      className={
        layout === "inline"
          ? "flex items-baseline justify-between gap-2"
          : "flex flex-col gap-0.5 min-[400px]:flex-row min-[400px]:items-baseline min-[400px]:justify-between min-[400px]:gap-2"
      }
    >
      <span
        className={`${SCOPE_LABEL_CLASS} ${
          accent
            ? "font-medium !text-[color:var(--lab-brand-primary)]"
            : ""
        }`}
        title={scopeLabel}
      >
        {scopeLabel}
      </span>
      {value}
    </div>
  );
}

/**
 * 지역 현황(동네별 시세)과 같은 막대 문법: 행 구분선 + 옅은 트랙 위 채움 막대 + 막대 옆 보조 수치.
 * 이 단지는 브랜드 청록, 비교 지역은 같은 계열을 옅게.
 */
const BAR_TRACK = "h-2 rounded-full bg-[color:var(--lab-surface-subtle)]";
const BAR_FILL = "h-2 rounded-full";
const BAR_COLOR = "var(--lab-brand-primary)";
const ROW = "flex flex-col gap-1.5 py-2.5";

function PriceLevelBars({
  cells,
  aptName,
  animate,
}: {
  cells: PriceLevelPublicCell[];
  aptName: string | null;
  animate: boolean;
}) {
  const scale = priceLevelScale(
    cells.map((cell) => ({
      status: cell.status,
      value: cell.meanPricePerSupplyPyeong,
    })),
  );
  return (
    <ul className="flex flex-col divide-y divide-[color:var(--lab-border)]">
      {cells.map((cell, index) => {
        const hiddenBar = cell.status !== "ok";
        const value = cell.meanPricePerSupplyPyeong;
        const width = hiddenBar ? 0 : barWidthPct(value, scale);
        const accent = cell.scope === "COMPLEX";
        const scopeLabel = priceCompareScopeLabel({
          scope: cell.scope,
          label: cell.label,
          aptName,
        });
        return (
          <li key={cell.scope} className={ROW}>
            <RowHeader
              scopeLabel={scopeLabel}
              accent={accent}
              layout="inline"
              value={
                hiddenBar ? (
                  <span className="detail-meta shrink-0 text-right">
                    {priceCompareRowCopy(cell.status)}
                  </span>
                ) : (
                  <PriceFigure value={value} />
                )
              }
            />
            <div className={`${BAR_TRACK} min-w-0 overflow-hidden`} aria-hidden>
              {!hiddenBar && width > 0 ? (
                <div
                  className={`${BAR_FILL} ${barPlayClass(animate, "left")}`}
                  style={{
                    width: `${Math.max(2, width)}%`,
                    background: BAR_COLOR,
                    opacity: accent ? 1 : 0.35,
                    ...barDelayStyle(index),
                  }}
                />
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function TrendScale({ maxAbs }: { maxAbs: number }) {
  const label = formatTrendAxisPct(maxAbs);
  return (
    <div className="detail-micro mb-1.5 flex items-center justify-between tabular-nums">
      <span>-{label}%</span>
      <span>0</span>
      <span>+{label}%</span>
    </div>
  );
}

function TrendBars({
  cells,
  maxAbs,
  aptName,
  animate,
}: {
  cells: TrendPublicCell[];
  maxAbs: number | null;
  aptName: string | null;
  animate: boolean;
}) {
  return (
    <div>
      {maxAbs != null && maxAbs > 0 ? <TrendScale maxAbs={maxAbs} /> : null}
      <ul className="flex flex-col divide-y divide-[color:var(--lab-border)]">
        {cells.map((cell, index) => {
          const unavailable = isTrendHorizonUnavailable(cell);
          const value = cell.changePercent;
          const layout = unavailable
            ? { side: "none" as const, pct: 0 }
            : trendBarLayout(value, maxAbs);
          const up = !unavailable && value != null && value > 0;
          const down = !unavailable && value != null && value < 0;
          const flat = !unavailable && value != null && value === 0;
          const tone = up ? "up" : down ? "down" : "flat";
          const sampleLabel = unavailable
            ? null
            : trendSampleStatusLabel({
                scope: cell.scope,
                sampleStatus: cell.sampleStatus,
              });
          const scopeLabel = priceCompareScopeLabel({
            scope: cell.scope,
            label: cell.label,
            aptName,
          });
          return (
            <li key={cell.scope} className={ROW}>
              <RowHeader
                scopeLabel={scopeLabel}
                accent={cell.scope === "COMPLEX"}
                layout="inline"
                value={
                  unavailable ? (
                    <p className="detail-meta shrink-0 text-right">
                      {cell.status != null && cell.status !== "ok"
                        ? priceCompareRowCopy(cell.status)
                        : "—"}
                    </p>
                  ) : (
                    <div className="flex shrink-0 flex-col items-end gap-0">
                      <PercentFigure
                        text={formatSignedPct(value) ?? "—"}
                        tone={tone}
                      />
                      {sampleLabel ? (
                        <InfoTip
                          aria-label={sampleLabel}
                          className="detail-meta hover:text-[color:var(--lab-navy-700)]"
                          trigger={<span>{sampleLabel}</span>}
                        >
                          <p className="font-medium text-slate-800">
                            {TREND_SAMPLE_TIP_TITLE}
                          </p>
                          {TREND_SAMPLE_TIP.split("\n\n").map((paragraph) => (
                            <p key={paragraph} className="mt-1.5 first:mt-1">
                              {paragraph}
                            </p>
                          ))}
                        </InfoTip>
                      ) : null}
                    </div>
                  )
                }
              />
              {!unavailable ? (
                <div className={`relative flex ${BAR_TRACK} min-w-0 items-center`} aria-hidden>
                  {/* 가운데 기준선에 딱 붙는 쪽은 각지게, 바깥 끝만 둥글게. */}
                  <div className="flex h-2 w-1/2 justify-end">
                    {layout.side === "left" ? (
                      <div
                        className={`h-2 rounded-l-full rounded-r-none bg-[color:var(--lab-change-down)] ${barPlayClass(animate, "right")}`}
                        style={{
                          width: `${layout.pct}%`,
                          opacity: cell.scope === "COMPLEX" ? 1 : 0.55,
                          ...barDelayStyle(index),
                        }}
                      />
                    ) : null}
                  </div>
                  <div
                    className="absolute left-1/2 z-10 h-3.5 w-px -translate-x-1/2 bg-[color:var(--lab-muted)]"
                    aria-hidden
                  />
                  <div className="flex h-2 w-1/2 justify-start">
                    {layout.side === "right" ? (
                      <div
                        className={`h-2 rounded-l-none rounded-r-full bg-[color:var(--lab-change-up)] ${barPlayClass(animate, "left")}`}
                        style={{
                          width: `${layout.pct}%`,
                          opacity: cell.scope === "COMPLEX" ? 1 : 0.55,
                          ...barDelayStyle(index),
                        }}
                      />
                    ) : null}
                  </div>
                  {flat ? (
                    <span className="sr-only">변동 없음 0%</span>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function ComplexRegionPriceCompare({
  complexId,
  aptName,
  exclusiveArea,
  marketPyeongLabel,
}: {
  complexId: string;
  aptName?: string | null;
  exclusiveArea: number | null;
  marketPyeongLabel: number | null;
}) {
  const [tab, setTab] = useState<PriceCompareTab>("level");
  const [period, setPeriod] = useState<TrendPeriodId>("6M");
  const enabled =
    exclusiveArea != null &&
    Number.isFinite(exclusiveArea) &&
    exclusiveArea > 0 &&
    marketPyeongLabel != null &&
    marketPyeongLabel > 0;

  const query = useQuery({
    queryKey: ["complex-region-price-position-v231", complexId, exclusiveArea, marketPyeongLabel],
    queryFn: () =>
      fetchComplexPricePosition({
        complexId,
        exclusiveArea: exclusiveArea!,
        marketPyeongLabel: marketPyeongLabel!,
      }),
    enabled,
    staleTime: 5 * 60_000,
    retry: 1,
  });

  const data = query.data;
  const resolvedAptName = data?.aptName?.trim() || aptName?.trim() || null;
  const unsupported = !enabled || data?.status === "PRICE_COMPARE_UNSUPPORTED_AREA";
  const periodLabel = TREND_PERIOD_TABS.find((item) => item.id === period)?.label ?? "";
  const meta = priceCompareMetaLine({
    supplyPyeongCohort: data?.supplyPyeongCohort ?? null,
    referenceMonth: data?.referenceMonth ?? null,
  });
  const trendCells = data?.trends[period] ?? [];
  const trendScale = trendAbsScale(trendCells);
  const historyHelper = partialHistoryHelperCopy({
    horizonLabel: periodLabel,
    cells: trendCells,
  });
  const chartKey = [
    tab,
    tab === "trend" ? period : "level",
    data?.version ?? "",
    data?.referenceMonth ?? "",
    query.isSuccess ? "ready" : "wait",
  ].join("|");
  return (
    <div className={LAB_SUBSECTION_RULE}>
      <LabSubsectionHeader
        title={PRICE_COMPARE_TITLE}
        meta={meta ? <span className="break-keep">{meta}</span> : undefined}
        tip={
          <>
            <p className="font-medium text-slate-800">{PRICE_COMPARE_TIP_TITLE}</p>
            {PRICE_COMPARE_TIP.split("\n\n").map((paragraph) => (
              <p key={paragraph} className="mt-1.5 first:mt-1">
                {paragraph}
              </p>
            ))}
          </>
        }
      />

      {!enabled || unsupported ? (
        <p className="detail-meta mt-1.5">
          {PRICE_COMPARE_UNSUPPORTED_COPY}
        </p>
      ) : (
        <>
          <LabTabs
            className="mt-3"
            variant="secondary"
            ariaLabel="가격 비교"
            value={tab}
            items={PRICE_COMPARE_TABS}
            onChange={setTab}
          />

          {tab === "trend" ? (
            <LabTabs
              className="mt-1.5 w-full"
              variant="compact"
              ariaLabel="변동률 기간"
              equalWidth
              value={period}
              items={TREND_PERIOD_TABS}
              onChange={setPeriod}
            />
          ) : null}

          {tab === "trend" && historyHelper ? (
            <p className="detail-meta mt-1 inline-flex items-center">
              <span>{historyHelper}</span>
              <InfoTip aria-label="일부 기간 기준 안내" className="detail-meta">
                <p>{PARTIAL_HISTORY_TIP}</p>
              </InfoTip>
            </p>
          ) : null}

          <PriceCompareChart key={chartKey} replayKey={chartKey} className="mt-2">
            {(entered) =>
              query.isLoading ? (
                <div className="space-y-1.5" aria-label="가격 비교 불러오는 중">
                  <div className="h-5 animate-pulse rounded-lg bg-slate-100" />
                  <div className="h-5 animate-pulse rounded-lg bg-slate-100" />
                  <div className="h-5 animate-pulse rounded-lg bg-slate-100" />
                  <div className="h-5 animate-pulse rounded-lg bg-slate-100" />
                </div>
              ) : query.isError ? (
                <div className="rounded-xl bg-slate-50 px-3 py-2.5 text-center">
                  <p className="detail-body font-medium text-[color:var(--lab-navy-950)]">
                    가격 비교를 불러오지 못했습니다.
                  </p>
                  <button
                    type="button"
                    onClick={() => void query.refetch()}
                    className="lab-button lab-button-secondary mt-2 px-4"
                  >
                    다시 시도
                  </button>
                </div>
              ) : data?.status === "unavailable" ? (
                <p className="detail-meta">
                  {priceCompareStatusCopy("unavailable").title}
                </p>
              ) : tab === "level" ? (
                data?.priceLevel.length ? (
                  <PriceLevelBars
                    cells={data.priceLevel}
                    aptName={resolvedAptName}
                    animate={entered}
                  />
                ) : (
                  <p className="detail-meta">
                    {priceCompareStatusCopy(data?.status).title}
                  </p>
                )
              ) : trendCells.length ? (
                <TrendBars
                  cells={trendCells}
                  maxAbs={trendScale}
                  aptName={resolvedAptName}
                  animate={entered}
                />
              ) : (
                <p className="detail-meta">
                  {priceCompareStatusCopy(data?.status).title}
                </p>
              )
            }
          </PriceCompareChart>
        </>
      )}
    </div>
  );
}

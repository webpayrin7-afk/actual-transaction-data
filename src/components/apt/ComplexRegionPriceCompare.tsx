"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { InfoTip } from "@/components/ui/InfoTip";
import { labSecondaryTabClass, labSegmentedClass } from "@/components/ui/lab";
import {
  PRICE_COMPARE_TABS,
  PRICE_COMPARE_UNSUPPORTED_COPY,
  COMPLEX_EXACT_TIP,
  PRICE_LEVEL_TIP,
  TREND_PERIOD_TABS,
  TREND_TIP,
  barWidthPct,
  fetchComplexPricePosition,
  formatSignedPct,
  formatWonPerPyeong,
  priceCompareRowCopy,
  priceCompareStatusCopy,
  priceLevelScale,
  selectedPyeongCompareLines,
  trendAbsScale,
  trendBarLayout,
  trendHorizonFallbackNotes,
  type PriceCompareTab,
  type PriceLevelPublicCell,
  type TrendPeriodId,
  type TrendPublicCell,
} from "@/lib/region-ranking/public";

function PriceLevelBars({ cells }: { cells: PriceLevelPublicCell[] }) {
  const scale = priceLevelScale(
    cells.map((cell) => ({
      status: cell.status,
      value: cell.meanPricePerSupplyPyeong,
    })),
  );
  return (
    <ul className="mt-2 space-y-2">
      {cells.map((cell) => {
        const hiddenBar = cell.status !== "ok";
        const value = cell.meanPricePerSupplyPyeong;
        const width = hiddenBar ? 0 : barWidthPct(value, scale);
        const accent = cell.scope === "COMPLEX";
        return (
          <li key={cell.scope} className="flex items-center gap-2.5">
            <span
              className={`w-12 shrink-0 truncate text-[13px] leading-4 ${
                accent ? "font-medium text-teal-700" : "text-slate-600"
              }`}
            >
              {cell.label}
            </span>
            <div className="min-w-0 flex-1">
              {hiddenBar || width <= 0 ? (
                <div className="h-2" />
              ) : (
                <div
                  className={`h-2 rounded-full ${accent ? "bg-teal-600" : "bg-slate-300"}`}
                  style={{ width: `${width}%` }}
                />
              )}
            </div>
            <span
              className={`w-[7.5rem] shrink-0 whitespace-nowrap text-right text-[12px] leading-4 tabular-nums sm:w-36 sm:text-[13px] ${
                hiddenBar
                  ? "text-slate-500"
                  : accent
                    ? "font-semibold text-slate-900"
                    : "text-slate-600"
              }`}
            >
              {hiddenBar ? priceCompareRowCopy(cell.status) : formatWonPerPyeong(value) ?? "—"}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function TrendScale({ maxAbs }: { maxAbs: number }) {
  const label = formatSignedPct(maxAbs)?.replace("+", "") ?? `${maxAbs}%`;
  return (
    <div className="mb-1 flex items-center gap-2 text-[11px] tabular-nums text-slate-400">
      <span className="w-12 shrink-0" />
      <div className="flex min-w-0 flex-1 justify-between">
        <span>-{label}</span>
        <span>0</span>
        <span>+{label}</span>
      </div>
      <span className="w-14 shrink-0 sm:w-16" />
    </div>
  );
}

function TrendBars({
  cells,
  maxAbs,
}: {
  cells: TrendPublicCell[];
  maxAbs: number | null;
}) {
  return (
    <div className="mt-2">
      {maxAbs != null && maxAbs > 0 ? <TrendScale maxAbs={maxAbs} /> : null}
      <ul className="space-y-2">
        {cells.map((cell) => {
          const hiddenBar = cell.status !== "ok";
          const value = cell.changePercent;
          const layout = hiddenBar ? { side: "none" as const, pct: 0 } : trendBarLayout(value, maxAbs);
          const up = !hiddenBar && value != null && value > 0;
          const down = !hiddenBar && value != null && value < 0;
          return (
            <li key={cell.scope} className="flex items-center gap-2.5">
              <span
                className={`w-12 shrink-0 truncate text-[13px] leading-4 ${
                  cell.scope === "COMPLEX" ? "font-medium text-teal-700" : "text-slate-600"
                }`}
              >
                {cell.label}
              </span>
              {hiddenBar ? (
                <p className="min-w-0 flex-1 text-[12px] leading-4 text-slate-500">
                  {priceCompareRowCopy(cell.status)}
                </p>
              ) : (
                <>
                  <div className="relative flex h-5 min-w-0 flex-1 items-center">
                    <div className="flex h-2 w-1/2 justify-end pr-px">
                      {layout.side === "left" ? (
                        <div
                          className="h-2 rounded-l-full bg-blue-600"
                          style={{ width: `${layout.pct}%` }}
                        />
                      ) : null}
                    </div>
                    <div
                      className="absolute left-1/2 h-5 w-px -translate-x-1/2 bg-slate-300"
                      aria-hidden
                    />
                    <div className="flex h-2 w-1/2 justify-start pl-px">
                      {layout.side === "right" ? (
                        <div
                          className="h-2 rounded-r-full bg-rose-600"
                          style={{ width: `${layout.pct}%` }}
                        />
                      ) : null}
                    </div>
                  </div>
                  <span
                    className={`w-14 shrink-0 whitespace-nowrap text-right text-[12px] tabular-nums sm:w-16 sm:text-[13px] ${
                      up ? "font-medium text-rose-600" : down ? "font-medium text-blue-600" : "text-slate-500"
                    }`}
                  >
                    {formatSignedPct(value) ?? "—"}
                  </span>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function ComplexRegionPriceCompare({
  complexId,
  exclusiveArea,
  marketPyeongLabel,
  selectedPyeongLabel,
}: {
  complexId: string;
  exclusiveArea: number | null;
  marketPyeongLabel: number | null;
  selectedPyeongLabel: string | null;
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
    queryKey: ["complex-region-price-position-v21", complexId, exclusiveArea, marketPyeongLabel],
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
  const unsupported = !enabled || data?.status === "PRICE_COMPARE_UNSUPPORTED_AREA";
  const lines = selectedPyeongCompareLines({
    selectedPyeongLabel,
    selectedMarketPyeongLabel: marketPyeongLabel ?? data?.selectedMarketPyeongLabel ?? null,
    supplyPyeongCohort: data?.supplyPyeongCohort ?? null,
    referenceMonth: data?.referenceMonth ?? null,
  });
  const trendCells = data?.trends[period] ?? [];
  const trendScale = trendAbsScale(trendCells);
  const priceTip = data?.methodologyCopy.price ?? PRICE_LEVEL_TIP;
  const trendTip = data?.methodologyCopy.trend ?? TREND_TIP;
  const fallbackNotes = trendHorizonFallbackNotes(trendCells);

  return (
    <div className="mt-3 border-t border-slate-200 pt-3">
      <div className="flex flex-nowrap items-center gap-1">
        <h3 className="text-[13px] font-medium leading-5 text-slate-600">
          지역 가격 비교
        </h3>
        <span className="text-[11px] text-slate-400">평당가</span>
        <InfoTip aria-label={tab === "level" ? "평당가 비교 안내" : "실거래 가격 변동 안내"}>
          <p>{tab === "level" ? priceTip : trendTip}</p>
          <p className="mt-1">{COMPLEX_EXACT_TIP}</p>
          {tab === "trend" && fallbackNotes.length > 0 ? (
            <p className="mt-1 text-slate-500">
              {fallbackNotes.join(" · ")}
            </p>
          ) : null}
        </InfoTip>
      </div>

      {!enabled || unsupported ? (
        <p className="mt-1.5 text-[13px] leading-5 text-slate-500">
          {PRICE_COMPARE_UNSUPPORTED_COPY}
        </p>
      ) : (
        <>
          <div
            className={`${labSegmentedClass("mt-2 !flex-nowrap !gap-1")} w-full`}
            role="tablist"
            aria-label="지역 가격 비교"
          >
            {PRICE_COMPARE_TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={tab === item.id}
                onClick={() => setTab(item.id)}
                className={labSecondaryTabClass(
                  tab === item.id,
                  "!h-7 min-h-7 min-w-0 flex-1 !px-1.5 whitespace-nowrap text-[12px]",
                )}
              >
                {item.label}
              </button>
            ))}
          </div>

          {lines.line1 ? (
            <p className="mt-1.5 text-[12px] leading-4 text-slate-500">
              {lines.line1}
              {lines.line2 ? (
                <>
                  <span className="mx-1 text-slate-300">·</span>
                  {lines.line2}
                </>
              ) : null}
            </p>
          ) : null}

          {tab === "trend" ? (
            <div
              className={`${labSegmentedClass("mt-1.5 !flex-nowrap !gap-1")} w-full`}
              role="tablist"
              aria-label="변동률 기간"
            >
              {TREND_PERIOD_TABS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={period === item.id}
                  onClick={() => setPeriod(item.id)}
                  className={labSecondaryTabClass(
                    period === item.id,
                    "!h-7 min-h-7 min-w-0 flex-1 !px-1 whitespace-nowrap text-[12px]",
                  )}
                >
                  {item.label}
                </button>
              ))}
            </div>
          ) : null}

          {query.isLoading ? (
            <div className="mt-2 space-y-1.5" aria-label="가격 비교 불러오는 중">
              <div className="h-7 animate-pulse rounded-lg bg-slate-100" />
              <div className="h-7 animate-pulse rounded-lg bg-slate-100" />
              <div className="h-7 animate-pulse rounded-lg bg-slate-100" />
              <div className="h-7 animate-pulse rounded-lg bg-slate-100" />
            </div>
          ) : query.isError ? (
            <div className="mt-2 rounded-xl bg-slate-50 px-3 py-2.5 text-center">
              <p className="text-sm font-medium text-slate-700">
                가격 비교를 불러오지 못했습니다.
              </p>
              <button
                type="button"
                onClick={() => void query.refetch()}
                className="lab-button lab-button-secondary mt-2 !min-h-9 px-4 text-[13px]"
              >
                다시 시도
              </button>
            </div>
          ) : data?.status === "unavailable" ? (
            <p className="mt-2 text-[13px] leading-5 text-slate-500">
              {priceCompareStatusCopy("unavailable").title}
            </p>
          ) : tab === "level" ? (
            data?.priceLevel.length ? (
              <PriceLevelBars cells={data.priceLevel} />
            ) : (
              <p className="mt-2 text-[13px] leading-5 text-slate-500">
                {priceCompareStatusCopy(data?.status).title}
              </p>
            )
          ) : trendCells.length ? (
            <TrendBars cells={trendCells} maxAbs={trendScale} />
          ) : (
            <p className="mt-2 text-[13px] leading-5 text-slate-500">
              {priceCompareStatusCopy(data?.status).title}
            </p>
          )}
        </>
      )}
    </div>
  );
}

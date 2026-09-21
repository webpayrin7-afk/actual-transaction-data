"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { InfoTip } from "@/components/ui/InfoTip";
import { labSecondaryTabClass, labSegmentedClass } from "@/components/ui/lab";
import {
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
  formatWonPerPyeong,
  partialHistoryHelperCopy,
  priceCompareMetaLine,
  priceCompareRowCopy,
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
          const sampleLabel = trendSampleStatusLabel({
            scope: cell.scope,
            sampleStatus: cell.sampleStatus,
          });
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
                  <div className="flex w-14 shrink-0 flex-col items-end sm:w-16">
                    <span
                      className={`whitespace-nowrap text-right text-[12px] tabular-nums sm:text-[13px] ${
                        up ? "font-medium text-rose-600" : down ? "font-medium text-blue-600" : "text-slate-500"
                      }`}
                    >
                      {formatSignedPct(value) ?? "—"}
                    </span>
                    {sampleLabel ? (
                      <InfoTip
                        aria-label={sampleLabel}
                        className="mt-0.5 !text-[10px] !leading-4 text-slate-500 hover:text-slate-600"
                        trigger={<span>{sampleLabel}</span>}
                      >
                        <p className="font-medium text-slate-800">{TREND_SAMPLE_TIP_TITLE}</p>
                        {TREND_SAMPLE_TIP.split("\n\n").map((paragraph) => (
                          <p key={paragraph} className="mt-1.5 first:mt-1">
                            {paragraph}
                          </p>
                        ))}
                      </InfoTip>
                    ) : null}
                  </div>
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
}: {
  complexId: string;
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
    queryKey: ["complex-region-price-position-v23", complexId, exclusiveArea, marketPyeongLabel],
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
  const meta = priceCompareMetaLine({
    supplyPyeongCohort: data?.supplyPyeongCohort ?? null,
    referenceMonth: data?.referenceMonth ?? null,
  });
  const trendCells = data?.trends[period] ?? [];
  const trendScale = trendAbsScale(trendCells);
  const periodLabel = TREND_PERIOD_TABS.find((item) => item.id === period)?.label ?? "";
  const historyHelper = partialHistoryHelperCopy({
    horizonLabel: periodLabel,
    cells: trendCells,
  });

  return (
    <div className="mt-4 border-t border-slate-200 pt-3.5">
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5">
        <div className="flex min-w-0 items-center gap-1">
          <h3 className="text-[13px] font-semibold leading-5 text-slate-800">
            {PRICE_COMPARE_TITLE}
          </h3>
          <InfoTip aria-label="가격 비교 안내">
            <p className="font-medium text-slate-800">{PRICE_COMPARE_TIP_TITLE}</p>
            {PRICE_COMPARE_TIP.split("\n\n").map((paragraph) => (
              <p key={paragraph} className="mt-1.5 first:mt-1">
                {paragraph}
              </p>
            ))}
          </InfoTip>
        </div>
        {meta ? (
          <p className="min-w-0 text-right text-[11px] leading-4 text-slate-500">
            {meta}
          </p>
        ) : null}
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
            aria-label="가격 비교"
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

          {tab === "trend" && historyHelper ? (
            <p className="mt-1.5 text-[11px] leading-4 text-slate-500">{historyHelper}</p>
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

"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { BackLink } from "@/components/layout/BackLink";
import { PAGE_SHELL, PageHeader } from "@/components/layout/PageHeader";
import { AptAreaSelector } from "@/components/apt/AptAreaSelector";
import { labPrimaryTabClass } from "@/components/ui/lab";
import type { AptDetailResponse } from "@/lib/molit/apt-client";
import {
  isValidAreaKey,
  normalizeAreaKey,
  resolveDefaultAreaKey,
} from "@/lib/apt/default-area";
import {
  calculateHoldingTax,
  calculateLoanEstimate,
  calculatePurchaseCost,
  formatEokMan,
  formatManWon,
  type AcquisitionHomeStatus,
} from "@/lib/calculator";

type TabId = "purchase" | "holding" | "loan";

const TABS: { id: TabId; label: string }[] = [
  { id: "purchase", label: "매수비용" },
  { id: "holding", label: "보유세" },
  { id: "loan", label: "대출" },
];

const inputClass = "lab-input w-full text-sm tabular-nums";

async function fetchAptDetail(
  aptName: string,
  region: string,
  gu?: string,
): Promise<AptDetailResponse> {
  const qs = new URLSearchParams({
    aptName,
    region,
    months: "120",
  });
  if (gu?.trim()) qs.set("gu", gu.trim());
  const res = await fetch(`/api/apt-detail?${qs.toString()}`);
  if (!res.ok) throw new Error("failed");
  return res.json();
}

function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-slate-600">{label}</span>
      {children}
      {hint ? (
        <span className="block text-[11px] text-slate-400">{hint}</span>
      ) : null}
    </label>
  );
}

function ResultRow({
  label,
  value,
  emph,
}: {
  label: string;
  value: string;
  emph?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-slate-500">{label}</dt>
      <dd
        className={`tabular-nums ${
          emph
            ? "text-base font-bold text-slate-900"
            : "font-semibold text-slate-800"
        }`}
      >
        {value}
      </dd>
    </div>
  );
}

function Notes({ lines }: { lines: string[] }) {
  const cleaned = lines.map((l) => l.trim()).filter(Boolean);
  if (!cleaned.length) return null;
  return (
    <ul className="space-y-1 border-t border-slate-100 pt-3 text-[11px] leading-relaxed text-slate-400">
      {cleaned.map((line) => (
        <li key={line}>· {line}</li>
      ))}
    </ul>
  );
}

export function AptCalculatorPage({
  aptName,
  regionSlug,
  gu,
  initialAreaKey,
  initialPriceMan,
  initialTab,
}: {
  aptName: string;
  regionSlug: string;
  gu?: string;
  initialAreaKey?: string;
  initialPriceMan?: number;
  initialTab?: TabId;
}) {
  const detailQ = useQuery({
    queryKey: ["apt-detail-calc", aptName, regionSlug, gu ?? ""],
    queryFn: () => fetchAptDetail(aptName, regionSlug, gu),
  });
  const data = detailQ.data;

  const [tab, setTab] = useState<TabId>(initialTab ?? "purchase");
  const [areaOverride, setAreaOverride] = useState<string | null>(null);
  const [priceMan, setPriceMan] = useState(initialPriceMan ?? 0);
  const [priceTouched, setPriceTouched] = useState(
    Boolean(initialPriceMan && initialPriceMan > 0),
  );
  const [homeStatus, setHomeStatus] =
    useState<AcquisitionHomeStatus>("one_home");

  const [officialPriceMan, setOfficialPriceMan] = useState(0);
  const [singleHomeHousehold, setSingleHomeHousehold] = useState(true);
  const [projectionYears, setProjectionYears] = useState(0);
  const [growthPct, setGrowthPct] = useState(3);

  const [cashMan, setCashMan] = useState(0);
  const [annualIncomeMan, setAnnualIncomeMan] = useState(8000);
  const [existingMonthlyMan, setExistingMonthlyMan] = useState(0);
  const [years, setYears] = useState(30);
  const [baseRatePct, setBaseRatePct] = useState(4);
  const [metro, setMetro] = useState<"capital" | "local">("capital");
  const [regulated, setRegulated] = useState<"regulated" | "unregulated">(
    "regulated",
  );
  const [homes, setHomes] = useState<"0" | "1" | "2plus">("0");
  const [firstHome, setFirstHome] = useState(true);
  const [disposeCondition, setDisposeCondition] = useState(false);

  const resolvedAreaKey = useMemo(() => {
    if (!data?.areas?.length) return initialAreaKey ?? "all";
    if (initialAreaKey && isValidAreaKey(initialAreaKey, data.areas)) {
      return initialAreaKey;
    }
    return resolveDefaultAreaKey(data.areas, data.items);
  }, [data, initialAreaKey]);

  const areaKey = areaOverride ?? resolvedAreaKey;

  const areaFiltered = useMemo(() => {
    if (!data) return [];
    if (areaKey === "all") return data.items;
    const selected = data.areas.find((a) => a.key === areaKey);
    if (
      selected?.selectorKind === "market_group" &&
      selected.exclusiveAreaMin != null &&
      selected.exclusiveAreaMax != null
    ) {
      const min = selected.exclusiveAreaMin - 0.005;
      const max = selected.exclusiveAreaMax + 0.005;
      return data.items.filter((item) => {
        const area = Number(item.exclusiveArea);
        return area >= min && area <= max;
      });
    }
    const matchKey = selected
      ? normalizeAreaKey(selected.exclusiveArea)
      : areaKey;
    return data.items.filter(
      (item) => normalizeAreaKey(Number(item.exclusiveArea)) === matchKey,
    );
  }, [data, areaKey]);

  const latestTradeMan = useMemo(() => {
    const trades = areaFiltered
      .filter((i) => i.dealType === "trade")
      .sort((a, b) => (a.dealDate < b.dealDate ? 1 : -1));
    return trades[0]?.dealAmount ?? 0;
  }, [areaFiltered]);

  const effectivePriceMan =
    priceTouched || priceMan > 0
      ? priceMan
      : latestTradeMan > 0
        ? latestTradeMan
        : 0;

  const purchase = useMemo(
    () =>
      effectivePriceMan > 0
        ? calculatePurchaseCost({
            priceMan: effectivePriceMan,
            homeStatus,
          })
        : null,
    [effectivePriceMan, homeStatus],
  );

  const holding = useMemo(
    () =>
      officialPriceMan > 0
        ? calculateHoldingTax({
            officialPriceMan,
            singleHomeHousehold,
            includeUrbanShare: true,
            projectionYears,
            officialPriceGrowthRate: growthPct / 100,
          })
        : null,
    [officialPriceMan, singleHomeHousehold, projectionYears, growthPct],
  );

  const loan = useMemo(
    () =>
      effectivePriceMan > 0
        ? calculateLoanEstimate({
            priceMan: effectivePriceMan,
            cashMan,
            annualIncomeMan,
            existingMonthlyMan,
            years,
            baseRatePct,
            metro,
            regulated,
            homes,
            firstHome,
            disposeCondition,
            repayMethod: "equal_payment",
          })
        : null,
    [
      effectivePriceMan,
      cashMan,
      annualIncomeMan,
      existingMonthlyMan,
      years,
      baseRatePct,
      metro,
      regulated,
      homes,
      firstHome,
      disposeCondition,
    ],
  );

  const detailHref = useMemo(() => {
    const qs = new URLSearchParams({ region: regionSlug, area: areaKey });
    if (gu?.trim()) qs.set("gu", gu.trim());
    return `/apt/${encodeURIComponent(aptName)}?${qs.toString()}`;
  }, [aptName, regionSlug, gu, areaKey]);

  const selectedArea = data?.areas.find((a) => a.key === areaKey) ?? null;

  return (
    <div className={`${PAGE_SHELL} max-w-5xl overflow-x-clip`}>
      <PageHeader
        leading={<BackLink fallback={detailHref} compact hideLabel />}
        title="대출·세금 계산"
        description={aptName}
        meta={
          <p className="text-xs text-slate-500">
            단지에서 선택한 면적을 이어받습니다. 입력값은 이 기기에만 유지되며
            서버에 저장하지 않습니다.
          </p>
        }
      />

      <section className="lab-card space-y-3 p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-900">
            면적 · 예상 매수가
          </h2>
          <Link
            href={detailHref}
            className="text-xs font-medium text-teal-700 hover:underline"
          >
            단지상세로
          </Link>
        </div>
        {data ? (
          <AptAreaSelector
            areas={data.areas}
            value={areaKey}
            onChange={setAreaOverride}
          />
        ) : (
          <div className="h-10 animate-pulse rounded-lg bg-slate-100" />
        )}
        <Field
          label="예상 매수가"
          hint={
            latestTradeMan > 0
              ? `선택 면적 최근 매매 ${formatEokMan(latestTradeMan)}`
              : "최근 매매가가 없으면 직접 입력하세요"
          }
        >
          <div className="flex flex-wrap items-center gap-2">
            <input
              className={inputClass}
              inputMode="decimal"
              value={
                effectivePriceMan > 0
                  ? String(effectivePriceMan / 10_000)
                  : ""
              }
              placeholder="억 단위 (예: 34.1)"
              onChange={(e) => {
                setPriceTouched(true);
                const v = e.target.value.replace(/,/g, "");
                if (!v) {
                  setPriceMan(0);
                  return;
                }
                const eok = Number(v);
                if (Number.isFinite(eok) && eok >= 0) {
                  setPriceMan(Math.round(eok * 10_000));
                }
              }}
            />
            <span className="text-sm text-slate-500">억</span>
            {latestTradeMan > 0 ? (
              <button
                type="button"
                className="lab-button lab-button-secondary h-9 px-2.5 text-xs"
                onClick={() => {
                  setPriceMan(latestTradeMan);
                  setPriceTouched(false);
                }}
              >
                최근 거래가로 재설정
              </button>
            ) : null}
          </div>
          <p className="mt-1 text-sm font-semibold tabular-nums text-slate-800">
            {effectivePriceMan > 0 ? formatEokMan(effectivePriceMan) : "—"}
          </p>
        </Field>
        {selectedArea ? (
          <p className="text-xs text-slate-500">선택: {selectedArea.label}</p>
        ) : null}
      </section>

      <div
        className="mt-3 flex w-full gap-1 overflow-x-auto"
        role="tablist"
        aria-label="계산 메뉴"
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={labPrimaryTabClass(tab === t.id, "min-w-0 flex-1")}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "purchase" ? (
        <section className="lab-card mt-3 space-y-4 p-4 sm:p-5">
          <Field label="주택 보유 가정">
            <div className="flex flex-wrap gap-2">
              {(
                [
                  ["one_home", "1주택(일반)"],
                  ["multi_heavy", "다주택 중과(단순)"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={labPrimaryTabClass(homeStatus === id, "text-xs")}
                  onClick={() => setHomeStatus(id)}
                >
                  {label}
                </button>
              ))}
            </div>
          </Field>
          {purchase ? (
            <dl className="space-y-2 text-sm">
              <ResultRow
                label="예상 매수가"
                value={formatEokMan(purchase.priceMan)}
              />
              <ResultRow
                label={`취득세 (${purchase.acquisition.appliedRateLabel})`}
                value={formatManWon(purchase.acquisition.totalTaxMan)}
              />
              <ResultRow
                label={`중개보수 상한 (${purchase.brokerage.ratePct.toFixed(1)}%)`}
                value={formatManWon(purchase.brokerage.feeMan)}
              />
              <ResultRow
                label="예상 총 매수비용"
                value={formatEokMan(purchase.totalCostMan)}
                emph
              />
            </dl>
          ) : (
            <p className="text-sm text-slate-500">
              매수가를 입력하면 결과가 표시됩니다.
            </p>
          )}
          <Notes
            lines={[
              ...(purchase?.acquisition.notes ?? []),
              ...(purchase?.brokerage.notes ?? []),
              `규칙: ${purchase?.acquisition.meta.ruleVersion ?? "—"} / ${purchase?.brokerage.meta.ruleVersion ?? "—"}`,
            ]}
          />
        </section>
      ) : null}

      {tab === "holding" ? (
        <section className="lab-card mt-3 space-y-4 p-4 sm:p-5">
          <Field
            label="공시가격 (직접 입력)"
            hint="공식 공시가가 없으면 직접 입력하세요. 실거래가 비율로 추정하지 않습니다."
          >
            <div className="flex items-center gap-2">
              <input
                className={inputClass}
                inputMode="decimal"
                value={
                  officialPriceMan > 0
                    ? String(officialPriceMan / 10_000)
                    : ""
                }
                placeholder="억 단위"
                onChange={(e) => {
                  const v = e.target.value.replace(/,/g, "");
                  if (!v) {
                    setOfficialPriceMan(0);
                    return;
                  }
                  const eok = Number(v);
                  if (Number.isFinite(eok) && eok >= 0) {
                    setOfficialPriceMan(Math.round(eok * 10_000));
                  }
                }}
              />
              <span className="text-sm text-slate-500">억</span>
            </div>
          </Field>
          <Field label="1세대 1주택">
            <div className="flex gap-2">
              <button
                type="button"
                className={labPrimaryTabClass(singleHomeHousehold, "text-xs")}
                onClick={() => setSingleHomeHousehold(true)}
              >
                예
              </button>
              <button
                type="button"
                className={labPrimaryTabClass(!singleHomeHousehold, "text-xs")}
                onClick={() => setSingleHomeHousehold(false)}
              >
                아니오
              </button>
            </div>
          </Field>
          <Field label="미래 연도 투영 (선택)">
            <div className="flex flex-wrap items-center gap-2">
              <select
                className={inputClass}
                value={projectionYears}
                onChange={(e) => setProjectionYears(Number(e.target.value))}
              >
                <option value={0}>당해만</option>
                <option value={1}>+1년</option>
                <option value={3}>+3년</option>
                <option value={5}>+5년</option>
              </select>
              {projectionYears > 0 ? (
                <>
                  <span className="text-xs text-slate-500">연 상승</span>
                  <input
                    className={`${inputClass} w-20`}
                    type="number"
                    min={0}
                    max={20}
                    step={0.5}
                    value={growthPct}
                    onChange={(e) => setGrowthPct(Number(e.target.value) || 0)}
                  />
                  <span className="text-xs text-slate-500">%</span>
                </>
              ) : null}
            </div>
          </Field>
          {holding ? (
            <div className="space-y-3">
              {holding.projectionDisclaimer ? (
                <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  {holding.projectionDisclaimer}
                </p>
              ) : null}
              {holding.years.map((y) => (
                <div
                  key={y.yearOffset}
                  className="rounded-lg border border-slate-100 p-3"
                >
                  <p className="mb-2 text-xs font-semibold text-slate-700">
                    {y.yearOffset === 0 ? "당해" : `+${y.yearOffset}년`} · 공시{" "}
                    {formatEokMan(y.officialPriceMan)}
                  </p>
                  <dl className="space-y-1.5 text-sm">
                    <ResultRow
                      label="재산세(합)"
                      value={formatManWon(y.property.totalMan)}
                    />
                    <ResultRow
                      label="종합부동산세"
                      value={formatManWon(y.comprehensive.taxMan)}
                    />
                    <ResultRow
                      label="예상 합계"
                      value={formatManWon(y.totalMan)}
                      emph
                    />
                  </dl>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-slate-500">
              공시가격을 입력하면 결과가 표시됩니다.
            </p>
          )}
          <Notes
            lines={[
              ...(holding?.years[0]?.property.notes ?? []),
              ...(holding?.years[0]?.comprehensive.notes ?? []),
            ]}
          />
        </section>
      ) : null}

      {tab === "loan" ? (
        <section className="lab-card mt-3 space-y-4 p-4 sm:p-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="보유 자금 (억)">
              <input
                className={inputClass}
                inputMode="decimal"
                value={cashMan > 0 ? String(cashMan / 10_000) : ""}
                onChange={(e) => {
                  const v = Number(e.target.value.replace(/,/g, ""));
                  setCashMan(
                    Number.isFinite(v) && v >= 0 ? Math.round(v * 10_000) : 0,
                  );
                }}
              />
            </Field>
            <Field label="연소득 (만원)">
              <input
                className={inputClass}
                inputMode="numeric"
                value={annualIncomeMan || ""}
                onChange={(e) =>
                  setAnnualIncomeMan(Number(e.target.value) || 0)
                }
              />
            </Field>
            <Field label="기존 월상환 (만원)">
              <input
                className={inputClass}
                inputMode="numeric"
                value={existingMonthlyMan || ""}
                onChange={(e) =>
                  setExistingMonthlyMan(Number(e.target.value) || 0)
                }
              />
            </Field>
            <Field label="적용 금리 (%)">
              <input
                className={inputClass}
                inputMode="decimal"
                value={baseRatePct}
                onChange={(e) => setBaseRatePct(Number(e.target.value) || 0)}
              />
            </Field>
            <Field label="기간 (년)">
              <input
                className={inputClass}
                type="number"
                min={1}
                max={40}
                value={years}
                onChange={(e) => setYears(Number(e.target.value) || 30)}
              />
            </Field>
            <Field label="지역">
              <select
                className={inputClass}
                value={metro}
                onChange={(e) =>
                  setMetro(e.target.value as "capital" | "local")
                }
              >
                <option value="capital">수도권</option>
                <option value="local">지방</option>
              </select>
            </Field>
            <Field label="규제지역">
              <select
                className={inputClass}
                value={regulated}
                onChange={(e) =>
                  setRegulated(e.target.value as "regulated" | "unregulated")
                }
              >
                <option value="regulated">규제</option>
                <option value="unregulated">비규제</option>
              </select>
            </Field>
            <Field label="보유 주택 수">
              <select
                className={inputClass}
                value={homes}
                onChange={(e) =>
                  setHomes(e.target.value as "0" | "1" | "2plus")
                }
              >
                <option value="0">무주택</option>
                <option value="1">1주택</option>
                <option value="2plus">2주택+</option>
              </select>
            </Field>
          </div>
          <div className="flex flex-wrap gap-3 text-xs">
            <label className="inline-flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={firstHome}
                onChange={(e) => setFirstHome(e.target.checked)}
              />
              생애최초
            </label>
            <label className="inline-flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={disposeCondition}
                onChange={(e) => setDisposeCondition(e.target.checked)}
              />
              처분조건부
            </label>
          </div>
          {loan ? (
            <dl className="space-y-2 text-sm">
              {loan.breakdown.blocked ? (
                <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800">
                  {loan.breakdown.blockedReason ?? "대출 불가 가정"}
                </p>
              ) : null}
              <ResultRow
                label="LTV 기준 한도"
                value={formatEokMan(loan.breakdown.ltvLimitMan)}
              />
              <ResultRow
                label="DSR 기준 한도"
                value={formatEokMan(loan.breakdown.dsrLimitMan)}
              />
              <ResultRow
                label="추정 가능액 (적용 제한 중 최저)"
                value={formatEokMan(loan.estimatedLoanMan)}
                emph
              />
              <ResultRow
                label="제한 요인"
                value={loan.limitingLabels.join(", ") || "—"}
              />
              <ResultRow
                label="필요 자기자금"
                value={formatEokMan(loan.requiredCashMan)}
              />
              <ResultRow
                label="월 예상 상환액"
                value={formatManWon(loan.monthlyPaymentMan)}
              />
            </dl>
          ) : (
            <p className="text-sm text-slate-500">
              매수가를 입력하면 결과가 표시됩니다.
            </p>
          )}
          <Notes
            lines={[loan?.disclaimer ?? "", ...(loan?.breakdown.notes ?? [])]}
          />
        </section>
      ) : null}
    </div>
  );
}

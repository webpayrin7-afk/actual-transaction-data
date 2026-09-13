"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { labPrimaryTabClass } from "@/components/ui/lab";
import {
  calculateHoldingTax,
  calculateLoanEstimate,
  calculatePurchaseCost,
  formatEokMan,
  formatManWon,
  type AcquisitionHomeStatus,
} from "@/lib/calculator";
import type { HomeCount, MetroType, RegType } from "@/lib/loan/calc";

type TabId = "purchase" | "holding" | "loan";

const TABS: { id: TabId; label: string }[] = [
  { id: "purchase", label: "매수비용" },
  { id: "holding", label: "보유세" },
  { id: "loan", label: "대출" },
];

const inputClass = "lab-input w-full text-sm tabular-nums";

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
        className={
          emph
            ? "text-base font-bold tabular-nums text-slate-900"
            : "font-semibold tabular-nums text-slate-800"
        }
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
    <details className="group border-t border-slate-100 pt-2">
      <summary className="cursor-pointer list-none text-[11px] font-medium text-slate-500 [&::-webkit-details-marker]:hidden">
        계산 기준
        <span className="ml-1 text-slate-400 group-open:hidden">펼치기</span>
        <span className="ml-1 hidden text-slate-400 group-open:inline">접기</span>
      </summary>
      <ul className="mt-2 space-y-1 text-[11px] leading-relaxed text-slate-400">
        {cleaned.map((line) => (
          <li key={line}>· {line}</li>
        ))}
      </ul>
    </details>
  );
}

/**
 * Inline complex-detail calculator. Shares the detail page area selection.
 * Personal finance inputs stay client-local only.
 */
export function ComplexPurchaseCalculatorSection({
  areaKey,
  areaLabel,
  latestTradeMan,
}: {
  areaKey: string;
  areaLabel: string;
  /** Latest sale for selected area (만원). */
  latestTradeMan: number;
}) {
  const [tab, setTab] = useState<TabId>("purchase");
  const [priceMan, setPriceMan] = useState(0);
  const [priceTouched, setPriceTouched] = useState(false);
  const [conditionsOpen, setConditionsOpen] = useState(false);

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
  const [metro, setMetro] = useState<MetroType>("capital");
  const [regulated, setRegulated] = useState<RegType>("regulated");
  const [homes, setHomes] = useState<HomeCount>("0");
  const [firstHome, setFirstHome] = useState(true);
  const [disposeCondition, setDisposeCondition] = useState(false);

  const prevAreaKey = useRef(areaKey);
  useEffect(() => {
    if (prevAreaKey.current === areaKey) return;
    prevAreaKey.current = areaKey;
    setPriceTouched(false);
    setPriceMan(0);
  }, [areaKey]);

  const effectivePriceMan = priceTouched
    ? priceMan
    : latestTradeMan > 0
      ? latestTradeMan
      : priceMan;

  const purchase = useMemo(
    () =>
      effectivePriceMan > 0
        ? calculatePurchaseCost({ priceMan: effectivePriceMan, homeStatus })
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

  return (
    <section
      id="section-calculator"
      className="lab-card scroll-mt-28 p-4 sm:p-5"
    >
      <div id="calculator" className="sr-only" aria-hidden />

      <div className="min-w-0">
        <h2 className="text-xl font-semibold leading-none tracking-tight text-slate-900">
          대출·세금 계산
        </h2>
        <p className="mt-1.5 text-xs text-slate-500 sm:text-[13px]">
          이 단지를 매수할 때 필요한 비용과 대출을 계산해보세요.
        </p>
        {areaLabel ? (
          <p className="mt-1 truncate text-[11px] text-slate-400">
            선택 면적 · {areaLabel}
          </p>
        ) : null}
      </div>

      <div
        className="relative z-10 mt-3 flex w-full gap-1 overflow-x-auto"
        role="tablist"
        aria-label="계산 메뉴"
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={labPrimaryTabClass(
              tab === t.id,
              "relative z-10 min-w-0 flex-1 cursor-pointer",
            )}
            onClick={() => {
              setTab(t.id);
              setConditionsOpen(false);
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="mt-3 space-y-3">
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
                effectivePriceMan > 0 ? String(effectivePriceMan / 10_000) : ""
              }
              placeholder="억 단위 (예: 34.1)"
              onChange={(e) => {
                setPriceTouched(true);
                const raw = e.target.value.replace(/,/g, "");
                if (!raw) {
                  setPriceMan(0);
                  return;
                }
                const eok = Number(raw);
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

        {tab === "purchase" ? (
          <div className="space-y-3">
            <button
              type="button"
              className="text-xs font-medium text-teal-700 hover:underline"
              onClick={() => setConditionsOpen((v) => !v)}
            >
              {conditionsOpen ? "계산 조건 접기" : "계산 조건 변경"}
            </button>
            {conditionsOpen ? (
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
            ) : null}
            {purchase ? (
              <dl className="space-y-2 text-sm">
                <ResultRow
                  label="예상 매수 총비용"
                  value={formatEokMan(purchase.totalCostMan)}
                  emph
                />
                <ResultRow
                  label={`취득 관련 세금 (${purchase.acquisition.appliedRateLabel})`}
                  value={formatManWon(purchase.acquisition.totalTaxMan)}
                />
                <ResultRow
                  label={`중개보수 상한 (${purchase.brokerage.ratePct.toFixed(1)}%)`}
                  value={formatManWon(purchase.brokerage.feeMan)}
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
          </div>
        ) : null}

        {tab === "holding" ? (
          <div className="space-y-3">
            <Field
              label="공시가격"
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
                    const raw = e.target.value.replace(/,/g, "");
                    if (!raw) {
                      setOfficialPriceMan(0);
                      return;
                    }
                    const eok = Number(raw);
                    if (Number.isFinite(eok) && eok >= 0) {
                      setOfficialPriceMan(Math.round(eok * 10_000));
                    }
                  }}
                />
                <span className="text-sm text-slate-500">억</span>
              </div>
            </Field>
            <button
              type="button"
              className="text-xs font-medium text-teal-700 hover:underline"
              onClick={() => setConditionsOpen((v) => !v)}
            >
              {conditionsOpen ? "보유 조건 접기" : "보유 조건 변경"}
            </button>
            {conditionsOpen ? (
              <div className="space-y-3">
                <Field label="1세대 1주택">
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className={labPrimaryTabClass(
                        singleHomeHousehold,
                        "text-xs",
                      )}
                      onClick={() => setSingleHomeHousehold(true)}
                    >
                      예
                    </button>
                    <button
                      type="button"
                      className={labPrimaryTabClass(
                        !singleHomeHousehold,
                        "text-xs",
                      )}
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
                      onChange={(e) =>
                        setProjectionYears(Number(e.target.value))
                      }
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
                          onChange={(e) =>
                            setGrowthPct(Number(e.target.value) || 0)
                          }
                        />
                        <span className="text-xs text-slate-500">%</span>
                      </>
                    ) : null}
                  </div>
                </Field>
              </div>
            ) : null}
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
                        label="재산세"
                        value={formatManWon(y.property.totalMan)}
                      />
                      <ResultRow
                        label="종부세"
                        value={formatManWon(y.comprehensive.taxMan)}
                      />
                      <ResultRow
                        label="합계"
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
          </div>
        ) : null}

        {tab === "loan" ? (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="보유 자금 (억)">
                <input
                  className={inputClass}
                  inputMode="decimal"
                  value={cashMan > 0 ? String(cashMan / 10_000) : ""}
                  onChange={(e) => {
                    const v = Number(e.target.value.replace(/,/g, ""));
                    setCashMan(
                      Number.isFinite(v) && v >= 0
                        ? Math.round(v * 10_000)
                        : 0,
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
            </div>
            <button
              type="button"
              className="text-xs font-medium text-teal-700 hover:underline"
              onClick={() => setConditionsOpen((v) => !v)}
            >
              {conditionsOpen ? "대출 조건 접기" : "대출 조건 변경"}
            </button>
            {conditionsOpen ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="지역">
                  <select
                    className={inputClass}
                    value={metro}
                    onChange={(e) => setMetro(e.target.value as MetroType)}
                  >
                    <option value="capital">수도권</option>
                    <option value="local">지방</option>
                  </select>
                </Field>
                <Field label="규제지역">
                  <select
                    className={inputClass}
                    value={regulated}
                    onChange={(e) => setRegulated(e.target.value as RegType)}
                  >
                    <option value="regulated">규제</option>
                    <option value="unregulated">비규제</option>
                  </select>
                </Field>
                <Field label="보유 주택 수">
                  <select
                    className={inputClass}
                    value={homes}
                    onChange={(e) => setHomes(e.target.value as HomeCount)}
                  >
                    <option value="0">무주택</option>
                    <option value="1">1주택</option>
                    <option value="2plus">2주택+</option>
                  </select>
                </Field>
                <div className="flex flex-wrap items-end gap-3 text-xs">
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
              </div>
            ) : null}
            {loan ? (
              <dl className="space-y-2 text-sm">
                {loan.breakdown.blocked ? (
                  <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800">
                    {loan.breakdown.blockedReason ?? "대출 불가 가정"}
                  </p>
                ) : null}
                <ResultRow
                  label="예상 대출 가능액"
                  value={formatEokMan(loan.estimatedLoanMan)}
                  emph
                />
                <ResultRow
                  label="필요 자기자금"
                  value={formatEokMan(loan.requiredCashMan)}
                />
                <ResultRow
                  label="월 예상 상환액"
                  value={formatManWon(loan.monthlyPaymentMan)}
                />
                <ResultRow
                  label="LTV 기준"
                  value={formatEokMan(loan.breakdown.ltvLimitMan)}
                />
                <ResultRow
                  label="DSR 기준"
                  value={formatEokMan(loan.breakdown.dsrLimitMan)}
                />
                <ResultRow
                  label="제한 요인"
                  value={loan.limitingLabels.join(", ") || "—"}
                />
              </dl>
            ) : (
              <p className="text-sm text-slate-500">
                매수가를 입력하면 결과가 표시됩니다.
              </p>
            )}
            <Notes
              lines={[
                loan?.disclaimer ?? "",
                ...(loan?.breakdown.notes ?? []),
                "LTV만으로 승인액을 단정하지 마세요.",
              ]}
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}

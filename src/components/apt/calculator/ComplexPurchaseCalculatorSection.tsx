"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { labUnderlineTabClass } from "@/components/ui/lab";
import {
  brokerageRatePctOptionsForPrice,
  calculateHoldingTax,
  calculateLoanEstimate,
  calculatePurchaseCost,
  formatEokMan,
  formatManWon,
  parseEokInputToMan,
  type AcquisitionHomeStatus,
  type ExclusiveAreaInput,
} from "@/lib/calculator";
import type { HomeCount, MetroType, RegType } from "@/lib/loan/calc";

type TabId = "purchase" | "holding" | "loan";

const TABS: { id: TabId; label: string }[] = [
  { id: "purchase", label: "매수비용" },
  { id: "holding", label: "보유세" },
  { id: "loan", label: "대출" },
];

const inputClass = "lab-input h-10 w-full min-w-0 px-3 text-sm tabular-nums";

function Row({
  label,
  value,
  hint,
  emph,
}: {
  label: string;
  value: string;
  hint?: string;
  emph?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <dt
          className={
            emph ? "text-sm text-slate-600" : "text-sm text-slate-500"
          }
        >
          {label}
        </dt>
        {hint ? (
          <p className="mt-0.5 text-[11px] leading-snug text-slate-400">
            {hint}
          </p>
        ) : null}
      </div>
      <dd
        className={
          emph
            ? "shrink-0 text-lg font-bold tabular-nums tracking-tight text-slate-900"
            : "shrink-0 text-sm font-semibold tabular-nums text-slate-800"
        }
      >
        {value}
      </dd>
    </div>
  );
}

function ConditionRow({
  summary,
  open,
  onToggle,
}: {
  summary: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="flex w-full items-center justify-between gap-2 rounded-lg border border-slate-200/80 bg-slate-50/70 px-3 py-2 text-left transition hover:bg-slate-50"
    >
      <div className="min-w-0">
        <p className="text-[11px] font-medium text-slate-500">계산 조건</p>
        <p className="truncate text-sm text-slate-800">{summary}</p>
      </div>
      <span className="shrink-0 text-xs font-medium text-teal-700">
        {open ? "접기" : "변경 ›"}
      </span>
    </button>
  );
}

function BasisDetails({ lines }: { lines: string[] }) {
  const cleaned = lines.map((l) => l.trim()).filter(Boolean);
  if (!cleaned.length) return null;
  return (
    <details className="group">
      <summary className="cursor-pointer list-none text-[11px] text-slate-400 marker:content-none [&::-webkit-details-marker]:hidden">
        계산 기준 펼치기
        <span className="ml-1 hidden group-open:inline">· 접기</span>
      </summary>
      <ul className="mt-1.5 space-y-1 text-[11px] leading-relaxed text-slate-400">
        {cleaned.map((line) => (
          <li key={line}>· {line}</li>
        ))}
      </ul>
    </details>
  );
}

function choiceClass(active: boolean) {
  return active
    ? "rounded-md bg-teal-50 px-2.5 py-1.5 text-xs font-semibold text-teal-800"
    : "rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-600";
}

/**
 * Compact decision-first calculator embedded in Complex Detail.
 * Shares the page area selection; personal inputs stay client-local.
 */
export function ComplexPurchaseCalculatorSection({
  areaKey,
  areaLabel,
  latestTradeMan,
  exclusiveAreaMinSqm = null,
  exclusiveAreaMaxSqm = null,
}: {
  areaKey: string;
  areaLabel: string;
  /** Latest sale for selected area (만원). */
  latestTradeMan: number;
  /** Selected Phase5 exclusive-area bounds (㎡). */
  exclusiveAreaMinSqm?: number | null;
  exclusiveAreaMaxSqm?: number | null;
}) {
  const [tab, setTab] = useState<TabId>("purchase");
  const [priceMan, setPriceMan] = useState(0);
  const [priceTouched, setPriceTouched] = useState(false);
  const [priceFocused, setPriceFocused] = useState(false);
  const [priceDraft, setPriceDraft] = useState("");
  const [conditionsOpen, setConditionsOpen] = useState(false);

  const [homeStatus, setHomeStatus] =
    useState<AcquisitionHomeStatus>("one_home");
  /** null = use legal cap */
  const [brokerageRatePct, setBrokerageRatePct] = useState<number | null>(null);
  const [brokeragePickerOpen, setBrokeragePickerOpen] = useState(false);

  const [officialPriceMan, setOfficialPriceMan] = useState(0);
  const [officialDraft, setOfficialDraft] = useState("");
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
    setPriceFocused(false);
    setPriceDraft("");
    setBrokerageRatePct(null);
    setBrokeragePickerOpen(false);
  }, [areaKey]);

  const effectivePriceMan = priceTouched
    ? priceMan
    : latestTradeMan > 0
      ? latestTradeMan
      : priceMan;

  const priceInputValue = priceFocused
    ? priceDraft
    : effectivePriceMan > 0
      ? formatEokMan(effectivePriceMan)
      : "";

  const exclusiveArea: ExclusiveAreaInput = useMemo(() => {
    if (areaKey === "all") return { mode: "unknown" };
    const min = exclusiveAreaMinSqm;
    const max = exclusiveAreaMaxSqm;
    if (min == null && max == null) return { mode: "unknown" };
    if (min != null && max != null && Math.abs(min - max) > 0.0005) {
      return { mode: "range", minSqm: min, maxSqm: max };
    }
    const sqm = (max ?? min) as number;
    return { mode: "exact", sqm };
  }, [areaKey, exclusiveAreaMinSqm, exclusiveAreaMaxSqm]);

  const brokerageOptions = useMemo(
    () =>
      effectivePriceMan > 0
        ? brokerageRatePctOptionsForPrice(effectivePriceMan)
        : [],
    [effectivePriceMan],
  );

  const purchase = useMemo(
    () =>
      effectivePriceMan > 0
        ? calculatePurchaseCost({
            priceMan: effectivePriceMan,
            homeStatus,
            exclusiveArea,
            brokerageRatePct,
          })
        : null,
    [effectivePriceMan, homeStatus, exclusiveArea, brokerageRatePct],
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

  const compactArea =
    areaLabel && areaLabel !== "전체 면적"
      ? (areaLabel.split("·")[0]?.trim() || areaLabel)
      : "";

  const purchaseConditionSummary =
    homeStatus === "one_home" ? "1주택 · 일반취득 · 개인" : "다주택 중과 · 단순";
  const holdingConditionSummary = singleHomeHousehold
    ? "1세대 1주택 · 단독명의"
    : "1세대 1주택 아님";
  const loanConditionSummary = [
    homes === "0" ? "무주택" : homes === "1" ? "1주택" : "2주택+",
    metro === "capital" ? "수도권" : "지방",
    `${baseRatePct}% · ${years}년`,
  ].join(" · ");

  function commitPriceDraft(raw: string) {
    const parsed = parseEokInputToMan(raw);
    if (parsed == null) {
      setPriceDraft(
        effectivePriceMan > 0 ? formatEokMan(effectivePriceMan) : "",
      );
      return;
    }
    setPriceTouched(true);
    setPriceMan(parsed);
    setPriceDraft(formatEokMan(parsed));
  }

  function resetToLatestTrade() {
    if (latestTradeMan <= 0) return;
    setPriceTouched(false);
    setPriceMan(0);
    setPriceFocused(false);
    setPriceDraft("");
  }

  function commitOfficialDraft(raw: string) {
    const parsed = parseEokInputToMan(raw);
    if (parsed == null) {
      setOfficialDraft(
        officialPriceMan > 0 ? formatEokMan(officialPriceMan) : "",
      );
      return;
    }
    setOfficialPriceMan(parsed);
    setOfficialDraft(formatEokMan(parsed));
  }

  return (
    <section
      id="section-calculator"
      className="lab-card scroll-mt-28 p-4 sm:p-5"
    >
      <div id="calculator" className="sr-only" aria-hidden />

      <header className="min-w-0">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h2 className="text-xl font-semibold leading-none tracking-tight text-slate-900">
            대출·세금 계산
          </h2>
          {compactArea ? (
            <p className="text-[11px] tabular-nums text-slate-400">
              {compactArea} 기준
            </p>
          ) : null}
        </div>
        <p className="mt-1.5 text-[11px] leading-snug text-slate-400 sm:text-xs">
          이 단지를 매수할 때 필요한 비용과 대출을 계산해보세요.
        </p>
      </header>

      <div
        className="mt-3 flex w-full gap-0 border-b border-slate-200"
        role="tablist"
        aria-label="계산 메뉴"
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={labUnderlineTabClass(
              tab === t.id,
              "min-h-9 flex-1 px-2 text-[13px] sm:text-sm",
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
        {tab === "purchase" || tab === "loan" ? (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <label
                htmlFor="calc-purchase-price"
                className="text-xs font-medium text-slate-600"
              >
                예상 매수가
              </label>
              {latestTradeMan > 0 ? (
                <button
                  type="button"
                  className="text-[11px] font-medium text-teal-700 hover:underline"
                  onClick={resetToLatestTrade}
                >
                  최근 거래가 ↺
                </button>
              ) : null}
            </div>
            <input
              id="calc-purchase-price"
              className={inputClass}
              inputMode="decimal"
              value={priceInputValue}
              placeholder="예: 34.1억 / 34억1000"
              onFocus={() => {
                setPriceFocused(true);
                setPriceDraft(
                  effectivePriceMan > 0 ? formatEokMan(effectivePriceMan) : "",
                );
              }}
              onChange={(e) => {
                setPriceTouched(true);
                setPriceDraft(e.target.value);
              }}
              onBlur={() => {
                setPriceFocused(false);
                commitPriceDraft(priceDraft);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
            />
          </div>
        ) : null}

        {tab === "purchase" ? (
          <div className="space-y-3">
            {purchase ? (
              <dl className="space-y-2.5">
                <Row
                  label="예상 매수 총비용"
                  value={formatEokMan(purchase.totalCostMan)}
                  emph
                />
                <div className="space-y-2 border-t border-slate-100 pt-2.5">
                  <Row label="매매가" value={formatEokMan(purchase.priceMan)} />
                  <Row
                    label="취득 관련 세금"
                    value={formatEokMan(purchase.acquisition.totalTaxMan)}
                    hint="취득세·지방교육세·농어촌특별세"
                  />
                  <div className="space-y-1.5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm text-slate-500">중개보수율</p>
                        <p className="mt-0.5 text-[11px] text-slate-400">
                          {purchase.brokerage.userSelected
                            ? `${purchase.brokerage.ratePct.toFixed(2)}% · 직접 선택`
                            : `${purchase.brokerage.ratePct.toFixed(2)}% · 상한`}
                        </p>
                      </div>
                      <button
                        type="button"
                        className="shrink-0 text-xs font-medium text-teal-700"
                        onClick={() => setBrokeragePickerOpen((v) => !v)}
                      >
                        {brokeragePickerOpen ? "접기" : "변경 ›"}
                      </button>
                    </div>
                    {brokeragePickerOpen ? (
                      <div className="flex flex-wrap gap-1.5 rounded-lg border border-slate-200 bg-white p-2">
                        {brokerageOptions.map((pct) => (
                          <button
                            key={pct}
                            type="button"
                            className={choiceClass(
                              Math.abs(purchase.brokerage.ratePct - pct) < 1e-9,
                            )}
                            onClick={() => {
                              setBrokerageRatePct(pct);
                              setBrokeragePickerOpen(false);
                            }}
                          >
                            {pct.toFixed(2)}%
                            {Math.abs(pct - purchase.brokerage.legalCapRatePct) <
                            1e-9
                              ? " · 상한"
                              : ""}
                          </button>
                        ))}
                      </div>
                    ) : null}
                    <Row
                      label="중개보수"
                      value={formatEokMan(purchase.brokerage.feeMan)}
                      hint="부가가치세는 별도 발생할 수 있습니다."
                    />
                  </div>
                  <div className="space-y-1 border-t border-slate-100 pt-2 text-[11px] text-slate-500">
                    <div className="flex justify-between gap-2">
                      <span>취득세</span>
                      <span className="tabular-nums text-slate-700">
                        {formatManWon(purchase.acquisition.baseTaxMan)}
                      </span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span>지방교육세</span>
                      <span className="tabular-nums text-slate-700">
                        {formatManWon(purchase.acquisition.localEducationTaxMan)}
                      </span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span>농어촌특별세</span>
                      <span className="tabular-nums text-slate-700">
                        {formatManWon(purchase.acquisition.ruralSpecialTaxMan)}
                      </span>
                    </div>
                    {purchase.acquisition.ruralSpecialTaxStatus ===
                    "exempt_national_housing" ? (
                      <p className="text-slate-400">전용 85㎡ 이하 비과세</p>
                    ) : null}
                    {purchase.acquisition.ruralSpecialTaxStatus ===
                    "needs_exact_area" ? (
                      <p className="text-amber-700">
                        전용면적이 85㎡를 걸칩니다. 정확한 면적 확인이 필요합니다.
                      </p>
                    ) : null}
                    {purchase.acquisition.ruralSpecialTaxStatus ===
                    "unknown_area" ? (
                      <p className="text-amber-700">
                        전용면적 정보가 없어 농어촌특별세를 확정하지 않았습니다.
                      </p>
                    ) : null}
                  </div>
                </div>
              </dl>
            ) : (
              <p className="text-sm text-slate-500">
                매수가를 입력하면 결과가 표시됩니다.
              </p>
            )}

            <ConditionRow
              summary={purchaseConditionSummary}
              open={conditionsOpen}
              onToggle={() => setConditionsOpen((v) => !v)}
            />
            {conditionsOpen ? (
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
                    className={choiceClass(homeStatus === id)}
                    onClick={() => setHomeStatus(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            ) : null}

            <BasisDetails
              lines={[
                purchase
                  ? `취득세 본세: ${formatManWon(purchase.acquisition.baseTaxMan)} (${purchase.acquisition.appliedRateLabel})`
                  : "",
                purchase
                  ? `지방교육세: ${formatManWon(purchase.acquisition.localEducationTaxMan)}`
                  : "",
                purchase
                  ? `농어촌특별세: ${formatManWon(purchase.acquisition.ruralSpecialTaxMan)}`
                  : "",
                purchase
                  ? `중개보수율 ${purchase.brokerage.ratePct.toFixed(2)}% (${purchase.brokerage.userSelected ? "직접 선택" : "법정 상한"})`
                  : "",
                purchase?.acquisition.ruralSpecialTaxStatus ===
                "exempt_national_housing"
                  ? "농어촌특별세: 전용 85㎡ 이하 비과세"
                  : "",
                ...(purchase?.acquisition.notes ?? []),
                ...(purchase?.brokerage.notes ?? []),
                purchase
                  ? `규칙: ${purchase.acquisition.meta.ruleVersion} / ${purchase.brokerage.meta.ruleVersion}`
                  : "",
                purchase
                  ? `시행: ${purchase.acquisition.meta.effectiveFrom}`
                  : "",
                purchase ? purchase.acquisition.meta.source : "",
              ]}
            />
          </div>
        ) : null}

        {tab === "holding" ? (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label
                htmlFor="calc-official-price"
                className="text-xs font-medium text-slate-600"
              >
                공시가격
              </label>
              <input
                id="calc-official-price"
                className={inputClass}
                inputMode="decimal"
                value={officialDraft}
                placeholder="예: 18억 (직접 입력)"
                onChange={(e) => setOfficialDraft(e.target.value)}
                onBlur={() => commitOfficialDraft(officialDraft)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
              />
              <p className="text-[11px] text-slate-400">
                공식 공시가가 없으면 직접 입력하세요. 실거래가 비율로 추정하지
                않습니다.
              </p>
            </div>

            {holding ? (
              <dl className="space-y-2.5">
                {holding.years.slice(0, 1).map((y) => (
                  <div key={y.yearOffset} className="space-y-2.5">
                    <Row
                      label="올해 예상 보유세"
                      value={formatEokMan(y.totalMan)}
                      emph
                      hint="확정 고지세액이 아닌 예상세액"
                    />
                    <div className="space-y-2 border-t border-slate-100 pt-2.5">
                      <Row
                        label="재산세"
                        value={formatEokMan(y.property.totalMan)}
                      />
                      <Row
                        label="종부세"
                        value={formatEokMan(y.comprehensive.taxMan)}
                      />
                    </div>
                  </div>
                ))}
                <p className="text-[11px] text-amber-800">
                  {holding.estimateDisclaimer}
                </p>
                {holding.projectionDisclaimer ? (
                  <p className="text-[11px] text-amber-800">
                    {holding.projectionDisclaimer}
                  </p>
                ) : null}
                {holding.years.length > 1 ? (
                  <div className="space-y-2 border-t border-slate-100 pt-2">
                    {holding.years.slice(1).map((y) => (
                      <Row
                        key={y.yearOffset}
                        label={`+${y.yearOffset}년 합계`}
                        value={formatEokMan(y.totalMan)}
                      />
                    ))}
                  </div>
                ) : null}
              </dl>
            ) : (
              <p className="text-sm text-slate-500">
                공시가격을 입력하면 결과가 표시됩니다.
              </p>
            )}

            <ConditionRow
              summary={holdingConditionSummary}
              open={conditionsOpen}
              onToggle={() => setConditionsOpen((v) => !v)}
            />
            {conditionsOpen ? (
              <div className="space-y-3">
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={choiceClass(singleHomeHousehold)}
                    onClick={() => setSingleHomeHousehold(true)}
                  >
                    1세대 1주택
                  </button>
                  <button
                    type="button"
                    className={choiceClass(!singleHomeHousehold)}
                    onClick={() => setSingleHomeHousehold(false)}
                  >
                    해당 없음
                  </button>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-slate-500">미래 투영</span>
                  <select
                    className="lab-input h-9 px-2 text-xs"
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
                      <input
                        className="lab-input h-9 w-16 px-2 text-xs"
                        type="number"
                        min={0}
                        max={20}
                        step={0.5}
                        value={growthPct}
                        onChange={(e) =>
                          setGrowthPct(Number(e.target.value) || 0)
                        }
                      />
                      <span className="text-xs text-slate-500">%/년</span>
                    </>
                  ) : null}
                </div>
              </div>
            ) : null}

            <BasisDetails
              lines={[
                ...(holding?.years[0]?.property.notes ?? []),
                ...(holding?.years[0]?.comprehensive.notes ?? []),
              ]}
            />
          </div>
        ) : null}

        {tab === "loan" ? (
          <div className="space-y-3">
            {loan ? (
              <dl className="space-y-2.5">
                {loan.breakdown.blocked ? (
                  <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800">
                    {loan.breakdown.blockedReason ?? "대출 불가 가정"}
                  </p>
                ) : null}
                <Row
                  label="예상 대출 가능액"
                  value={formatEokMan(loan.estimatedLoanMan)}
                  emph
                />
                <div className="space-y-2 border-t border-slate-100 pt-2.5">
                  <Row
                    label="필요 자기자금"
                    value={formatEokMan(loan.requiredCashMan)}
                  />
                  <Row
                    label="월 예상 상환액"
                    value={formatManWon(loan.monthlyPaymentMan)}
                  />
                  <Row
                    label="LTV 기준"
                    value={formatEokMan(loan.breakdown.ltvLimitMan)}
                  />
                  <Row
                    label="DSR 기준"
                    value={formatEokMan(loan.breakdown.dsrLimitMan)}
                  />
                  <Row
                    label="제한 요인"
                    value={loan.limitingLabels.join(", ") || "—"}
                  />
                </div>
              </dl>
            ) : (
              <p className="text-sm text-slate-500">
                매수가를 입력하면 결과가 표시됩니다.
              </p>
            )}

            <ConditionRow
              summary={loanConditionSummary}
              open={conditionsOpen}
              onToggle={() => setConditionsOpen((v) => !v)}
            />
            {conditionsOpen ? (
              <div className="grid gap-2.5 sm:grid-cols-2">
                <label className="block space-y-1">
                  <span className="text-xs text-slate-500">보유 자금 (억)</span>
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
                </label>
                <label className="block space-y-1">
                  <span className="text-xs text-slate-500">연소득 (만원)</span>
                  <input
                    className={inputClass}
                    inputMode="numeric"
                    value={annualIncomeMan || ""}
                    onChange={(e) =>
                      setAnnualIncomeMan(Number(e.target.value) || 0)
                    }
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-xs text-slate-500">
                    기존 월상환 (만원)
                  </span>
                  <input
                    className={inputClass}
                    inputMode="numeric"
                    value={existingMonthlyMan || ""}
                    onChange={(e) =>
                      setExistingMonthlyMan(Number(e.target.value) || 0)
                    }
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-xs text-slate-500">금리 (%)</span>
                  <input
                    className={inputClass}
                    inputMode="decimal"
                    value={baseRatePct}
                    onChange={(e) =>
                      setBaseRatePct(Number(e.target.value) || 0)
                    }
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-xs text-slate-500">기간 (년)</span>
                  <input
                    className={inputClass}
                    type="number"
                    min={1}
                    max={40}
                    value={years}
                    onChange={(e) => setYears(Number(e.target.value) || 30)}
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-xs text-slate-500">지역</span>
                  <select
                    className={inputClass}
                    value={metro}
                    onChange={(e) => setMetro(e.target.value as MetroType)}
                  >
                    <option value="capital">수도권</option>
                    <option value="local">지방</option>
                  </select>
                </label>
                <label className="block space-y-1">
                  <span className="text-xs text-slate-500">규제지역</span>
                  <select
                    className={inputClass}
                    value={regulated}
                    onChange={(e) => setRegulated(e.target.value as RegType)}
                  >
                    <option value="regulated">규제</option>
                    <option value="unregulated">비규제</option>
                  </select>
                </label>
                <label className="block space-y-1">
                  <span className="text-xs text-slate-500">보유 주택 수</span>
                  <select
                    className={inputClass}
                    value={homes}
                    onChange={(e) => setHomes(e.target.value as HomeCount)}
                  >
                    <option value="0">무주택</option>
                    <option value="1">1주택</option>
                    <option value="2plus">2주택+</option>
                  </select>
                </label>
                <div className="flex flex-wrap items-end gap-3 text-xs sm:col-span-2">
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

            <BasisDetails
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

"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { labUnderlineTabClass } from "@/components/ui/lab";
import {
  brokerageRatePctOptionsForPrice,
  calculateHoldingTax,
  calculateLoanEstimate,
  calculatePurchaseCost,
  formatEokMan,
  formatManInput,
  formatManWon,
  getComplexPublicPrices,
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

/** 만원 숫자 입력 + 입력칸 안 실시간 억·만원 환산 */
function ManWonField({
  id,
  value,
  placeholder,
  liveMan,
  onFocus,
  onChange,
  onBlur,
}: {
  id: string;
  value: string;
  placeholder: string;
  liveMan: number | null;
  onFocus: () => void;
  onChange: (value: string) => void;
  onBlur: () => void;
}) {
  const liveLabel =
    liveMan != null && liveMan > 0 ? formatEokMan(liveMan) : null;

  return (
    <div className="lab-input flex h-10 w-full min-w-0 items-center gap-2 px-3 focus-within:border-teal-500 focus-within:ring-2 focus-within:ring-teal-500/20">
      <input
        id={id}
        className="h-full min-w-0 flex-1 border-0 bg-transparent p-0 text-base tabular-nums text-slate-900 outline-none placeholder:text-slate-400"
        inputMode="numeric"
        value={value}
        placeholder={placeholder}
        onFocus={onFocus}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        aria-describedby={liveLabel ? `${id}-live` : undefined}
      />
      {liveLabel ? (
        <>
          <span aria-hidden className="h-4 w-px shrink-0 bg-slate-200" />
          <span
            id={`${id}-live`}
            className="max-w-[48%] shrink-0 truncate text-right text-sm font-medium tabular-nums text-slate-700"
          >
            {liveLabel}
          </span>
        </>
      ) : null}
    </div>
  );
}

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
          <p className="mt-0.5 text-xs leading-snug text-slate-500">
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
  const [open, setOpen] = useState(false);
  if (!cleaned.length) return null;
  return (
    <details
      className="group rounded-lg border border-slate-200/80 bg-slate-50/40"
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary
        aria-expanded={open}
        className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 text-sm font-medium text-slate-800 marker:content-none [&::-webkit-details-marker]:hidden"
      >
        <span>계산 기준 및 세부내역</span>
        <span aria-hidden className="text-slate-500 transition group-open:rotate-180">
          ∨
        </span>
      </summary>
      <ul className="space-y-2 border-t border-slate-200/70 px-3 py-3 text-sm leading-relaxed text-slate-700">
        {cleaned.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </details>
  );
}

function FieldSelect({
  id,
  label,
  status,
  value,
  onChange,
  children,
}: {
  id: string;
  label: string;
  status?: string;
  value: string | number;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm text-slate-500">
          {label}
        </label>
        {status ? (
          <p className="mt-0.5 truncate text-xs text-slate-500">{status}</p>
        ) : null}
      </div>
      <select
        id={id}
        className="h-9 min-w-[10.5rem] max-w-[58%] rounded-md border border-slate-200 bg-white px-2.5 text-sm font-medium text-slate-800"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {children}
      </select>
    </div>
  );
}

function DetailItem({
  label,
  value,
  basis,
}: {
  label: string;
  value: string;
  basis?: string;
}) {
  return (
    <div className="space-y-0.5">
      <p className="text-sm text-slate-500">{label}</p>
      <p className="text-sm font-semibold tabular-nums text-slate-900">{value}</p>
      {basis ? (
        <p className="text-sm leading-relaxed text-slate-600">{basis}</p>
      ) : null}
    </div>
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
  complexName,
  areaKey,
  areaLabel,
  latestTradeMan,
  exclusiveAreaMinSqm = null,
  exclusiveAreaMaxSqm = null,
}: {
  /** Complex display name for holding-tax context. */
  complexName: string;
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
  const [purchaseBasisOpen, setPurchaseBasisOpen] = useState(false);
  const [holdingSettingsOpen, setHoldingSettingsOpen] = useState(false);

  const [homeStatus, setHomeStatus] =
    useState<AcquisitionHomeStatus>("one_home");
  /** null = use legal cap */
  const [brokerageRatePct, setBrokerageRatePct] = useState<number | null>(null);

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
  }, [areaKey]);

  const effectivePriceMan = priceTouched
    ? priceMan
    : latestTradeMan > 0
      ? latestTradeMan
      : priceMan;

  const priceInputValue = priceFocused
    ? priceDraft
    : effectivePriceMan > 0
      ? formatManInput(effectivePriceMan)
      : "";

  const livePriceMan = priceFocused
    ? parseEokInputToMan(priceDraft)
    : effectivePriceMan > 0
      ? effectivePriceMan
      : null;

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

  const holdingConditionSummary = [
    "개인",
    singleHomeHousehold ? "1세대 1주택" : "1세대 1주택 아님",
    projectionYears > 0 ? `전망 +${projectionYears}년 · 연 ${growthPct}%` : "당해 기준",
  ].join(" · ");

  const publicPrice = useMemo(
    () =>
      getComplexPublicPrices({
        complexName,
        areaKey: areaKey === "all" ? null : areaKey,
        exclusiveAreaMinSqm,
        exclusiveAreaMaxSqm,
        year: new Date().getFullYear(),
      }),
    [complexName, areaKey, exclusiveAreaMinSqm, exclusiveAreaMaxSqm],
  );

  const holdingBaseYear = new Date().getFullYear();
  const loanConditionSummary = [
    homes === "0" ? "무주택" : homes === "1" ? "1주택" : "2주택+",
    metro === "capital" ? "수도권" : "지방",
    `${baseRatePct}% · ${years}년`,
  ].join(" · ");

  function commitPriceDraft(raw: string) {
    const parsed = parseEokInputToMan(raw);
    if (parsed == null) {
      setPriceDraft(
        effectivePriceMan > 0 ? formatManInput(effectivePriceMan) : "",
      );
      return;
    }
    setPriceTouched(true);
    setPriceMan(parsed);
    setPriceDraft(formatManInput(parsed));
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
        officialPriceMan > 0 ? formatManInput(officialPriceMan) : "",
      );
      return;
    }
    setOfficialPriceMan(parsed);
    setOfficialDraft(formatManInput(parsed));
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
                <span className="ml-1 font-normal text-slate-400">(만원)</span>
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
            <ManWonField
              id="calc-purchase-price"
              value={priceInputValue}
              placeholder="예: 341000"
              liveMan={livePriceMan}
              onFocus={() => {
                setPriceFocused(true);
                setPriceDraft(
                  effectivePriceMan > 0
                    ? formatManInput(effectivePriceMan)
                    : "",
                );
              }}
              onChange={(v) => {
                setPriceTouched(true);
                setPriceDraft(v);
              }}
              onBlur={() => {
                setPriceFocused(false);
                commitPriceDraft(priceDraft);
              }}
            />
          </div>
        ) : null}

        {tab === "purchase" ? (
          <div className="space-y-3">
            <div className="space-y-2.5">
              <FieldSelect
                id="calc-home-status"
                label="취득 조건"
                value={homeStatus}
                onChange={(v) =>
                  setHomeStatus(v as AcquisitionHomeStatus)
                }
              >
                <option value="one_home">1주택 일반취득</option>
                <option value="multi_heavy">다주택 중과</option>
              </FieldSelect>

              <FieldSelect
                id="calc-brokerage-rate"
                label="중개보수율"
                status={
                  purchase
                    ? purchase.brokerage.userSelected
                      ? "직접 선택"
                      : "법정 상한"
                    : brokerageOptions.length
                      ? "법정 상한 기준"
                      : "매수가 입력 후 선택"
                }
                value={
                  purchase
                    ? String(purchase.brokerage.ratePct)
                    : brokerageOptions[brokerageOptions.length - 1]
                      ? String(brokerageOptions[brokerageOptions.length - 1])
                      : ""
                }
                onChange={(v) => {
                  const next = Number(v);
                  setBrokerageRatePct(Number.isFinite(next) ? next : null);
                }}
              >
                {brokerageOptions.map((pct) => (
                  <option key={pct} value={pct}>
                    {pct.toFixed(2)}%
                    {purchase &&
                    Math.abs(pct - purchase.brokerage.legalCapRatePct) < 1e-9
                      ? " · 상한"
                      : ""}
                  </option>
                ))}
              </FieldSelect>
            </div>

            {purchase ? (
              <dl className="space-y-2.5">
                <Row
                  label="예상 매수 총비용"
                  value={formatEokMan(purchase.totalCostMan)}
                  emph
                />
                <div className="space-y-2 border-t border-slate-200/80 pt-2.5">
                  <Row label="매매가" value={formatEokMan(purchase.priceMan)} />
                  <Row
                    label="추가 비용"
                    value={`+${formatEokMan(purchase.extraCostMan)}`}
                  />
                  <Row
                    label="취득 관련 세금"
                    value={formatEokMan(purchase.acquisition.totalTaxMan)}
                  />
                  <Row
                    label="중개보수"
                    value={formatEokMan(purchase.brokerage.feeMan)}
                  />
                </div>
              </dl>
            ) : (
              <p className="text-sm text-slate-500">
                매수가를 입력하면 결과가 표시됩니다.
              </p>
            )}

            {purchase ? (
              <details
                className="group rounded-lg border border-slate-200/80 bg-slate-50/40"
                open={purchaseBasisOpen}
                onToggle={(e) =>
                  setPurchaseBasisOpen((e.target as HTMLDetailsElement).open)
                }
              >
                <summary
                  aria-expanded={purchaseBasisOpen}
                  className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 text-sm font-medium text-slate-800 marker:content-none [&::-webkit-details-marker]:hidden"
                >
                  <span>계산 기준 및 세부내역</span>
                  <span
                    aria-hidden
                    className="text-slate-500 transition group-open:rotate-180"
                  >
                    ∨
                  </span>
                </summary>
                <div className="space-y-4 border-t border-slate-200/70 px-3 py-3">
                  <DetailItem
                    label="취득 관련 세금"
                    value={formatEokMan(purchase.acquisition.totalTaxMan)}
                    basis="취득세·지방교육세·농어촌특별세 합계"
                  />
                  <DetailItem
                    label="취득세"
                    value={formatManWon(purchase.acquisition.baseTaxMan)}
                    basis={purchase.acquisition.appliedRateLabel}
                  />
                  <DetailItem
                    label="지방교육세"
                    value={formatManWon(
                      purchase.acquisition.localEducationTaxMan,
                    )}
                  />
                  <DetailItem
                    label="농어촌특별세"
                    value={formatManWon(
                      purchase.acquisition.ruralSpecialTaxMan,
                    )}
                    basis={
                      purchase.acquisition.ruralSpecialTaxStatus ===
                      "exempt_national_housing"
                        ? "전용 85㎡ 이하 서민주택 비과세"
                        : purchase.acquisition.ruralSpecialTaxStatus ===
                            "needs_exact_area"
                          ? "전용면적 범위가 85㎡를 걸칩니다. 정확한 면적 확인이 필요합니다."
                          : purchase.acquisition.ruralSpecialTaxStatus ===
                              "unknown_area"
                            ? "전용면적 정보가 없어 확정하지 않았습니다."
                            : "전용 85㎡ 초과 · 취득가액 × 0.2%"
                    }
                  />
                  <DetailItem
                    label="중개보수"
                    value={formatManWon(purchase.brokerage.feeMan)}
                    basis={`선택 요율 ${purchase.brokerage.ratePct.toFixed(2)}% · 법정 상한 ${purchase.brokerage.legalCapRatePct.toFixed(2)}%`}
                  />
                  <div className="space-y-1.5 border-t border-slate-200/70 pt-3">
                    <p className="text-sm font-medium text-slate-800">
                      적용·미반영 안내
                    </p>
                    <ul className="space-y-1.5 text-sm leading-relaxed text-slate-700">
                      {(purchase.acquisition.notes ?? []).map((n) => (
                        <li key={n}>{n}</li>
                      ))}
                      <li>부가가치세는 사업자 유형에 따라 별도 발생할 수 있습니다.</li>
                      <li>개인별 감면·특례는 반영하지 않은 예상값입니다.</li>
                    </ul>
                    <p className="pt-1 text-xs text-slate-500">
                      {purchase.acquisition.meta.ruleVersion} /{" "}
                      {purchase.brokerage.meta.ruleVersion} · 시행{" "}
                      {purchase.acquisition.meta.effectiveFrom}
                    </p>
                  </div>
                </div>
              </details>
            ) : null}
          </div>
        ) : null}

        {tab === "holding" ? (
          <div className="space-y-3">
            <div className="flex items-baseline justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-800">
                  보유세
                  {compactArea ? (
                    <span className="font-normal text-slate-500">
                      {" "}
                      · {compactArea} 기준
                    </span>
                  ) : null}
                </p>
                <p className="mt-0.5 truncate text-xs text-slate-500">
                  {complexName}
                  {compactArea ? ` · ${compactArea}` : ""}
                </p>
              </div>
            </div>

            {holding ? (
              <dl className="space-y-2.5">
                {holding.years.slice(0, 1).map((y) => (
                  <div key={y.yearOffset} className="space-y-2.5">
                    <Row
                      label={`${holdingBaseYear}년 예상 보유세`}
                      value={formatEokMan(y.totalMan)}
                      emph
                      hint="확정 고지세액이 아닌 예상세액"
                    />
                    <div className="space-y-2 border-t border-slate-200/80 pt-2.5">
                      <Row
                        label="재산세"
                        value={formatEokMan(y.property.totalMan)}
                      />
                      <Row
                        label="종합부동산세"
                        value={formatEokMan(y.comprehensive.taxMan)}
                      />
                    </div>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="text-sm text-slate-500">
                공시가격을 입력하면 이 단지·면적 기준 보유세가 표시됩니다.
              </p>
            )}

            <div className="space-y-1.5 border-t border-slate-200/80 pt-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium text-slate-800">공시가격</p>
                <span className="text-xs text-slate-500">
                  {publicPrice.autoLink === "HOLD"
                    ? "자동연결 보류 · 직접 입력"
                    : publicPrice.autoLink === "PARTIAL"
                      ? "부분 연결"
                      : "공식 공시가격"}
                </span>
              </div>
              <ManWonField
                id="calc-official-price"
                value={officialDraft}
                placeholder="예: 168000"
                liveMan={
                  parseEokInputToMan(officialDraft) ??
                  (officialPriceMan > 0 ? officialPriceMan : null)
                }
                onFocus={() => {
                  if (officialPriceMan > 0 && !officialDraft.trim()) {
                    setOfficialDraft(formatManInput(officialPriceMan));
                  } else if (
                    officialPriceMan > 0 &&
                    /억/.test(officialDraft)
                  ) {
                    setOfficialDraft(formatManInput(officialPriceMan));
                  }
                }}
                onChange={setOfficialDraft}
                onBlur={() => commitOfficialDraft(officialDraft)}
              />
              <p className="text-sm leading-relaxed text-slate-600">
                {publicPrice.blocker ??
                  "공식 공시가격을 연결할 수 없어 직접 입력합니다. 실거래가 비율로 추정하지 않습니다."}
              </p>
              {officialPriceMan > 0 ? (
                <p className="text-xs text-slate-500">입력값 · 사용자 입력</p>
              ) : null}
            </div>

            <div className="space-y-2 border-t border-slate-200/80 pt-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-800">계산 조건</p>
                  <p className="mt-0.5 text-sm leading-relaxed text-slate-600">
                    {holdingConditionSummary}
                  </p>
                </div>
                <button
                  type="button"
                  className="shrink-0 text-sm font-medium text-teal-700 hover:underline"
                  onClick={() => setHoldingSettingsOpen(true)}
                >
                  설정 변경
                </button>
              </div>
            </div>

            {holding && holding.years.length > 1 ? (
              <div className="space-y-2 border-t border-slate-200/80 pt-3">
                <p className="text-sm font-medium text-slate-800">연도별 보유세</p>
                <ul className="space-y-2">
                  {holding.years.map((y) => {
                    const year = holdingBaseYear + y.yearOffset;
                    const kind =
                      y.yearOffset === 0 ? "입력 기준" : "예상 · 가정";
                    return (
                      <li
                        key={y.yearOffset}
                        className="flex items-start justify-between gap-3 text-sm"
                      >
                        <div className="min-w-0">
                          <p className="font-medium text-slate-800">{year}년</p>
                          <p className="text-xs text-slate-500">{kind}</p>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="font-semibold tabular-nums text-slate-900">
                            {formatEokMan(y.totalMan)}
                          </p>
                          <p className="text-xs tabular-nums text-slate-500">
                            재산 {formatManWon(y.property.totalMan)} · 종부{" "}
                            {formatManWon(y.comprehensive.taxMan)}
                          </p>
                        </div>
                      </li>
                    );
                  })}
                </ul>
                {holding.projectionDisclaimer ? (
                  <p className="text-sm leading-relaxed text-amber-900">
                    {holding.projectionDisclaimer}. 미래 연도는 공식 공시가격이
                    아닌 가정값입니다.
                  </p>
                ) : null}
              </div>
            ) : null}

            {holding ? (
              <p className="text-sm leading-relaxed text-slate-700">
                {holding.estimateDisclaimer}
              </p>
            ) : null}

            <BasisDetails
              lines={[
                ...(holding?.years[0]?.property.notes ?? []),
                ...(holding?.years[0]?.comprehensive.notes ?? []),
                "연령·장기보유 세액공제, 공동명의 특례, 법인 세율은 현재 엔진에서 지원하지 않습니다.",
              ]}
            />

            {holdingSettingsOpen ? (
              <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
                <button
                  type="button"
                  className="absolute inset-0 bg-slate-900/40"
                  aria-label="설정 닫기"
                  onClick={() => setHoldingSettingsOpen(false)}
                />
                <div
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="holding-settings-title"
                  className="relative z-10 flex max-h-[85vh] w-full max-w-md flex-col rounded-t-2xl bg-white shadow-xl sm:rounded-2xl"
                >
                  <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
                    <h3
                      id="holding-settings-title"
                      className="text-base font-semibold text-slate-900"
                    >
                      보유세 계산 조건
                    </h3>
                    <button
                      type="button"
                      className="text-sm font-medium text-teal-700"
                      onClick={() => setHoldingSettingsOpen(false)}
                    >
                      완료
                    </button>
                  </div>
                  <div className="space-y-4 overflow-y-auto px-4 py-4">
                    <div className="space-y-2">
                      <p className="text-sm font-medium text-slate-800">
                        1세대 1주택
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          className={choiceClass(singleHomeHousehold)}
                          onClick={() => setSingleHomeHousehold(true)}
                        >
                          해당
                        </button>
                        <button
                          type="button"
                          className={choiceClass(!singleHomeHousehold)}
                          onClick={() => setSingleHomeHousehold(false)}
                        >
                          해당 없음
                        </button>
                      </div>
                      <p className="text-xs leading-relaxed text-slate-500">
                        공정시장가액비율·종부세 기본공제에 반영됩니다.
                      </p>
                    </div>

                    <div className="space-y-2">
                      <p className="text-sm font-medium text-slate-800">
                        미래 전망
                      </p>
                      <div className="flex flex-wrap items-center gap-2">
                        <select
                          className="lab-input h-10 px-2 text-sm"
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
                              className="lab-input h-10 w-20 px-2 text-sm"
                              type="number"
                              min={0}
                              max={20}
                              step={0.5}
                              value={growthPct}
                              onChange={(e) =>
                                setGrowthPct(Number(e.target.value) || 0)
                              }
                            />
                            <span className="text-sm text-slate-500">
                              %/년 공시가 가정
                            </span>
                          </>
                        ) : null}
                      </div>
                      <p className="text-xs leading-relaxed text-slate-500">
                        미래 연도는 공식값이 아닌 가정이며, 현행 세제 유지를
                        전제합니다.
                      </p>
                    </div>

                    <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 text-sm leading-relaxed text-slate-700">
                      <p className="font-medium text-slate-800">현재 미지원</p>
                      <p className="mt-1">
                        연령 공제 · 장기보유 공제 · 공동명의 특례 · 법인 세율 ·
                        3주택 중과
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
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

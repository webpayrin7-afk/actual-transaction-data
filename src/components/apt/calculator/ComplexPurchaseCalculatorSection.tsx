"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { LabDisclosure } from "@/components/ui/LabDisclosure";
import { LabBottomSheet } from "@/components/ui/LabBottomSheet";
import { LabTabs } from "@/components/ui/LabTabs";
import {
  brokerageRatePctOptionsForPrice,
  calculateHoldingTax,
  calculateLoanEstimate,
  calculatePurchaseCost,
  COMPREHENSIVE_GENERAL_RATE_BRACKETS,
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

function formatPct(rate: number, digits = 0): string {
  const n = rate * 100;
  const fixed = n.toFixed(digits);
  return `${fixed.replace(/\.0+$/, "")}%`;
}

function formatSignedEokMan(man: number): string {
  if (!Number.isFinite(man)) return "—";
  if (Math.abs(man) < 0.5) return "0만원";
  const abs = formatEokMan(Math.abs(man));
  return man > 0 ? `+${abs}` : `-${abs}`;
}

function formatSignedPctPoints(rate: number, digits = 0): string {
  if (!Number.isFinite(rate)) return "—";
  const n = rate * 100;
  if (Math.abs(n) < 1e-9) return "0%";
  const fixed = Math.abs(n).toFixed(digits).replace(/\.0+$/, "");
  return `${n > 0 ? "+" : "-"}${fixed}%`;
}

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

function BreakdownRow({
  label,
  value,
  emph,
  negative,
}: {
  label: string;
  value: string;
  emph?: boolean;
  negative?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt
        className={
          emph ? "text-sm font-medium text-slate-800" : "text-sm text-slate-600"
        }
      >
        {label}
      </dt>
      <dd
        className={
          emph
            ? "shrink-0 text-sm font-bold tabular-nums text-slate-900"
            : negative
              ? "shrink-0 text-sm font-semibold tabular-nums text-slate-700"
              : "shrink-0 text-sm font-semibold tabular-nums text-slate-800"
        }
      >
        {value}
      </dd>
    </div>
  );
}

/** Notes-style disclosure (loan / fallback). */
function BasisDetails({ lines }: { lines: string[] }) {
  const cleaned = lines.map((l) => l.trim()).filter(Boolean);
  if (!cleaned.length) return null;
  return (
    <LabDisclosure title="계산 기준 및 세부내역">
      <ul className="space-y-2 text-sm leading-relaxed text-slate-700">
        {cleaned.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </LabDisclosure>
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
  // Visible chip matches AptAreaSelector compact trigger (h-8 / text-xs).
  // Native <select> stays transparent on top — global 16px !important would
  // otherwise force these controls larger than the area picker button.
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <label htmlFor={id} className="text-xs text-slate-500">
          {label}
        </label>
        {status ? (
          <p className="mt-0.5 truncate text-[11px] text-slate-500">{status}</p>
        ) : null}
      </div>
      <div className="relative inline-flex h-8 max-w-[58%] min-w-[7.5rem] items-center rounded-md border border-slate-200 bg-white px-2.5 text-xs font-semibold text-slate-800">
        <span className="pointer-events-none min-w-0 flex-1 truncate pr-4" aria-hidden>
          <FieldSelectDisplay value={String(value)} options={children} />
        </span>
        <span
          className="pointer-events-none absolute right-2 text-[10px] text-slate-400"
          aria-hidden
        >
          ▾
        </span>
        <select
          id={id}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        >
          {children}
        </select>
      </div>
    </div>
  );
}

function optionLabelText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(optionLabelText).join("");
  return "";
}

/** Resolve the selected <option> label for the compact chip face. */
function FieldSelectDisplay({
  value,
  options,
}: {
  value: string;
  options: ReactNode;
}) {
  const labels: string[] = [];
  const values: string[] = [];
  const walk = (node: ReactNode) => {
    if (node == null || typeof node === "boolean") return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node === "object" && node !== null && "props" in node) {
      const el = node as {
        props?: { value?: string | number; children?: ReactNode };
      };
      if (el.props && el.props.value != null) {
        values.push(String(el.props.value));
        const text = optionLabelText(el.props.children).trim();
        labels.push(text || String(el.props.value));
      }
    }
  };
  walk(options);
  const idx = values.indexOf(value);
  return <>{idx >= 0 ? labels[idx] : value}</>;
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
    <div className="space-y-1">
      <p className="text-sm font-medium text-slate-800">{label}</p>
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


function growthToneClass(pct: number): string {
  if (pct > 0) return "text-rose-600";
  if (pct < 0) return "text-blue-600";
  return "text-slate-700";
}

function growthTrackStyle(pct: number): CSSProperties {
  const pos = ((pct + 30) / 60) * 100;
  const neutral = "#e2e8f0";
  const up = "#fda4af"; // rose-300
  const down = "#93c5fd"; // blue-300
  if (pct > 0) {
    return {
      background: `linear-gradient(to right, ${neutral} 0%, ${neutral} 50%, ${up} 50%, ${up} ${pos}%, ${neutral} ${pos}%, ${neutral} 100%)`,
    };
  }
  if (pct < 0) {
    return {
      background: `linear-gradient(to right, ${neutral} 0%, ${neutral} ${pos}%, ${down} ${pos}%, ${down} 50%, ${neutral} 50%, ${neutral} 100%)`,
    };
  }
  return { background: neutral };
}

function growthRangeClass(pct: number): string {
  if (pct > 0) return "lab-range lab-range-up w-full";
  if (pct < 0) return "lab-range lab-range-down w-full";
  return "lab-range lab-range-neutral w-full";
}

/**
 * Compact decision-first calculator embedded in Complex Detail.
 * Shares the page area selection; personal inputs stay client-local.
 */
export function ComplexPurchaseCalculatorSection({
  complexId = null,
  complexName,
  areaKey,
  areaLabel,
  latestTradeMan,
  exclusiveAreaMinSqm = null,
  exclusiveAreaMaxSqm = null,
}: {
  /** Stable complex id when complex-detail identity is available. */
  complexId?: string | null;
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
  const [officialEditing, setOfficialEditing] = useState(false);

  const [homeStatus, setHomeStatus] =
    useState<AcquisitionHomeStatus>("one_home");
  /** null = use legal cap */
  const [brokerageRatePct, setBrokerageRatePct] = useState<number | null>(null);

  const [officialPriceMan, setOfficialPriceMan] = useState(0);
  const [officialDraft, setOfficialDraft] = useState("");
  const [officialManualOverride, setOfficialManualOverride] = useState(false);
  const [singleHomeHousehold, setSingleHomeHousehold] = useState(true);
  /** 공시가격 예상 증감률(%). 메인 슬라이더. 기본 0 */
  const [growthPct, setGrowthPct] = useState(0);

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
    setOfficialManualOverride(false);
    setOfficialEditing(false);
    setOfficialPriceMan(0);
    setOfficialDraft("");
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

  const publicPrice = useMemo(
    () =>
      getComplexPublicPrices({
        complexId,
        complexName,
        areaKey: areaKey === "all" ? null : areaKey,
        exclusiveAreaMinSqm,
        exclusiveAreaMaxSqm,
        year: new Date().getFullYear(),
      }),
    [complexId, complexName, areaKey, exclusiveAreaMinSqm, exclusiveAreaMaxSqm],
  );

  const autoOfficialPriceMan =
    publicPrice.matchType === "UNIT_EXACT" && publicPrice.priceMan != null
      ? publicPrice.priceMan
      : null;

  const effectiveOfficialPriceMan = officialManualOverride
    ? officialPriceMan
    : (autoOfficialPriceMan ?? 0);

  const officialFieldValue = officialManualOverride
    ? officialDraft
    : autoOfficialPriceMan != null
      ? formatManInput(autoOfficialPriceMan)
      : officialDraft;

  const baselinePriceMan = effectiveOfficialPriceMan;
  const projectedPriceMan =
    baselinePriceMan > 0 ? baselinePriceMan * (1 + growthPct / 100) : 0;

  const baselineHolding = useMemo(
    () =>
      baselinePriceMan > 0
        ? calculateHoldingTax({
            officialPriceMan: baselinePriceMan,
            singleHomeHousehold,
            includeUrbanShare: true,
            projectionYears: 0,
          })
        : null,
    [baselinePriceMan, singleHomeHousehold],
  );

  const projectedHolding = useMemo(
    () =>
      projectedPriceMan > 0
        ? calculateHoldingTax({
            officialPriceMan: projectedPriceMan,
            singleHomeHousehold,
            includeUrbanShare: true,
            projectionYears: 0,
          })
        : null,
    [projectedPriceMan, singleHomeHousehold],
  );

  const holding = projectedHolding;

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
  ].join(" · ");

  const holdingBaseYear = new Date().getFullYear();
  const hasOfficialUnit =
    publicPrice.matchType === "UNIT_EXACT" && autoOfficialPriceMan != null;
  const officialDateLabel = publicPrice.officialPriceDate
    ? publicPrice.officialPriceDate.replaceAll("-", ".")
    : publicPrice.priceBaseYear
      ? `${publicPrice.priceBaseYear}.1.1`
      : null;
  const unitContextParts = [
    publicPrice.dong && publicPrice.ho
      ? `${publicPrice.dong}동 · ${publicPrice.ho}호`
      : null,
    publicPrice.exclusiveArea != null
      ? `전용 ${publicPrice.exclusiveArea}㎡`
      : null,
  ].filter(Boolean) as string[];
  const holdingYear0 = holding?.years[0] ?? null;
  const baselineYear0 = baselineHolding?.years[0] ?? null;
  const taxDeltaMan =
    holdingYear0 && baselineYear0
      ? holdingYear0.totalMan - baselineYear0.totalMan
      : 0;
  const taxDeltaRate =
    baselineYear0 && baselineYear0.totalMan > 0
      ? taxDeltaMan / baselineYear0.totalMan
      : 0;
  const growthActive = growthPct !== 0;
  const officialPriceYear =
    publicPrice.priceBaseYear ??
    (publicPrice.officialPriceDate
      ? Number(publicPrice.officialPriceDate.slice(0, 4))
      : null);
  const growthLabel =
    growthPct > 0 ? `+${growthPct}%` : growthPct < 0 ? `${growthPct}%` : "0%";
  const loanConditionSummary = [
    homes === "0" ? "무주택" : homes === "1" ? "1주택" : "2주택+",
    metro === "capital" ? "수도권" : "지방",
    regulated === "regulated" ? "규제지역" : "비규제",
    firstHome ? "생애최초" : null,
  ]
    .filter(Boolean)
    .join(" · ");

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
        effectiveOfficialPriceMan > 0
          ? formatManInput(effectiveOfficialPriceMan)
          : "",
      );
      return;
    }
    setOfficialManualOverride(true);
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
            세금, 대출 계산
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

      <LabTabs
        className="mt-3"
        ariaLabel="세금, 대출 계산 메뉴"
        items={TABS}
        value={tab}
        density="compact"
        onChange={(next) => {
          setTab(next);
          setConditionsOpen(false);
          setHoldingSettingsOpen(false);
        }}
      />

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
              <LabDisclosure
                title="계산 기준 및 세부내역"
                open={purchaseBasisOpen}
                onOpenChange={setPurchaseBasisOpen}
              >
                  <div className="space-y-4">
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
              </LabDisclosure>
            ) : null}
          </div>
        ) : null}

        {tab === "holding" ? (
          <div className="space-y-3">
            <p className="text-sm font-medium text-slate-800">
              보유세
              {compactArea ? (
                <span className="font-normal text-slate-500">
                  {" "}
                  · {compactArea} 기준
                </span>
              ) : null}
            </p>

            {holdingYear0 ? (
              <dl className="space-y-2.5">
                <div className="space-y-1.5">
                  <Row
                    label={`${holdingBaseYear}년 예상 보유세`}
                    value={formatEokMan(holdingYear0.totalMan)}
                    emph
                  />
                  <div className="space-y-0.5 pl-0.5">
                    {officialDateLabel ? (
                      <p className="text-sm leading-relaxed text-slate-600">
                        {officialDateLabel} 공식 공시가격 기준
                      </p>
                    ) : (
                      <p className="text-sm leading-relaxed text-slate-600">
                        입력 공시가격 기준
                      </p>
                    )}
                    <p className="text-sm leading-relaxed text-slate-600">
                      {growthActive
                        ? `공시가격 ${growthLabel} 가정 · 현행 세제 유지`
                        : "현행 세제 유지 가정"}
                    </p>
                    {growthActive ? (
                      <p
                        className={`text-sm font-medium tabular-nums ${growthToneClass(taxDeltaMan)}`}
                      >
                        기준 대비 {formatSignedEokMan(taxDeltaMan)} ·{" "}
                        {formatSignedPctPoints(taxDeltaRate, 0)}
                      </p>
                    ) : null}
                  </div>
                </div>
                <div className="space-y-2 border-t border-slate-200/80 pt-2.5">
                  <Row
                    label="재산세 합계"
                    value={formatEokMan(holdingYear0.property.totalMan)}
                  />
                  <Row
                    label="종합부동산세"
                    value={formatEokMan(holdingYear0.comprehensive.taxMan)}
                  />
                </div>
              </dl>
            ) : (
              <p className="text-sm text-slate-500">
                공시가격을 입력하면 이 단지·면적 기준 보유세가 표시됩니다.
              </p>
            )}

            <div className="space-y-2 border-t border-slate-200/80 pt-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium text-slate-800">공시가격</p>
                {hasOfficialUnit &&
                !officialManualOverride &&
                !officialEditing ? (
                  <span className="text-xs text-slate-500">공식값</span>
                ) : officialManualOverride ? (
                  <span className="text-xs text-slate-500">사용자 입력값</span>
                ) : null}
              </div>

              {hasOfficialUnit &&
              !officialManualOverride &&
              !officialEditing ? (
                <div className="space-y-1.5">
                  <p className="text-lg font-bold tabular-nums tracking-tight text-slate-900">
                    {formatEokMan(autoOfficialPriceMan)}
                  </p>
                  {unitContextParts.length ? (
                    <p className="text-sm text-slate-600">
                      {unitContextParts.join(" · ")}
                    </p>
                  ) : null}
                  {officialDateLabel ? (
                    <p className="text-xs text-slate-500">
                      {officialDateLabel} · 국토교통부·한국부동산원
                    </p>
                  ) : null}
                  {publicPrice.usedPriorBulkYear ? (
                    <p className="text-sm leading-relaxed text-slate-600">
                      {holdingBaseYear}년 공식 공시가격은 자료 공개 후 반영됩니다.
                    </p>
                  ) : null}
                  <button
                    type="button"
                    className="text-sm font-medium text-teal-700 hover:underline"
                    onClick={() => {
                      setOfficialEditing(true);
                      setOfficialDraft(
                        formatManInput(
                          autoOfficialPriceMan ?? effectiveOfficialPriceMan,
                        ),
                      );
                    }}
                  >
                    직접 수정
                  </button>
                </div>
              ) : (
                <div className="space-y-1.5">
                  <ManWonField
                    id="calc-official-price"
                    value={
                      officialManualOverride || officialEditing
                        ? officialDraft
                        : officialFieldValue
                    }
                    placeholder="예: 16억 8,000"
                    liveMan={
                      parseEokInputToMan(officialDraft) ??
                      (effectiveOfficialPriceMan > 0
                        ? effectiveOfficialPriceMan
                        : null)
                    }
                    onFocus={() => {
                      const seed =
                        officialManualOverride || officialEditing
                          ? officialPriceMan || autoOfficialPriceMan || 0
                          : (autoOfficialPriceMan ?? officialPriceMan);
                      if (seed > 0) {
                        setOfficialDraft(formatManInput(seed));
                      }
                    }}
                    onChange={(v) => {
                      setOfficialDraft(v);
                      setOfficialManualOverride(true);
                    }}
                    onBlur={() => {
                      commitOfficialDraft(officialDraft);
                      setOfficialEditing(false);
                    }}
                  />
                  {!hasOfficialUnit ? (
                    <p className="text-sm leading-relaxed text-slate-600">
                      {publicPrice.blocker ??
                        "공식 공시가격을 연결할 수 없어 직접 입력합니다. 실거래가 비율로 추정하지 않습니다."}
                    </p>
                  ) : (
                    <button
                      type="button"
                      className="text-sm font-medium text-teal-700 hover:underline"
                      onClick={() => {
                        setOfficialManualOverride(false);
                        setOfficialEditing(false);
                        setOfficialPriceMan(0);
                        setOfficialDraft("");
                      }}
                    >
                      공식값으로 되돌리기
                    </button>
                  )}
                </div>
              )}
            </div>

            {baselinePriceMan > 0 ? (
              <div className="space-y-2.5 border-t border-slate-200/80 pt-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-medium text-slate-800">
                    공시가격 예상 증감률
                  </p>
                  <p
                    className={`text-sm font-semibold tabular-nums ${growthToneClass(growthPct)}`}
                  >
                    {growthLabel}
                  </p>
                </div>
                <div className="relative h-7">
                  <div
                    aria-hidden
                    className="pointer-events-none absolute left-0 right-0 top-1/2 h-1 -translate-y-1/2 rounded-full"
                    style={growthTrackStyle(growthPct)}
                  />
                  <input
                    type="range"
                    min={-30}
                    max={30}
                    step={1}
                    value={growthPct}
                    aria-label="공시가격 예상 증감률"
                    className={growthRangeClass(growthPct)}
                    onChange={(e) => setGrowthPct(Number(e.target.value))}
                  />
                </div>
                <div className="flex justify-between text-xs text-slate-500">
                  <span>-30%</span>
                  <span>0%</span>
                  <span>+30%</span>
                </div>
                {holdingYear0 ? (
                  <div className="space-y-1.5">
                    <Row
                      label={`${holdingBaseYear}년 예상 공시가격`}
                      value={formatEokMan(projectedPriceMan)}
                    />
                    <Row
                      label="예상 보유세"
                      value={formatEokMan(holdingYear0.totalMan)}
                    />
                    {growthActive ? (
                      <p
                        className={`text-sm font-medium tabular-nums ${growthToneClass(taxDeltaMan)}`}
                      >
                        기준 대비 {formatSignedEokMan(taxDeltaMan)} ·{" "}
                        {formatSignedPctPoints(taxDeltaRate, 0)}
                      </p>
                    ) : (
                      <p className="text-sm text-slate-600">
                        기준 공시가격과 동일합니다.
                      </p>
                    )}
                    <p className="text-sm leading-relaxed text-slate-600">
                      {growthActive
                        ? `공시가격 ${growthLabel} 가정 · 현행 세제 유지`
                        : "현행 세제 유지 가정"}
                    </p>
                  </div>
                ) : null}
              </div>
            ) : null}

            {baselinePriceMan > 0 ? (
              <div className="space-y-2 border-t border-slate-200/80 pt-3">
                <p className="text-sm font-medium text-slate-800">연도 구분</p>
                <ul className="space-y-2">
                  {officialPriceYear ? (
                    <li className="flex items-start justify-between gap-3 text-sm">
                      <div className="min-w-0">
                        <p className="font-medium text-slate-800">
                          {officialPriceYear}년 · 공식
                        </p>
                        <p className="text-xs text-slate-500">
                          공시가격만 표시 · 과거 실제 납부세액 아님
                        </p>
                      </div>
                      <p className="shrink-0 font-semibold tabular-nums text-slate-900">
                        {formatEokMan(baselinePriceMan)}
                      </p>
                    </li>
                  ) : (
                    <li className="flex items-start justify-between gap-3 text-sm">
                      <div className="min-w-0">
                        <p className="font-medium text-slate-800">기준 공시가격</p>
                        <p className="text-xs text-slate-500">
                          {officialManualOverride ? "사용자 입력" : "입력값"}
                        </p>
                      </div>
                      <p className="shrink-0 font-semibold tabular-nums text-slate-900">
                        {formatEokMan(baselinePriceMan)}
                      </p>
                    </li>
                  )}
                  {holdingYear0 ? (
                    <li className="flex items-start justify-between gap-3 text-sm">
                      <div className="min-w-0">
                        <p className="font-medium text-slate-800">
                          {holdingBaseYear}년 · 예상
                        </p>
                        <p className="text-xs text-slate-500">
                          공시가격 {growthLabel} · 현행 세제 적용 시
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="font-semibold tabular-nums text-slate-900">
                          {formatEokMan(projectedPriceMan)}
                        </p>
                        <p className="text-xs tabular-nums text-slate-500">
                          보유세 {formatEokMan(holdingYear0.totalMan)}
                        </p>
                      </div>
                    </li>
                  ) : null}
                </ul>
              </div>
            ) : null}

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
                  설정 변경 ›
                </button>
              </div>
            </div>

            {holdingYear0 ? (
              <LabDisclosure title="계산 기준 및 세부내역">
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <p className="text-sm font-semibold text-slate-900">재산세</p>
                    <dl className="space-y-1.5">
                      <BreakdownRow
                        label="공시가격"
                        value={formatEokMan(holdingYear0.property.officialPriceMan)}
                      />
                      <BreakdownRow
                        label="공정시장가액비율"
                        value={formatPct(holdingYear0.property.fairMarketRatio)}
                      />
                      <div className="space-y-0.5">
                        <BreakdownRow
                          label="과세표준"
                          value={formatEokMan(holdingYear0.property.taxBaseMan)}
                          emph
                        />
                        <p className="text-sm leading-snug text-slate-600">
                          {formatEokMan(holdingYear0.property.officialPriceMan)} ×{" "}
                          {formatPct(holdingYear0.property.fairMarketRatio)}
                        </p>
                      </div>
                      <BreakdownRow
                        label="재산세 본세"
                        value={formatManWon(holdingYear0.property.propertyTaxMan)}
                      />
                      <BreakdownRow
                        label="지방교육세"
                        value={formatManWon(
                          holdingYear0.property.localEducationTaxMan,
                        )}
                      />
                      <BreakdownRow
                        label="도시지역분"
                        value={formatManWon(holdingYear0.property.urbanShareMan)}
                      />
                      <BreakdownRow
                        label="재산세 합계"
                        value={formatEokMan(holdingYear0.property.totalMan)}
                        emph
                      />
                    </dl>
                  </div>

                  <div className="space-y-1.5 border-t border-slate-100 pt-3">
                    <p className="text-sm font-semibold text-slate-900">
                      종합부동산세
                    </p>
                    <dl className="space-y-1.5">
                      <BreakdownRow
                        label="공시가격 합계"
                        value={formatEokMan(
                          holdingYear0.comprehensive.officialPriceMan,
                        )}
                      />
                      <BreakdownRow
                        label="기본공제"
                        value={formatEokMan(
                          holdingYear0.comprehensive.deductionMan,
                        )}
                      />
                      <BreakdownRow
                        label="공정시장가액비율"
                        value={formatPct(
                          holdingYear0.comprehensive.fairMarketRatio,
                        )}
                      />
                      <div className="space-y-0.5">
                        <BreakdownRow
                          label="과세표준"
                          value={formatEokMan(
                            holdingYear0.comprehensive.taxBaseMan,
                          )}
                          emph
                        />
                        <p className="text-sm leading-snug text-slate-600">
                          ({formatEokMan(
                            holdingYear0.comprehensive.officialPriceMan,
                          )}{" "}
                          −{" "}
                          {formatEokMan(
                            holdingYear0.comprehensive.deductionMan,
                          )}
                          ) ×{" "}
                          {formatPct(
                            holdingYear0.comprehensive.fairMarketRatio,
                          )}
                        </p>
                      </div>
                      {holdingYear0.comprehensive.taxable &&
                      holdingYear0.comprehensive.appliedBracketLabel &&
                      holdingYear0.comprehensive.appliedRate != null ? (
                        <>
                          <BreakdownRow
                            label="적용 구간"
                            value={
                              holdingYear0.comprehensive.appliedBracketLabel
                            }
                          />
                          <BreakdownRow
                            label="적용 세율"
                            value={formatPct(
                              holdingYear0.comprehensive.appliedRate,
                              1,
                            )}
                          />
                        </>
                      ) : (
                        <p className="text-sm text-slate-600">
                          기본공제 이하로 종부세 과세대상이 아닙니다.
                        </p>
                      )}
                      <BreakdownRow
                        label="산출세액"
                        value={formatManWon(
                          holdingYear0.comprehensive.taxMan,
                        )}
                      />
                      <BreakdownRow
                        label="종합부동산세 합계"
                        value={formatEokMan(
                          holdingYear0.comprehensive.taxMan,
                        )}
                        emph
                      />
                    </dl>
                    <LabDisclosure title="전체 세율표 보기" className="border-t-0">
                      <dl className="space-y-1.5">
                        {COMPREHENSIVE_GENERAL_RATE_BRACKETS.map((b) => (
                          <BreakdownRow
                            key={b.label}
                            label={b.label}
                            value={formatPct(b.rate, 1)}
                          />
                        ))}
                      </dl>
                      <p className="mt-2 text-xs text-slate-500">
                        2026년 현행 세제 기준
                      </p>
                    </LabDisclosure>
                  </div>

                  <div className="space-y-1.5 border-t border-slate-200 pt-3">
                    <BreakdownRow
                      label="예상 총 보유세"
                      value={formatEokMan(holdingYear0.totalMan)}
                      emph
                    />
                    <p className="text-sm text-slate-600">
                      재산세 합계 {formatEokMan(holdingYear0.property.totalMan)}{" "}
                      + 종합부동산세 합계{" "}
                      {formatEokMan(holdingYear0.comprehensive.taxMan)}
                    </p>
                    <p className="text-sm leading-relaxed text-slate-700">
                      {holding?.estimateDisclaimer}
                    </p>
                    <p className="text-xs text-slate-500">2026년 현행 세제 기준</p>
                  </div>
                </div>
              </LabDisclosure>
            ) : null}

            {holdingSettingsOpen ? (
              <LabBottomSheet
                open={holdingSettingsOpen}
                onClose={() => setHoldingSettingsOpen(false)}
                title="보유세 계산 조건"
              >
                <div className="space-y-4">
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
                    <p className="text-sm leading-relaxed text-slate-600">
                      공정시장가액비율과 종합부동산세 기본공제 등에 반영됩니다.
                    </p>
                  </div>

                  <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 text-sm leading-relaxed text-slate-700">
                    <p className="font-medium text-slate-800">현재 미반영 항목</p>
                    <p className="mt-1">
                      고령자 공제 · 장기보유 공제 · 공동명의 특례 등
                    </p>
                  </div>
                </div>
              </LabBottomSheet>
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

            <div className="grid gap-2.5 sm:grid-cols-3">
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
            </div>

            <div className="space-y-2 border-t border-slate-200/80 pt-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-800">계산 조건</p>
                  <p className="mt-0.5 text-sm leading-relaxed text-slate-600">
                    {loanConditionSummary}
                  </p>
                </div>
                <button
                  type="button"
                  className="shrink-0 text-sm font-medium text-teal-700 hover:underline"
                  onClick={() => setConditionsOpen(true)}
                >
                  설정 변경 ›
                </button>
              </div>
            </div>

            <LabBottomSheet
              open={conditionsOpen}
              onClose={() => setConditionsOpen(false)}
              title="대출 계산 조건"
            >
              <div className="grid gap-2.5 sm:grid-cols-2">
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
                <label className="block space-y-1 sm:col-span-2">
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
            </LabBottomSheet>

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

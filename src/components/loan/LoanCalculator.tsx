"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { LoanLimitCalculator } from "@/components/loan/LoanLimitCalculator";
import {
  ChoiceChip,
  Field,
  ModeTabButton,
  Segmented,
  inputClass,
} from "@/components/loan/loan-ui";
import { LabCard } from "@/components/ui/lab";
import { PAGE_SHELL, PageHeader } from "@/components/layout/PageHeader";
import {
  LOAN_PAGE_MODES,
  loanPageModeFromSearchParams,
  type LoanPageMode,
} from "@/lib/loan/mode";
import {
  MAX_PRINCIPAL_MAN,
  MAX_RATE_PCT,
  MAX_YEARS,
  MIN_RATE_PCT,
  MIN_YEARS,
  RATE_COMPARE_DELTA_PCT,
  compareRateScenarios,
  formatManHuman,
  formatSignedWon,
  formatWon,
  parseManInput,
  parseRateInput,
  summarizeRepayment,
  type RateScenario,
  type RepaymentMethod,
  type RepaySummary,
} from "@/lib/loan/repay";

const YEAR_PRESETS = [10, 15, 20, 25, 30, 35, 40] as const;

const DISCLAIMER =
  "계산 결과는 입력값을 기준으로 한 참고용이며, 실제 대출 가능 금액과 조건은 금융기관 심사에 따라 달라질 수 있습니다.";

const PANEL_SCROLL =
  "scroll-mt-[calc(var(--site-header-height,3.5rem)+var(--lab-quicknav-height,0px)+0.75rem)]";

function initialRateFromQuery(searchParams: URLSearchParams): string {
  const raw = searchParams.get("rate");
  if (!raw) return "4.0";
  const parsed = parseRateInput(raw);
  if (parsed == null) return "4.0";
  return String(Number(parsed.toFixed(2)));
}

function formatPrincipalDisplay(digits: string): string {
  if (!digits) return "";
  const n = Number(digits);
  if (!Number.isFinite(n)) return digits;
  return n.toLocaleString("ko-KR");
}

function formatRatePct(pct: number): string {
  const rounded = Math.round(pct * 100) / 100;
  return `${Number(rounded.toFixed(2))}%`;
}

function sanitizeRateInput(raw: string): string {
  const next = raw.replace(/[^\d.]/g, "");
  const parts = next.split(".");
  const normalized =
    parts.length > 2 ? `${parts[0]}.${parts.slice(1).join("")}` : next;
  return normalized.slice(0, 6);
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return true;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function LoanCalculator() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const mode = loanPageModeFromSearchParams(searchParams);

  // 금리 정보 탭은 /rates로 이전 — 구 URL 호환
  useEffect(() => {
    if (searchParams.get("mode") === "rates") {
      router.replace("/rates");
    }
  }, [router, searchParams]);
  const principalId = "loan-principal";
  const yearsId = "loan-years";
  const rateId = "loan-rate";
  const methodLabelId = "loan-method-label";
  const yearsLabelId = "loan-years-label";

  const [principalRaw, setPrincipalRaw] = useState("30000");
  const [years, setYears] = useState(30);
  const [yearsRaw, setYearsRaw] = useState("30");
  const [rateRaw, setRateRaw] = useState(() => initialRateFromQuery(searchParams));
  const [method, setMethod] = useState<RepaymentMethod>("equal_payment");
  const pendingRepayFocus = useRef(false);

  const principalMan = parseManInput(principalRaw);
  const ratePct = parseRateInput(rateRaw);

  const principalError =
    principalMan == null || principalMan <= 0
      ? "대출금액을 1만 원 이상 입력하세요. 최대 100억 원입니다."
      : undefined;
  const yearsError =
    years < MIN_YEARS || years > MAX_YEARS
      ? `대출기간은 ${MIN_YEARS}–${MAX_YEARS}년입니다.`
      : undefined;
  const rateError =
    ratePct == null
      ? `금리는 ${MIN_RATE_PCT}% 이상 ${MAX_RATE_PCT}% 이하로 입력하세요. 0%도 가능합니다.`
      : undefined;

  const valid =
    principalError == null &&
    yearsError == null &&
    rateError == null &&
    ratePct != null &&
    principalMan != null;

  const principalWon = (principalMan ?? 0) * 10_000;

  const current = useMemo(() => {
    if (!valid || ratePct == null) return null;
    return summarizeRepayment(principalWon, ratePct, years, method);
  }, [valid, principalWon, ratePct, years, method]);

  const comparison = useMemo(() => {
    if (!valid || ratePct == null) return null;
    return compareRateScenarios(
      principalWon,
      years,
      method,
      ratePct,
      RATE_COMPARE_DELTA_PCT,
    );
  }, [valid, principalWon, ratePct, years, method]);

  function replaceMode(next: LoanPageMode) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("mode", next);
    const qs = params.toString();
    router.replace(qs ? `/loan?${qs}` : "/loan", { scroll: false });
  }

  function onPrincipalChange(value: string) {
    const parsed = parseManInput(value);
    setPrincipalRaw(parsed == null ? "" : String(parsed));
  }

  function onYearsChange(value: number) {
    const next = Math.min(MAX_YEARS, Math.max(MIN_YEARS, value));
    setYears(next);
    setYearsRaw(String(next));
  }

  function onYearsInput(raw: string) {
    const digits = raw.replace(/\D/g, "").slice(0, 2);
    setYearsRaw(digits);
    if (!digits) return;
    const n = Number(digits);
    if (Number.isFinite(n) && n >= MIN_YEARS && n <= MAX_YEARS) {
      setYears(n);
    }
  }

  function onGoToRepayment(payload: {
    principalMan: number;
    years: number;
    rate: string;
  }) {
    const capped = Math.min(
      MAX_PRINCIPAL_MAN,
      Math.max(0, Math.round(payload.principalMan)),
    );
    if (capped <= 0) return;
    setPrincipalRaw(String(capped));
    onYearsChange(payload.years);
    const parsedRate = parseRateInput(payload.rate);
    if (parsedRate != null) {
      setRateRaw(String(Number(parsedRate.toFixed(2))));
    }
    pendingRepayFocus.current = true;
    replaceMode("repayment");
  }

  useEffect(() => {
    if (mode !== "repayment" || !pendingRepayFocus.current) return;
    pendingRepayFocus.current = false;
    const panel = document.getElementById("loan-repay-panel");
    const input = document.getElementById("loan-principal");
    const behavior = prefersReducedMotion() ? "auto" : "smooth";
    panel?.scrollIntoView({ block: "start", behavior });
    window.setTimeout(() => {
      input?.focus({ preventScroll: true });
    }, prefersReducedMotion() ? 0 : 250);
  }, [mode]);

  const lastDiffers =
    current != null &&
    current.monthlyPaymentWon != null &&
    current.lastMonthWon !== current.monthlyPaymentWon;

  return (
    <div className={`${PAGE_SHELL} max-w-3xl overflow-x-hidden`}>
      <PageHeader
        title="대출 계산기"
        description="LTV·DSR·DTI 한도와 월 상환액·총이자를 계산합니다. 금리 정보는 메뉴의 금리정보에서 확인하세요."
      />

      <div
        role="tablist"
        aria-label="계산 종류"
        className="grid grid-cols-2 gap-1 rounded-[var(--lab-radius-md)] border border-[color:var(--lab-border)] bg-white p-1"
        onKeyDown={(event) => {
          if (
            event.key !== "ArrowRight" &&
            event.key !== "ArrowLeft" &&
            event.key !== "ArrowDown" &&
            event.key !== "ArrowUp"
          ) {
            return;
          }
          event.preventDefault();
          const idx = LOAN_PAGE_MODES.findIndex((item) => item.id === mode);
          const delta =
            event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
          const next =
            LOAN_PAGE_MODES[
              (idx + delta + LOAN_PAGE_MODES.length) % LOAN_PAGE_MODES.length
            ];
          replaceMode(next.id);
          window.requestAnimationFrame(() => {
            document.getElementById(`loan-mode-${next.id}`)?.focus();
          });
        }}
      >
        {LOAN_PAGE_MODES.map((item) => (
          <ModeTab
            key={item.id}
            id={`loan-mode-${item.id}`}
            selected={mode === item.id}
            controls={item.panelId}
            title={item.label}
            onSelect={() => replaceMode(item.id)}
          />
        ))}
      </div>

      <div
        id="loan-limit-panel"
        role="tabpanel"
        aria-labelledby="loan-mode-limit"
        hidden={mode !== "limit"}
        className={PANEL_SCROLL}
      >
        <LoanLimitCalculator
          years={years}
          onYearsChange={onYearsChange}
          rate={rateRaw}
          onRateChange={(value) => setRateRaw(sanitizeRateInput(value))}
          onGoToRepayment={onGoToRepayment}
        />
      </div>

      <div
        id="loan-repay-panel"
        role="tabpanel"
        aria-labelledby="loan-mode-repayment"
        hidden={mode !== "repayment"}
        className={PANEL_SCROLL}
      >
        {mode === "repayment" ? (
          <div className="flex flex-col gap-5">
            <form className="flex flex-col gap-5" onSubmit={(e) => e.preventDefault()}>
              <LabCard className="p-4 sm:p-5">
                <h2 className="detail-subsection-title">대출 조건</h2>
                <div className="mt-4 flex flex-col gap-4">
                  <Field
                    id={principalId}
                    label="대출금액 (만원)"
                    hint={
                      principalMan && principalMan > 0
                        ? formatManHuman(principalMan)
                        : "예: 30000 = 3억"
                    }
                    error={principalError}
                  >
                    <input
                      id={principalId}
                      className={inputClass}
                      inputMode="numeric"
                      autoComplete="off"
                      value={formatPrincipalDisplay(principalRaw)}
                      onChange={(e) => onPrincipalChange(e.target.value)}
                      aria-invalid={principalError != null}
                      aria-describedby={
                        principalError
                          ? `${principalId}-error`
                          : `${principalId}-hint`
                      }
                      maxLength={11}
                    />
                  </Field>

                  <div className="flex flex-col gap-1.5">
                    <p id={yearsLabelId} className="detail-label font-medium">
                      대출기간
                    </p>
                    <div
                      role="radiogroup"
                      aria-labelledby={yearsLabelId}
                      className="flex flex-wrap gap-2"
                    >
                      {YEAR_PRESETS.map((y) => (
                      <ChoiceChip
                        key={y}
                        selected={years === y}
                        onClick={() => onYearsChange(y)}
                      >
                        {y}년
                      </ChoiceChip>
                    ))}
                    </div>
                    <label htmlFor={yearsId} className="sr-only">
                      대출기간 (년)
                    </label>
                    <input
                      id={yearsId}
                      className={`${inputClass} max-w-[8rem]`}
                      inputMode="numeric"
                      autoComplete="off"
                      value={yearsRaw}
                      onChange={(e) => onYearsInput(e.target.value)}
                      onBlur={() => {
                        if (!yearsRaw) {
                          setYearsRaw(String(years));
                          return;
                        }
                        const n = Number(yearsRaw);
                        if (!Number.isFinite(n) || n < MIN_YEARS || n > MAX_YEARS) {
                          setYearsRaw(String(years));
                        }
                      }}
                      aria-invalid={yearsError != null}
                    />
                    {yearsError ? (
                      <p role="alert" className="detail-meta text-rose-600">
                        {yearsError}
                      </p>
                    ) : null}
                  </div>

                  <Field
                    id={rateId}
                    label="금리 (%)"
                    hint="0–20% · 소수점 가능"
                    error={rateRaw !== "" && rateError ? rateError : undefined}
                  >
                    <input
                      id={rateId}
                      className={inputClass}
                      inputMode="decimal"
                      autoComplete="off"
                      value={rateRaw}
                      onChange={(e) => setRateRaw(sanitizeRateInput(e.target.value))}
                      aria-invalid={rateRaw !== "" && rateError != null}
                      aria-describedby={`${rateId}-hint`}
                    />
                  </Field>
                  {rateRaw === "" ? (
                    <p role="alert" className="detail-meta text-rose-600">
                      {rateError}
                    </p>
                  ) : null}

                  <div className="flex flex-col gap-1.5">
                    <p id={methodLabelId} className="detail-label font-medium">
                      상환방식
                    </p>
                    <Segmented
                      labelledBy={methodLabelId}
                      value={method}
                      onChange={setMethod}
                      options={[
                        { value: "equal_payment", label: "원리금균등" },
                        { value: "equal_principal", label: "원금균등" },
                      ]}
                    />
                  </div>
                </div>
              </LabCard>
            </form>

            <div aria-live="polite" className="flex flex-col gap-5">
              {current && comparison && principalMan != null ? (
                <>
                  <CurrentResult
                    summary={current}
                    principalMan={principalMan}
                    lastDiffers={Boolean(lastDiffers)}
                  />
                  <RateDeltaSection comparison={comparison} method={method} />
                  <ScenarioList scenarios={comparison.scenarios} method={method} />
                  <details className="lab-card px-4 py-3">
                    <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium text-[color:var(--lab-navy-900)]">
                      계산 기준 보기
                    </summary>
                    <div className="mt-3">
                      <RepayDetails summary={current} />
                    </div>
                  </details>
                </>
              ) : (
                <section className="lab-card p-5 text-sm text-[color:var(--lab-muted)]">
                  대출금액, 기간, 금리를 확인하면 상환액과 금리 비교가 표시됩니다.
                </section>
              )}
            </div>

            <p className="detail-meta">{DISCLAIMER}</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ModeTab({
  id,
  selected,
  controls,
  title,
  onSelect,
}: {
  id: string;
  selected: boolean;
  controls: string;
  title: string;
  onSelect: () => void;
}) {
  return (
    <ModeTabButton
      id={id}
      role="tab"
      aria-selected={selected}
      aria-controls={controls}
      tabIndex={selected ? 0 : -1}
      onClick={onSelect}
      selected={selected}
    >
      {title}
    </ModeTabButton>
  );
}

function CurrentResult({
  summary,
  principalMan,
  lastDiffers,
}: {
  summary: RepaySummary;
  principalMan: number;
  lastDiffers: boolean;
}) {
  const equalPayment = summary.method === "equal_payment";
  return (
    <LabCard className="p-5">
      <p className="detail-label font-medium">현재 조건 결과</p>
      <p className="mt-1 detail-meta">
        {formatManHuman(principalMan)}원 · {summary.years}년 ·{" "}
        {formatRatePct(summary.annualRatePct)} ·{" "}
        {equalPayment ? "원리금균등" : "원금균등"}
      </p>
      {equalPayment && summary.monthlyPaymentWon != null ? (
        <>
          <p className="mt-4 detail-label">월 상환액</p>
          <p className="mt-1 detail-hero-value break-words tabular-nums">
            {formatWon(summary.monthlyPaymentWon)}
          </p>
          {lastDiffers ? (
            <p className="mt-2 detail-meta">
              마지막 달은 잔액 정산으로 {formatWon(summary.lastMonthWon)}
            </p>
          ) : null}
        </>
      ) : (
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <HeroStat label="첫 달 납입액" value={formatWon(summary.firstMonthWon)} />
          <HeroStat label="마지막 달 납입액" value={formatWon(summary.lastMonthWon)} />
        </div>
      )}
      <dl className="mt-4 grid grid-cols-1 gap-3 border-t border-[color:var(--lab-border)] pt-4 sm:grid-cols-2">
        <div>
          <dt className="detail-label">총 이자</dt>
          <dd className="mt-0.5 break-words detail-data-value-emphasis tabular-nums">
            {formatWon(summary.totalInterestWon)}
          </dd>
        </div>
        <div>
          <dt className="detail-label">총 상환액</dt>
          <dd className="mt-0.5 break-words detail-data-value-emphasis tabular-nums">
            {formatWon(summary.totalPaymentWon)}
          </dd>
        </div>
      </dl>
    </LabCard>
  );
}

function HeroStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="detail-label">{label}</p>
      <p className="mt-1 detail-summary-value break-words tabular-nums">
        {value}
      </p>
    </div>
  );
}

function RateDeltaSection({
  comparison,
  method,
}: {
  comparison: NonNullable<ReturnType<typeof compareRateScenarios>>;
  method: RepaymentMethod;
}) {
  const higher = comparison.scenarios.find((s) => s.kind === "higher");
  const delta = comparison.vsHigher;
  if (!higher || !delta) {
    return (
      <section className="lab-card p-4 sm:p-5">
        <h2 className="detail-subsection-title">금리 변화 시 부담 차이</h2>
        <p className="mt-2 text-sm text-slate-500">
          기준 금리가 0%라 더 낮은 금리는 비교하지 않습니다. +
          {RATE_COMPARE_DELTA_PCT}%p 시나리오가 없으면 금리를 낮춰 입력해 보세요.
        </p>
      </section>
    );
  }

  const from = formatRatePct(comparison.baseRatePct);
  const to = formatRatePct(higher.ratePct);
  const step = formatRatePct(higher.ratePct - comparison.baseRatePct).replace(
    "%",
    "%p",
  );

  return (
    <section className="lab-card p-4 sm:p-5">
      <h2 className="detail-subsection-title">금리 변화 시 부담 차이</h2>
      <p className="mt-1 text-sm leading-6 text-slate-600">
        금리가 {from}에서 {to}로 {step} 오르면
      </p>
      <dl className="mt-4 grid grid-cols-1 gap-3">
        {method === "equal_payment" && delta.monthlyDeltaWon != null ? (
          <>
            <DeltaRow label="월 부담" value={formatSignedWon(delta.monthlyDeltaWon)} />
            {delta.annualDeltaWon != null ? (
              <DeltaRow
                label="연간 부담"
                value={formatSignedWon(delta.annualDeltaWon)}
              />
            ) : null}
            <DeltaRow
              label="총 이자"
              value={formatSignedWon(delta.totalInterestDeltaWon)}
            />
          </>
        ) : (
          <>
            <DeltaRow
              label="첫 달 납입액"
              value={formatSignedWon(delta.firstMonthDeltaWon)}
            />
            <DeltaRow
              label="마지막 달 납입액"
              value={formatSignedWon(delta.lastMonthDeltaWon)}
            />
            <DeltaRow
              label="총 이자"
              value={formatSignedWon(delta.totalInterestDeltaWon)}
            />
            <DeltaRow
              label="총 상환액"
              value={formatSignedWon(delta.totalPaymentDeltaWon)}
            />
          </>
        )}
      </dl>
    </section>
  );
}

function DeltaRow({ label, value }: { label: string; value: string }) {
  const up = value.startsWith("+");
  const down = value.startsWith("-");
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3 rounded-[var(--lab-radius-md)] border border-[color:var(--lab-border)] bg-white px-3 py-3">
      <dt className="detail-label shrink-0">{label}</dt>
      <dd
        className={`min-w-0 break-words text-right detail-data-value-emphasis tabular-nums ${
          up ? "text-rose-700" : down ? "text-[color:var(--lab-teal-700)]" : "text-slate-900"
        }`}
      >
        <span className="sr-only">{up ? "증가 " : down ? "감소 " : ""}</span>
        {value}
      </dd>
    </div>
  );
}

function ScenarioList({
  scenarios,
  method,
}: {
  scenarios: RateScenario[];
  method: RepaymentMethod;
}) {
  return (
    <section>
      <h2 className="detail-subsection-title">금리별 비교</h2>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {scenarios.map((scenario) => (
          <article
            key={`${scenario.kind}-${scenario.ratePct}`}
            className={`lab-card min-w-0 p-4 ${
              scenario.kind === "base"
                ? "border-[color:var(--lab-teal-600)] bg-white"
                : "border-slate-200 bg-white"
            }`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <p className="detail-data-value-emphasis tabular-nums">
                {formatRatePct(scenario.ratePct)}
              </p>
              <span
                className={`rounded-full px-2 py-0.5 text-xs! leading-4 font-medium ${
                  scenario.kind === "base"
                    ? "lab-badge"
                    : "border border-[color:var(--lab-border)] bg-white text-[color:var(--lab-body)]"
                }`}
              >
                {scenario.kind === "base" ? "기준" : scenario.label}
              </span>
            </div>
            <dl className="mt-3 space-y-2 text-sm">
              {method === "equal_payment" &&
              scenario.summary.monthlyPaymentWon != null ? (
                <CompactStat
                  label="월 상환액"
                  value={formatWon(scenario.summary.monthlyPaymentWon)}
                />
              ) : (
                <>
                  <CompactStat
                    label="첫 달"
                    value={formatWon(scenario.summary.firstMonthWon)}
                  />
                  <CompactStat
                    label="마지막 달"
                    value={formatWon(scenario.summary.lastMonthWon)}
                  />
                </>
              )}
              <CompactStat
                label="총 이자"
                value={formatWon(scenario.summary.totalInterestWon)}
              />
              <CompactStat
                label="총 상환액"
                value={formatWon(scenario.summary.totalPaymentWon)}
              />
            </dl>
          </article>
        ))}
      </div>
    </section>
  );
}

function CompactStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-2">
      <dt className="shrink-0 detail-label">{label}</dt>
      <dd className="min-w-0 break-words text-right font-medium tabular-nums text-slate-900">
        {value}
      </dd>
    </div>
  );
}

function RepayDetails({ summary }: { summary: RepaySummary }) {
  return (
    <div>
      <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <CompactStat
          label="상환 횟수"
          value={`${summary.months.toLocaleString("ko-KR")}회`}
        />
        <CompactStat
          label="첫 해 납입액"
          value={formatWon(summary.firstYearPaymentWon)}
        />
      </dl>
      <p className="mt-3 detail-meta">
        원리금균등·원금균등, 원 단위 반올림. 마지막 달은 잔액 정산이 반영됩니다.
        금리 ±{RATE_COMPARE_DELTA_PCT}%p 시나리오를 함께 표시합니다.
      </p>
    </div>
  );
}

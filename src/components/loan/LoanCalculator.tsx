"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { LoanLimitCalculator } from "@/components/loan/LoanLimitCalculator";
import { Field, Segmented, inputClass } from "@/components/loan/loan-ui";
import { loanPageModeFromSearchParams, type LoanPageMode } from "@/lib/loan/mode";
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
  "본 계산 결과는 참고용이며 실제 대출금리와 상환액은 금융기관, 신용도, 담보조건, 계산 방식 등에 따라 달라질 수 있습니다.";

const PANEL_SCROLL =
  "scroll-mt-[calc(var(--site-header-height,3.5rem)+0.75rem)]";

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
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 overflow-x-hidden px-4 py-6 sm:px-6">
      <div>
        <p className="text-xs font-medium tracking-wide text-teal-700">도구</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">
          주택담보대출 계산기
        </h1>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          대출 가능 한도부터 월 상환액과 금리 변화에 따른 부담까지 계산해보세요.
        </p>
      </div>

      <div
        role="tablist"
        aria-label="계산 종류"
        className="grid grid-cols-1 gap-2 min-[360px]:grid-cols-2"
        onKeyDown={(event) => {
          if (event.key !== "ArrowRight" && event.key !== "ArrowLeft" && event.key !== "ArrowDown" && event.key !== "ArrowUp") {
            return;
          }
          event.preventDefault();
          const next = mode === "limit" ? "repayment" : "limit";
          replaceMode(next);
          window.requestAnimationFrame(() => {
            document
              .getElementById(
                next === "limit" ? "loan-mode-limit" : "loan-mode-repayment",
              )
              ?.focus();
          });
        }}
      >
        <ModeTab
          selected={mode === "limit"}
          controls="loan-limit-panel"
          title="대출 한도 계산"
          description="이 집을 사려면 얼마까지 나올까"
          onSelect={() => replaceMode("limit")}
        />
        <ModeTab
          selected={mode === "repayment"}
          controls="loan-repay-panel"
          title="상환액 · 금리 비교"
          description="빌리면 한 달에 얼마 내지"
          onSelect={() => replaceMode("repayment")}
        />
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
              <section className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
                <h2 className="text-sm font-semibold text-slate-900">대출 조건</h2>
                <div className="mt-4 flex flex-col gap-4">
                  <Field
                    id={principalId}
                    label="대출금액 (만원)"
                    hint={
                      principalMan && principalMan > 0
                        ? `${formatManHuman(principalMan)} · 최대 ${formatManHuman(MAX_PRINCIPAL_MAN)}`
                        : "숫자만 입력 · 예: 30000 = 3억"
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
                    <p id={yearsLabelId} className="text-xs font-medium text-slate-500">
                      대출기간
                    </p>
                    <p className="text-[11px] leading-4 text-slate-400">
                      자주 쓰는 기간을 고르거나 1–50년을 직접 입력하세요.
                    </p>
                    <div
                      role="radiogroup"
                      aria-labelledby={yearsLabelId}
                      className="flex flex-wrap gap-2"
                    >
                      {YEAR_PRESETS.map((y) => (
                        <button
                          key={y}
                          type="button"
                          role="radio"
                          aria-checked={years === y}
                          onClick={() => onYearsChange(y)}
                          className={`rounded-lg px-3 py-2 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/40 ${
                            years === y
                              ? "bg-teal-700 text-white"
                              : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                          }`}
                        >
                          {y}년
                        </button>
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
                      <p role="alert" className="text-xs text-rose-600">
                        {yearsError}
                      </p>
                    ) : null}
                  </div>

                  <Field
                    id={rateId}
                    label="금리 (%)"
                    hint="소수점 입력 가능 · 0% 허용 · 최대 20%"
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
                    <p role="alert" className="text-xs text-rose-600">
                      {rateError}
                    </p>
                  ) : null}

                  <div className="flex flex-col gap-1.5">
                    <p id={methodLabelId} className="text-xs font-medium text-slate-500">
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
              </section>
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
                  <RepayDetails summary={current} />
                </>
              ) : (
                <section className="rounded-2xl border border-slate-200 bg-white p-5 text-sm text-slate-500">
                  대출금액, 기간, 금리를 확인하면 상환액과 금리 비교가 표시됩니다.
                </section>
              )}
            </div>

            <p className="text-xs leading-5 text-slate-500">{DISCLAIMER}</p>

            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
              <p className="text-sm text-slate-600">
                내 소득과 주택가격 기준으로 대출 한도도 확인해보세요.
              </p>
              <button
                type="button"
                onClick={() => replaceMode("limit")}
                className="mt-3 text-sm font-medium text-teal-800 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/40"
              >
                대출 한도 계산하기
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ModeTab({
  selected,
  controls,
  title,
  description,
  onSelect,
}: {
  selected: boolean;
  controls: string;
  title: string;
  description: string;
  onSelect: () => void;
}) {
  const id =
    controls === "loan-limit-panel" ? "loan-mode-limit" : "loan-mode-repayment";
  return (
    <button
      id={id}
      type="button"
      role="tab"
      aria-selected={selected}
      aria-controls={controls}
      tabIndex={selected ? 0 : -1}
      onClick={onSelect}
      className={`min-w-0 rounded-2xl border px-4 py-3.5 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/40 ${
        selected
          ? "border-teal-700 bg-teal-50 shadow-sm"
          : "border-slate-200 bg-white hover:border-teal-200 hover:bg-slate-50"
      }`}
    >
      <span className="block text-sm font-semibold text-slate-900 sm:text-base">
        {title}
      </span>
      <span className="mt-1 block text-xs leading-5 text-slate-500">
        {description}
      </span>
    </button>
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
    <section className="rounded-2xl border border-teal-900/10 bg-gradient-to-br from-slate-900 via-teal-900 to-slate-800 p-5 text-white shadow-sm">
      <p className="text-xs font-medium text-teal-100/90">현재 조건 결과</p>
      <p className="mt-1 text-sm text-teal-100/75">
        {formatManHuman(principalMan)}원 · {summary.years}년 ·{" "}
        {formatRatePct(summary.annualRatePct)} ·{" "}
        {equalPayment ? "원리금균등" : "원금균등"}
      </p>
      {equalPayment && summary.monthlyPaymentWon != null ? (
        <>
          <p className="mt-4 text-sm text-teal-100/80">월 상환액</p>
          <p className="mt-1 break-words text-3xl font-semibold tracking-tight tabular-nums">
            {formatWon(summary.monthlyPaymentWon)}
          </p>
          {lastDiffers ? (
            <p className="mt-2 text-xs leading-5 text-teal-100/70">
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
      <dl className="mt-4 grid grid-cols-1 gap-3 border-t border-white/10 pt-4 sm:grid-cols-2">
        <div>
          <dt className="text-xs text-teal-100/70">총 이자</dt>
          <dd className="mt-0.5 break-words text-base font-semibold tabular-nums">
            {formatWon(summary.totalInterestWon)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-teal-100/70">총 상환액</dt>
          <dd className="mt-0.5 break-words text-base font-semibold tabular-nums">
            {formatWon(summary.totalPaymentWon)}
          </dd>
        </div>
      </dl>
    </section>
  );
}

function HeroStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-sm text-teal-100/80">{label}</p>
      <p className="mt-1 break-words text-2xl font-semibold tracking-tight tabular-nums">
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
      <section className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
        <h2 className="text-sm font-semibold text-slate-900">금리 변화 시 부담 차이</h2>
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
    <section className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
      <h2 className="text-sm font-semibold text-slate-900">금리 변화 시 부담 차이</h2>
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
    <div className="flex min-w-0 items-baseline justify-between gap-3 rounded-xl bg-slate-50 px-3 py-3">
      <dt className="shrink-0 text-sm text-slate-600">{label}</dt>
      <dd
        className={`min-w-0 break-words text-right text-base font-semibold tabular-nums ${
          up ? "text-rose-700" : down ? "text-teal-800" : "text-slate-900"
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
      <h2 className="text-sm font-semibold text-slate-900">금리별 비교</h2>
      <p className="mt-1 text-sm text-slate-500">
        현재 금리와 ±{RATE_COMPARE_DELTA_PCT}%p 시나리오입니다.
      </p>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {scenarios.map((scenario) => (
          <article
            key={`${scenario.kind}-${scenario.ratePct}`}
            className={`min-w-0 rounded-2xl border p-4 ${
              scenario.kind === "base"
                ? "border-teal-600 bg-teal-50/60 ring-2 ring-teal-600/20"
                : "border-slate-200 bg-white"
            }`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-base font-semibold text-slate-900">
                {formatRatePct(scenario.ratePct)}
              </p>
              <span
                className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                  scenario.kind === "base"
                    ? "bg-teal-700 text-white"
                    : "bg-slate-100 text-slate-600"
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
      <dt className="shrink-0 text-xs text-slate-500">{label}</dt>
      <dd className="min-w-0 break-words text-right font-medium tabular-nums text-slate-900">
        {value}
      </dd>
    </div>
  );
}

function RepayDetails({ summary }: { summary: RepaySummary }) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
      <h2 className="text-sm font-semibold text-slate-900">상환 상세</h2>
      <dl className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <CompactStat
          label="상환 횟수"
          value={`${summary.months.toLocaleString("ko-KR")}회`}
        />
        <CompactStat
          label="첫 해 납입액"
          value={formatWon(summary.firstYearPaymentWon)}
        />
      </dl>
      <p className="mt-3 text-[11px] leading-4 text-slate-400">
        금액은 원 단위 반올림입니다. 원리금균등 마지막 달은 잔액 정산이 반영됩니다.
      </p>
    </section>
  );
}

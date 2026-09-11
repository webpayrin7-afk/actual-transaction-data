"use client";

import { useMemo, useState } from "react";
import {
  LIMIT_CONSTRAINT_LABEL,
  calculateLoanLimit,
  formatEokFromMan,
  formatMan,
  type HomeCount,
  type LimitConstraintKey,
  type LoanCalcInput,
  type MetroType,
  type RegType,
} from "@/lib/loan/calc";
import { formatManHuman } from "@/lib/loan/repay";
import { ChoiceChip, Field, Segmented, inputClass } from "@/components/loan/loan-ui";
import { LabCard } from "@/components/ui/lab";

const YEARS = [10, 15, 20, 25, 30, 35, 40] as const;

const REGULATED_REGIONS = {
  투기과열지구: [
    "서울 전 자치구",
    "과천·광명·구리·성남(분당·수정·중원)·수원(영통·장안·팔달)",
    "안양 동안·용인(기흥·수지)·의왕·하남·화성 동탄1·2",
  ],
  조정대상지역: [
    "투기과열지구와 동일 권역(금융위 고시 기준, DB 갱신 참고일 2026-07-01)",
  ],
};

function parseMan(raw: string): number {
  const n = Number(String(raw).replaceAll(",", "").trim());
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function LoanLimitCalculator({
  years,
  onYearsChange,
  rate,
  onRateChange,
  onGoToRepayment,
}: {
  years: number;
  onYearsChange: (years: number) => void;
  rate: string;
  onRateChange: (rate: string) => void;
  onGoToRepayment: (payload: {
    principalMan: number;
    years: number;
    rate: string;
  }) => void;
}) {
  const [metro, setMetro] = useState<MetroType>("capital");
  const [regulated, setRegulated] = useState<RegType>("regulated");
  const [homes, setHomes] = useState<HomeCount>("0");
  const [firstHome, setFirstHome] = useState(true);
  const [disposeCondition, setDisposeCondition] = useState(false);
  const [collateral, setCollateral] = useState("100000");
  const [income, setIncome] = useState("8000");
  const [existingMonthly, setExistingMonthly] = useState("0");
  const [otherInterest, setOtherInterest] = useState("0");
  const [showRegions, setShowRegions] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const input: LoanCalcInput = useMemo(
    () => ({
      metro,
      regulated,
      homes,
      firstHome: homes === "0" ? firstHome : false,
      disposeCondition: homes === "1" ? disposeCondition : false,
      collateralMan: parseMan(collateral),
      annualIncomeMan: parseMan(income),
      existingMonthlyMan: parseMan(existingMonthly),
      otherAnnualInterestMan: parseMan(otherInterest),
      years,
      baseRatePct: Number(rate) || 0,
    }),
    [
      metro,
      regulated,
      homes,
      firstHome,
      disposeCondition,
      collateral,
      income,
      existingMonthly,
      otherInterest,
      years,
      rate,
    ],
  );

  const result = useMemo(() => calculateLoanLimit(input), [input]);
  const limiterLabel = result.limitingConstraints
    .map((key) => LIMIT_CONSTRAINT_LABEL[key])
    .join(" · ");

  function goToRepayment() {
    if (result.blocked || result.finalLimitMan <= 0) return;
    onGoToRepayment({
      principalMan: result.finalLimitMan,
      years: result.effectiveYears,
      rate: Number.isFinite(input.baseRatePct)
        ? String(Number(input.baseRatePct.toFixed(2)))
        : rate,
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <LabCard className="p-4 sm:p-5">
        <h2 className="text-sm font-semibold text-[color:var(--lab-navy-950)]">대출 조건</h2>
        <div className="mt-4 flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <p id="limit-metro-label" className="text-xs font-medium text-[color:var(--lab-muted)]">
              지역 구분
            </p>
            <Segmented
              labelledBy="limit-metro-label"
              value={metro}
              onChange={setMetro}
              options={[
                { value: "capital", label: "수도권" },
                { value: "local", label: "지방" },
              ]}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <p id="limit-reg-label" className="text-xs font-medium text-[color:var(--lab-muted)]">
              규제지역
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Segmented
                labelledBy="limit-reg-label"
                value={regulated}
                onChange={setRegulated}
                options={[
                  { value: "regulated", label: "규제지역" },
                  { value: "unregulated", label: "비규제" },
                ]}
              />
              <button
                type="button"
                onClick={() => setShowRegions((v) => !v)}
                className="text-xs font-medium text-teal-700 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/40"
              >
                지역확인
              </button>
            </div>
          </div>

          {showRegions ? (
            <div className="rounded-[var(--lab-radius-md)] border border-[color:var(--lab-border)] bg-slate-50 px-3 py-3 text-xs leading-5 text-slate-600">
              <p className="font-semibold text-slate-800">투기과열지구</p>
              <p className="mt-1">{REGULATED_REGIONS.투기과열지구.join(" · ")}</p>
              <p className="mt-3 font-semibold text-slate-800">조정대상지역</p>
              <p className="mt-1">{REGULATED_REGIONS.조정대상지역.join(" · ")}</p>
              <p className="mt-2 text-[11px] text-slate-400">
                금융위원회 고시 기준 참고 · 실제 지정 현황은 최신 공고를 확인하세요.
              </p>
            </div>
          ) : null}

          <div className="flex flex-col gap-1.5">
            <p id="limit-homes-label" className="text-xs font-medium text-[color:var(--lab-muted)]">
              보유 주택 수
            </p>
            <Segmented
              labelledBy="limit-homes-label"
              value={homes}
              onChange={setHomes}
              options={[
                { value: "0", label: "0채 (무주택)" },
                { value: "1", label: "1채" },
                { value: "2plus", label: "2채 이상" },
              ]}
            />
          </div>

          {homes === "0" ? (
            <div className="flex flex-col gap-1.5">
              <p id="limit-first-label" className="text-xs font-medium text-[color:var(--lab-muted)]">
                생애최초 여부
              </p>
              <Segmented
                labelledBy="limit-first-label"
                value={firstHome ? "yes" : "no"}
                onChange={(v) => setFirstHome(v === "yes")}
                options={[
                  { value: "yes", label: "예" },
                  { value: "no", label: "아니오" },
                ]}
              />
            </div>
          ) : null}

          {homes === "1" ? (
            <div className="flex flex-col gap-1.5">
              <p id="limit-dispose-label" className="text-xs font-medium text-[color:var(--lab-muted)]">
                처분조건부 여부
              </p>
              <Segmented
                labelledBy="limit-dispose-label"
                value={disposeCondition ? "yes" : "no"}
                onChange={(v) => setDisposeCondition(v === "yes")}
                options={[
                  { value: "yes", label: "예" },
                  { value: "no", label: "아니오" },
                ]}
              />
            </div>
          ) : null}
        </div>
      </LabCard>

      <LabCard className="p-4 sm:p-5">
        <h2 className="text-sm font-semibold text-[color:var(--lab-navy-950)]">담보 및 소득</h2>
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            id="limit-collateral"
            label="담보 가액 (만원)"
            hint="KB·부동산원 시세"
          >
            <input
              id="limit-collateral"
              className={inputClass}
              inputMode="numeric"
              value={collateral}
              onChange={(e) => setCollateral(e.target.value)}
              placeholder="예: 100000"
            />
          </Field>
          <Field id="limit-income" label="연 소득 (만원)" hint="부부합산 · 세전">
            <input
              id="limit-income"
              className={inputClass}
              inputMode="numeric"
              value={income}
              onChange={(e) => setIncome(e.target.value)}
              placeholder="예: 8000"
            />
          </Field>
          <Field
            id="limit-existing"
            label="기존대출 월상환액 (만원)"
            hint="주담대 외 월 원리금"
          >
            <input
              id="limit-existing"
              className={inputClass}
              inputMode="numeric"
              value={existingMonthly}
              onChange={(e) => setExistingMonthly(e.target.value)}
            />
          </Field>
          <Field
            id="limit-other"
            label="기타대출 연이자 (만원)"
            hint="DTI용 · 주담대 외 연이자"
          >
            <input
              id="limit-other"
              className={inputClass}
              inputMode="numeric"
              value={otherInterest}
              onChange={(e) => setOtherInterest(e.target.value)}
            />
          </Field>
        </div>
      </LabCard>

      <LabCard className="p-4 sm:p-5">
        <h2 className="text-sm font-semibold text-[color:var(--lab-navy-950)]">만기 · 금리</h2>
        <div className="mt-4 flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <p id="limit-years-label" className="text-xs font-medium text-[color:var(--lab-muted)]">
              희망 만기
            </p>
            <div
              role="radiogroup"
              aria-labelledby="limit-years-label"
              className="flex flex-wrap gap-2"
            >
              {YEARS.map((y) => (
                <ChoiceChip
                  key={y}
                  selected={years === y}
                  onClick={() => onYearsChange(y)}
                >
                  {y}년
                </ChoiceChip>
              ))}
            </div>
          </div>
          <Field
            id="limit-rate"
            label="계산용 금리 (%)"
            hint="DSR은 스트레스 가산금리를 더합니다."
          >
            <input
              id="limit-rate"
              className={inputClass}
              inputMode="decimal"
              value={rate}
              onChange={(e) => onRateChange(e.target.value)}
            />
          </Field>
        </div>

        <button
          type="button"
          onClick={() => setSubmitted(true)}
          className="lab-button lab-button-primary mt-5 w-full sm:w-auto"
        >
          대출 한도 계산
        </button>
      </LabCard>

      <LabCard className="p-5">
        <p className="text-xs font-medium text-[color:var(--lab-muted)]">한도 계산 결과</p>
        <p className="mt-3 text-sm text-slate-600">예상 대출 가능 한도</p>
        <p className="mt-1 lab-kpi-value break-words text-3xl font-semibold tracking-tight text-[color:var(--lab-navy-950)]">
          {submitted
            ? result.blocked
              ? "대출 불가"
              : result.finalLimitMan > 0
              ? `${formatManHuman(result.finalLimitMan)}원`
              : "0원"
            : "—"}
        </p>
        {submitted && !result.blocked ? (
          <>
            {limiterLabel ? (
              <p className="mt-2 text-sm text-slate-700">
                한도를 결정한 기준{" "}
                <span className="font-semibold">{limiterLabel}</span>
              </p>
            ) : null}
            <p className="mt-2 text-sm text-slate-600">
              {formatMan(result.finalLimitMan)} · 월 상환 약{" "}
              {result.monthlyPaymentMan.toLocaleString("ko-KR")}만
              <span className="text-slate-400">
                {" "}
                (만기 {result.effectiveYears}년 · 금리 {input.baseRatePct}% ·
                원리금균등)
              </span>
            </p>
          </>
        ) : null}
        {submitted && result.blocked ? (
          <p className="mt-3 text-sm leading-6 text-amber-800">
            {result.blockedReason}
          </p>
        ) : null}
        {submitted && !result.blocked && result.finalLimitMan > 0 ? (
          <button
            type="button"
            onClick={goToRepayment}
            className="lab-button lab-button-primary mt-4 w-full sm:w-auto"
          >
            이 한도로 이자 계산
          </button>
        ) : null}
      </LabCard>

      <LabCard className="p-4 sm:p-5">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <ResultRow
            label="LTV 한도"
            value={
              submitted
                ? `${formatEokFromMan(result.ltvLimitMan)} (${Math.round(result.ltvRate * 100)}%)`
                : "—"
            }
            hint="담보가액 × LTV율"
            emphasized={submitted && result.limitingConstraints.includes("ltv")}
            constraintKey="ltv"
          />
          <ResultRow
            label="DSR 한도"
            value={submitted ? formatEokFromMan(result.dsrLimitMan) : "—"}
            hint={`스트레스 ${result.stressRatePct.toFixed(2)}% 기준 · 은행 40%`}
            emphasized={submitted && result.limitingConstraints.includes("dsr")}
            constraintKey="dsr"
          />
          <ResultRow
            label="DTI 한도"
            value={
              submitted
                ? result.dtiApplied
                  ? formatEokFromMan(result.dtiLimitMan)
                  : "미적용"
                : "—"
            }
            hint="주담대 원리금 + 기타대출 이자"
            emphasized={submitted && result.limitingConstraints.includes("dti")}
            constraintKey="dti"
          />
          {result.absoluteCapMan != null ? (
            <ResultRow
              label="시가 절대한도"
              value={submitted ? formatEokFromMan(result.absoluteCapMan) : "—"}
              hint="규제지역 15억↓6억 · 15~25억 4억 · 25억↑2억"
              emphasized={
                submitted && result.limitingConstraints.includes("absolute_cap")
              }
              constraintKey="absolute_cap"
            />
          ) : null}
        </div>

        {submitted && result.notes.length > 0 ? (
          <details className="mt-4 border-t border-slate-100 pt-4">
            <summary className="cursor-pointer text-sm font-medium text-slate-700">
              계산 기준 보기
            </summary>
            <ul className="mt-3 space-y-1.5 text-xs leading-5 text-slate-500">
              {result.notes.map((note) => (
                <li key={note}>· {note}</li>
              ))}
            </ul>
          </details>
        ) : null}
      </LabCard>

      <p className="text-xs leading-5 text-slate-500">
        계산 결과는 입력값을 기준으로 한 참고용이며, 실제 대출 가능 금액과 조건은
        금융기관 심사에 따라 달라질 수 있습니다.
      </p>
    </div>
  );
}

function ResultRow({
  label,
  value,
  hint,
  emphasized,
}: {
  label: string;
  value: string;
  hint: string;
  emphasized?: boolean;
  constraintKey: LimitConstraintKey;
}) {
  return (
    <div
      className={`min-w-0 rounded-[var(--lab-radius-md)] px-3 py-3 ${
        emphasized
          ? "border border-[color:var(--lab-teal-600)]/35 bg-[color:var(--lab-teal-50)]"
          : "border border-[color:var(--lab-border)] bg-slate-50/80"
      }`}
    >
      <p className="flex flex-wrap items-center gap-2 text-xs font-medium text-[color:var(--lab-muted)]">
        <span>{label}</span>
        {emphasized ? (
          <span className="lab-badge">한도 결정</span>
        ) : null}
      </p>
      <p className="mt-1 break-words text-base font-semibold text-[color:var(--lab-navy-950)]">
        {value}
      </p>
      <p className="mt-1 text-[11px] leading-4 text-slate-400">{hint}</p>
    </div>
  );
}

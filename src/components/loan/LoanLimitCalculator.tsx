"use client";

import { useMemo, useState } from "react";
import {
  calculateLoanLimit,
  formatEokFromMan,
  formatMan,
  type HomeCount,
  type LoanCalcInput,
  type MetroType,
  type RegType,
} from "@/lib/loan/calc";
import { Field, Segmented, inputClass } from "@/components/loan/loan-ui";

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
  defaultRate,
  onApplyLimitMan,
}: {
  defaultRate: string;
  onApplyLimitMan?: (man: number) => void;
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
  const [years, setYears] = useState(30);
  const [rate, setRate] = useState(defaultRate);
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

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm leading-6 text-slate-600">
        LTV·DSR·DTI 규제를 반영한 예상 한도입니다. 상환액·금리 비교와는 별도
        참고 기능이며, 실제 한도는 금융기관 심사에 따라 달라집니다.
      </p>

      <section className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
        <h3 className="text-sm font-semibold text-slate-900">한도 계산 조건</h3>
        <div className="mt-4 flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <p id="limit-metro-label" className="text-xs font-medium text-slate-500">
              지역 구분
            </p>
            <p className="text-[11px] leading-4 text-slate-400">
              서울·인천·경기는 수도권, 그 외는 지방입니다.
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
            <p id="limit-reg-label" className="text-xs font-medium text-slate-500">
              규제지역
            </p>
            <p className="text-[11px] leading-4 text-slate-400">
              규제지역은 LTV·DTI가 강화되고 시가 절대한도가 적용됩니다.
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
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-xs leading-5 text-slate-600">
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
            <p id="limit-homes-label" className="text-xs font-medium text-slate-500">
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
              <p id="limit-first-label" className="text-xs font-medium text-slate-500">
                생애최초 여부
              </p>
              <p className="text-[11px] leading-4 text-slate-400">
                본인·배우자 모두 주택 구입 이력이 없으면 규제지역에서도 LTV 70%.
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
              <p id="limit-dispose-label" className="text-xs font-medium text-slate-500">
                처분조건부 여부
              </p>
              <p className="text-[11px] leading-4 text-slate-400">
                기존 주택을 6개월 내 처분 조건으로 구입하는 1주택자.
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
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
        <h3 className="text-sm font-semibold text-slate-900">한도용 담보 및 소득</h3>
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            id="limit-collateral"
            label="담보 가액 (만원)"
            hint="KB·부동산원 시세(일반가) 기준 권장"
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
          <Field id="limit-income" label="연 소득 (만원)" hint="부부합산 가능 · 세전">
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
            hint="신용·자동차·전세대출 이자 등 월 원리금 합계"
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
            hint="DTI 계산용 · 주담대 외 연간 이자"
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
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
        <h3 className="text-sm font-semibold text-slate-900">한도용 만기·금리</h3>
        <div className="mt-4 flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <p id="limit-years-label" className="text-xs font-medium text-slate-500">
              희망 만기
            </p>
            <p className="text-[11px] leading-4 text-slate-400">
              수도권 규제지역은 최대 30년으로 자동 조정됩니다.
            </p>
            <div
              role="radiogroup"
              aria-labelledby="limit-years-label"
              className="flex flex-wrap gap-2"
            >
              {YEARS.map((y) => (
                <button
                  key={y}
                  type="button"
                  role="radio"
                  aria-checked={years === y}
                  onClick={() => setYears(y)}
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
          </div>
          <Field
            id="limit-rate"
            label="한도 계산용 금리 (%)"
            hint="DSR은 스트레스 가산금리를 더해 보수적으로 계산합니다."
          >
            <input
              id="limit-rate"
              className={inputClass}
              inputMode="decimal"
              value={rate}
              onChange={(e) => setRate(e.target.value)}
            />
          </Field>
        </div>

        <button
          type="button"
          onClick={() => setSubmitted(true)}
          className="mt-5 inline-flex w-full items-center justify-center rounded-lg bg-teal-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-teal-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/40 sm:w-auto"
        >
          대출 한도 계산
        </button>
      </section>

      <section className="rounded-2xl border border-teal-900/10 bg-gradient-to-br from-slate-900 via-teal-900 to-slate-800 p-5 text-white shadow-sm">
        <p className="text-xs font-medium text-teal-100/90">한도 계산 결과</p>
        <p className="mt-3 text-sm text-teal-100/80">최종 대출 가능 한도</p>
        <p className="mt-1 break-words text-3xl font-semibold tracking-tight">
          {submitted
            ? result.blocked
              ? "대출 불가"
              : formatEokFromMan(result.finalLimitMan)
            : "—"}
        </p>
        {submitted && !result.blocked ? (
          <p className="mt-2 text-sm text-teal-100/80">
            {formatMan(result.finalLimitMan)} · 월 상환 약{" "}
            {result.monthlyPaymentMan.toLocaleString("ko-KR")}만
            <span className="text-teal-100/60">
              {" "}
              (만기 {result.effectiveYears}년 · 금리 {input.baseRatePct}% ·
              원리금균등)
            </span>
          </p>
        ) : null}
        {submitted && result.blocked ? (
          <p className="mt-3 text-sm leading-6 text-amber-100">
            {result.blockedReason}
          </p>
        ) : null}
        {submitted && !result.blocked && result.finalLimitMan > 0 && onApplyLimitMan ? (
          <button
            type="button"
            onClick={() => onApplyLimitMan(result.finalLimitMan)}
            className="mt-4 inline-flex w-full items-center justify-center rounded-lg bg-white/15 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-white/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50 sm:w-auto"
          >
            이 한도를 대출금액에 넣기
          </button>
        ) : null}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <ResultRow
            label="LTV 한도"
            value={
              submitted
                ? `${formatEokFromMan(result.ltvLimitMan)} (${Math.round(result.ltvRate * 100)}%)`
                : "—"
            }
            hint="담보가액 × LTV율"
          />
          <ResultRow
            label="DSR 한도"
            value={submitted ? formatEokFromMan(result.dsrLimitMan) : "—"}
            hint={`스트레스 ${result.stressRatePct.toFixed(2)}% 기준 · 은행 40%`}
          />
          <ResultRow
            label="DTI 한도"
            value={submitted ? formatEokFromMan(result.dtiLimitMan) : "—"}
            hint="주담대 원리금 + 기타대출 이자"
          />
          {result.absoluteCapMan != null ? (
            <ResultRow
              label="시가 절대한도"
              value={submitted ? formatEokFromMan(result.absoluteCapMan) : "—"}
              hint="규제지역 15억↓6억 · 15~25억 4억 · 25억↑2억"
            />
          ) : null}
        </div>

        {submitted && result.notes.length > 0 ? (
          <ul className="mt-4 space-y-1.5 border-t border-slate-100 pt-4 text-xs leading-5 text-slate-500">
            {result.notes.map((note) => (
              <li key={note}>· {note}</li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}

function ResultRow({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="min-w-0 rounded-xl bg-slate-50 px-3 py-3">
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p className="mt-1 break-words text-base font-semibold text-slate-900">
        {value}
      </p>
      <p className="mt-1 text-[11px] leading-4 text-slate-400">{hint}</p>
    </div>
  );
}

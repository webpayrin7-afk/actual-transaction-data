"use client";

import { useMemo, useState } from "react";
import {
  SAMPLE_PRODUCTS,
  calculateLoanLimit,
  formatEokFromMan,
  formatMan,
  monthlyPaymentWon,
  type HomeCount,
  type LoanCalcInput,
  type MetroType,
  type RegType,
} from "@/lib/loan/calc";

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

function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
      {options.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={`rounded-lg px-3 py-2 text-sm font-medium transition ${
              active
                ? "bg-teal-700 text-white"
                : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-slate-500">{label}</span>
      {hint ? <span className="text-[11px] leading-4 text-slate-400">{hint}</span> : null}
      {children}
    </label>
  );
}

const inputClass =
  "w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20";

function parseMan(raw: string): number {
  const n = Number(String(raw).replaceAll(",", "").trim());
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function LoanCalculator() {
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
  const [rate, setRate] = useState("3.9");
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

  function onCalculate() {
    setSubmitted(true);
  }

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
      <div className="max-w-3xl">
        <p className="text-xs font-medium tracking-wide text-teal-700">도구</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">
          주택담보대출 한도 계산기
        </h1>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          LTV·DSR·DTI 규제를 반영해 예상 대출 가능 금액을 계산합니다. 실제 한도는
          금융기관 심사 기준에 따라 달라질 수 있습니다.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.9fr)]">
        <div className="flex flex-col gap-5">
          <section className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
            <h2 className="text-sm font-semibold text-slate-900">대출 조건</h2>
            <div className="mt-4 flex flex-col gap-4">
              <Field
                label="지역 구분"
                hint="서울·인천·경기는 수도권, 그 외는 지방입니다."
              >
                <Segmented
                  value={metro}
                  onChange={setMetro}
                  options={[
                    { value: "capital", label: "수도권" },
                    { value: "local", label: "지방" },
                  ]}
                />
              </Field>

              <Field
                label="규제지역"
                hint="규제지역은 LTV·DTI가 강화되고 시가 절대한도가 적용됩니다."
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Segmented
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
                    className="text-xs font-medium text-teal-700 underline-offset-2 hover:underline"
                  >
                    지역확인
                  </button>
                </div>
              </Field>

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

              <Field label="보유 주택 수">
                <Segmented
                  value={homes}
                  onChange={setHomes}
                  options={[
                    { value: "0", label: "0채 (무주택)" },
                    { value: "1", label: "1채" },
                    { value: "2plus", label: "2채 이상" },
                  ]}
                />
              </Field>

              {homes === "0" ? (
                <Field
                  label="생애최초 여부"
                  hint="본인·배우자 모두 주택 구입 이력이 없으면 규제지역에서도 LTV 70%."
                >
                  <Segmented
                    value={firstHome ? "yes" : "no"}
                    onChange={(v) => setFirstHome(v === "yes")}
                    options={[
                      { value: "yes", label: "예" },
                      { value: "no", label: "아니오" },
                    ]}
                  />
                </Field>
              ) : null}

              {homes === "1" ? (
                <Field
                  label="처분조건부 여부"
                  hint="기존 주택을 6개월 내 처분 조건으로 구입하는 1주택자."
                >
                  <Segmented
                    value={disposeCondition ? "yes" : "no"}
                    onChange={(v) => setDisposeCondition(v === "yes")}
                    options={[
                      { value: "yes", label: "예" },
                      { value: "no", label: "아니오" },
                    ]}
                  />
                </Field>
              ) : null}
            </div>
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
            <h2 className="text-sm font-semibold text-slate-900">담보 및 소득</h2>
            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="담보 가액 (만원)" hint="KB·부동산원 시세(일반가) 기준 권장">
                <input
                  className={inputClass}
                  inputMode="numeric"
                  value={collateral}
                  onChange={(e) => setCollateral(e.target.value)}
                  placeholder="예: 100000"
                />
              </Field>
              <Field label="연 소득 (만원)" hint="부부합산 가능 · 세전">
                <input
                  className={inputClass}
                  inputMode="numeric"
                  value={income}
                  onChange={(e) => setIncome(e.target.value)}
                  placeholder="예: 8000"
                />
              </Field>
              <Field
                label="기존대출 월상환액 (만원)"
                hint="신용·자동차·전세대출 이자 등 월 원리금 합계"
              >
                <input
                  className={inputClass}
                  inputMode="numeric"
                  value={existingMonthly}
                  onChange={(e) => setExistingMonthly(e.target.value)}
                />
              </Field>
              <Field
                label="기타대출 연이자 (만원)"
                hint="DTI 계산용 · 주담대 외 연간 이자"
              >
                <input
                  className={inputClass}
                  inputMode="numeric"
                  value={otherInterest}
                  onChange={(e) => setOtherInterest(e.target.value)}
                />
              </Field>
            </div>
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
            <h2 className="text-sm font-semibold text-slate-900">대출 상환 조건</h2>
            <div className="mt-4 flex flex-col gap-4">
              <Field
                label="희망 만기"
                hint="수도권 규제지역은 최대 30년으로 자동 조정됩니다."
              >
                <div className="flex flex-wrap gap-2">
                  {YEARS.map((y) => (
                    <button
                      key={y}
                      type="button"
                      onClick={() => setYears(y)}
                      className={`rounded-lg px-3 py-2 text-sm font-medium transition ${
                        years === y
                          ? "bg-teal-700 text-white"
                          : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                      }`}
                    >
                      {y}년
                    </button>
                  ))}
                </div>
              </Field>
              <Field
                label="기준 금리 (%)"
                hint="DSR은 스트레스 가산금리를 더해 보수적으로 계산합니다."
              >
                <input
                  className={inputClass}
                  inputMode="decimal"
                  value={rate}
                  onChange={(e) => setRate(e.target.value)}
                />
              </Field>
            </div>

            <button
              type="button"
              onClick={onCalculate}
              className="mt-5 inline-flex w-full items-center justify-center rounded-lg bg-teal-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-teal-700 sm:w-auto"
            >
              대출 한도 계산
            </button>
          </section>
        </div>

        <div className="flex flex-col gap-5 lg:sticky lg:top-28 lg:self-start">
          <section className="rounded-2xl border border-teal-900/10 bg-gradient-to-br from-slate-900 via-teal-900 to-slate-800 p-5 text-white shadow-sm">
            <p className="text-xs font-medium text-teal-100/90">계산 결과</p>
            <p className="mt-3 text-sm text-teal-100/80">최종 대출 가능 한도</p>
            <p className="mt-1 text-3xl font-semibold tracking-tight">
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
                  (만기 {result.effectiveYears}년 · 금리 {input.baseRatePct}%)
                </span>
              </p>
            ) : null}
            {submitted && result.blocked ? (
              <p className="mt-3 text-sm leading-6 text-amber-100">
                {result.blockedReason}
              </p>
            ) : null}
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 lg:grid-cols-1">
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

          <section className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
            <h2 className="text-sm font-semibold text-slate-900">
              금융기관별 상품 한도 (예시)
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              참고용 샘플 금리입니다. 실제 상품·우대금리와 다를 수 있습니다.
            </p>
            <div className="mt-3 overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="text-xs text-slate-500">
                  <tr className="border-b border-slate-100">
                    <th className="py-2 pr-3 font-medium">기관</th>
                    <th className="py-2 pr-3 font-medium">상품</th>
                    <th className="py-2 pr-3 font-medium">금리</th>
                    <th className="py-2 pr-3 font-medium">한도</th>
                    <th className="py-2 font-medium">월상환</th>
                  </tr>
                </thead>
                <tbody>
                  {SAMPLE_PRODUCTS.map((p) => {
                    const limit = submitted ? result.finalLimitMan : 0;
                    const monthly =
                      submitted && limit > 0
                        ? Math.round(
                            (monthlyPaymentWon(
                              limit * 10_000,
                              p.rate,
                              result.effectiveYears,
                            ) /
                              10_000) *
                              10,
                          ) / 10
                        : 0;
                    return (
                      <tr key={p.org + p.name} className="border-b border-slate-50">
                        <td className="py-2.5 pr-3 text-slate-800">{p.org}</td>
                        <td className="py-2.5 pr-3 text-slate-600">{p.name}</td>
                        <td className="py-2.5 pr-3 text-slate-600">
                          {p.rate.toFixed(2)}%
                        </td>
                        <td className="py-2.5 pr-3 font-medium text-slate-900">
                          {submitted
                            ? result.blocked
                              ? "—"
                              : formatEokFromMan(limit)
                            : "—"}
                        </td>
                        <td className="py-2.5 text-slate-700">
                          {submitted && !result.blocked && limit > 0
                            ? `${monthly.toLocaleString("ko-KR")}만`
                            : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </div>
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
    <div className="rounded-xl bg-slate-50 px-3 py-3">
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p className="mt-1 text-base font-semibold text-slate-900">{value}</p>
      <p className="mt-1 text-[11px] leading-4 text-slate-400">{hint}</p>
    </div>
  );
}

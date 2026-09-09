/** 주택담보대출 한도 계산 (LTV·DSR·DTI) — apt2.me 안내 기준 참고 */

export type MetroType = "capital" | "local";
export type RegType = "regulated" | "unregulated";
export type HomeCount = "0" | "1" | "2plus";

export interface LoanCalcInput {
  metro: MetroType;
  regulated: RegType;
  homes: HomeCount;
  firstHome: boolean;
  disposeCondition: boolean;
  /** 담보가액 (만원) */
  collateralMan: number;
  /** 연소득 (만원) */
  annualIncomeMan: number;
  /** 기존대출 월상환액 (만원) */
  existingMonthlyMan: number;
  /** 기타대출 연이자 DTI용 (만원) */
  otherAnnualInterestMan: number;
  /** 희망 만기 (년) */
  years: number;
  /** 기준 금리 (%) */
  baseRatePct: number;
}

export type LimitConstraintKey = "ltv" | "dsr" | "dti" | "absolute_cap";

export const LIMIT_CONSTRAINT_LABEL: Record<LimitConstraintKey, string> = {
  ltv: "LTV",
  dsr: "DSR",
  dti: "DTI",
  absolute_cap: "시가 절대한도",
};

export interface LoanCalcBreakdown {
  ltvRate: number;
  ltvLimitMan: number;
  dsrLimitMan: number;
  dtiLimitMan: number;
  dtiApplied: boolean;
  absoluteCapMan: number | null;
  finalLimitMan: number;
  limitingConstraints: LimitConstraintKey[];
  stressAddPct: number;
  stressRatePct: number;
  effectiveYears: number;
  monthlyPaymentMan: number;
  blocked: boolean;
  blockedReason?: string;
  notes: string[];
}

const MAN_TO_WON = 10_000;

/** 원리금균등 월상환액 (원) */
export function monthlyPaymentWon(
  principalWon: number,
  annualRatePct: number,
  years: number,
): number {
  if (principalWon <= 0 || years <= 0) return 0;
  const n = years * 12;
  const r = annualRatePct / 100 / 12;
  if (r === 0) return principalWon / n;
  const factor = Math.pow(1 + r, n);
  return (principalWon * r * factor) / (factor - 1);
}

/** 월상환액으로 가능한 원금 (원) */
export function principalFromMonthlyWon(
  monthlyWon: number,
  annualRatePct: number,
  years: number,
): number {
  if (monthlyWon <= 0 || years <= 0) return 0;
  const n = years * 12;
  const r = annualRatePct / 100 / 12;
  if (r === 0) return monthlyWon * n;
  const factor = Math.pow(1 + r, n);
  return (monthlyWon * (factor - 1)) / (r * factor);
}

function stressAdd(metro: MetroType): number {
  // apt2.me: 수도권 +3.0%, 지방 +1.5% (2026-12-31까지 유예 안내)
  return metro === "capital" ? 3.0 : 1.5;
}

function resolveLtv(input: LoanCalcInput): {
  rate: number;
  blocked: boolean;
  reason?: string;
  notes: string[];
} {
  const notes: string[] = [];
  const isReg = input.regulated === "regulated";
  const isCapital = input.metro === "capital";

  if (input.homes === "2plus" && isCapital && isReg) {
    return {
      rate: 0,
      blocked: true,
      reason: "수도권 규제지역에서 2주택 이상 추가 구입은 대출이 불가합니다 (LTV 0%).",
      notes: ["다주택 + 수도권 규제지역 → LTV 0%"],
    };
  }

  if (input.homes === "2plus") {
    notes.push("다주택자는 지역·금융사에 따라 제한될 수 있습니다.");
    if (isReg) {
      return {
        rate: 0,
        blocked: true,
        reason: "규제지역 다주택자 추가 구입 목적 주담대는 사실상 불가합니다.",
        notes,
      };
    }
    return { rate: 0.7, blocked: false, notes };
  }

  if (input.homes === "1") {
    if (!input.disposeCondition) {
      if (isReg) {
        return {
          rate: 0,
          blocked: true,
          reason:
            "규제지역 1주택자는 기존 주택 처분조건부(6개월 내)가 있어야 대출이 가능합니다.",
          notes: ["1주택 · 처분조건부 아님 → 규제지역 대출 불가"],
        };
      }
      notes.push("비규제 1주택은 통상 처분조건(2년 내)이 필요할 수 있습니다.");
      return { rate: 0.7, blocked: false, notes };
    }
    // 처분조건부
    if (isReg) {
      notes.push("규제지역 처분조건부 1주택 → LTV 50%");
      return { rate: 0.5, blocked: false, notes };
    }
    notes.push("비규제 처분조건부 1주택 → LTV 70%");
    return { rate: 0.7, blocked: false, notes };
  }

  // 무주택
  if (input.firstHome) {
    if (isReg || isCapital) {
      notes.push("생애최초 · 수도권/규제 → LTV 70%");
      return { rate: 0.7, blocked: false, notes };
    }
    notes.push("생애최초 · 지방 비규제 → LTV 80%");
    return { rate: 0.8, blocked: false, notes };
  }

  if (isReg) {
    notes.push("무주택 일반 · 규제지역 → LTV 40%");
    return { rate: 0.4, blocked: false, notes };
  }
  notes.push("무주택 일반 · 비규제 → LTV 70%");
  return { rate: 0.7, blocked: false, notes };
}

/** 규제지역 시가 절대 한도 (만원). 비규제는 null */
function absoluteCapMan(
  collateralMan: number,
  regulated: RegType,
): number | null {
  if (regulated !== "regulated") return null;
  // 15억 이하 6억 / 15~25억 4억 / 25억 초과 2억
  if (collateralMan <= 150_000) return 60_000;
  if (collateralMan <= 250_000) return 40_000;
  return 20_000;
}

function dtiMaxRatio(input: LoanCalcInput): number | null {
  // apt2.me: 서울 50% · 수도권 60%. 규제/수도권에 병행.
  if (input.regulated === "regulated" && input.metro === "capital") {
    // 서울·수도권 규제 — 보수적으로 50% (조정대상은 50%, 투기과열 더 강할 수 있음)
    return 0.5;
  }
  if (input.metro === "capital") return 0.6;
  return null; // 지방은 DTI 미적용(한도 무한에 가깝게)
}

export function calculateLoanLimit(input: LoanCalcInput): LoanCalcBreakdown {
  const notes: string[] = [];
  const stressAddPct = stressAdd(input.metro);
  const stressRatePct = input.baseRatePct + stressAddPct;

  let effectiveYears = input.years;
  if (
    input.metro === "capital" &&
    input.regulated === "regulated" &&
    effectiveYears > 30
  ) {
    effectiveYears = 30;
    notes.push("수도권 규제지역 만기는 최대 30년으로 조정됩니다.");
  }

  const ltv = resolveLtv(input);
  notes.push(...ltv.notes);

  if (ltv.blocked) {
    return {
      ltvRate: 0,
      ltvLimitMan: 0,
      dsrLimitMan: 0,
      dtiLimitMan: 0,
      dtiApplied: false,
      absoluteCapMan: absoluteCapMan(input.collateralMan, input.regulated),
      finalLimitMan: 0,
      limitingConstraints: [],
      stressAddPct,
      stressRatePct,
      effectiveYears,
      monthlyPaymentMan: 0,
      blocked: true,
      blockedReason: ltv.reason,
      notes,
    };
  }

  const ltvLimitMan = Math.floor(input.collateralMan * ltv.rate);
  const cap = absoluteCapMan(input.collateralMan, input.regulated);
  if (cap != null) {
    notes.push(
      `규제지역 시가 절대한도 적용: 최대 ${formatEokFromMan(cap)}`,
    );
  }

  // DSR 40% (1금융)
  const annualIncomeWon = input.annualIncomeMan * MAN_TO_WON;
  const maxAnnualDebtWon = annualIncomeWon * 0.4;
  const existingAnnualWon = input.existingMonthlyMan * 12 * MAN_TO_WON;
  const remainAnnualWon = Math.max(0, maxAnnualDebtWon - existingAnnualWon);
  const remainMonthlyWon = remainAnnualWon / 12;
  const dsrPrincipalWon = principalFromMonthlyWon(
    remainMonthlyWon,
    stressRatePct,
    effectiveYears,
  );
  const dsrLimitMan = Math.floor(dsrPrincipalWon / MAN_TO_WON);
  notes.push(
    `DSR 40% · 스트레스금리 ${stressRatePct.toFixed(2)}%(+${stressAddPct.toFixed(1)}%p) 기준`,
  );

  // DTI
  const dtiRatio = dtiMaxRatio(input);
  let dtiLimitMan = Number.POSITIVE_INFINITY;
  if (dtiRatio != null && input.annualIncomeMan > 0) {
    const maxAnnualPiMan =
      input.annualIncomeMan * dtiRatio - input.otherAnnualInterestMan;
    const remainAnnualPiMan = Math.max(0, maxAnnualPiMan);
    const remainMonthlyMan = remainAnnualPiMan / 12;
    const dtiPrincipalWon = principalFromMonthlyWon(
      remainMonthlyMan * MAN_TO_WON,
      input.baseRatePct,
      effectiveYears,
    );
    dtiLimitMan = Math.floor(dtiPrincipalWon / MAN_TO_WON);
    notes.push(`DTI ${(dtiRatio * 100).toFixed(0)}% · 기준금리 적용`);
  } else {
    notes.push("지방·해당 없음: DTI 한도 미적용");
  }

  const dtiApplied = Number.isFinite(dtiLimitMan);
  const candidates = [ltvLimitMan, dsrLimitMan];
  if (dtiApplied) candidates.push(dtiLimitMan);
  if (cap != null) candidates.push(cap);

  const finalLimitMan = Math.max(0, Math.floor(Math.min(...candidates)));
  const monthlyPaymentMan =
    Math.round(
      (monthlyPaymentWon(
        finalLimitMan * MAN_TO_WON,
        input.baseRatePct,
        effectiveYears,
      ) /
        MAN_TO_WON) *
        10,
    ) / 10;

  return {
    ltvRate: ltv.rate,
    ltvLimitMan,
    dsrLimitMan,
    dtiLimitMan: dtiApplied ? dtiLimitMan : finalLimitMan,
    dtiApplied,
    absoluteCapMan: cap,
    finalLimitMan,
    limitingConstraints: pickLimitingConstraints(
      ltvLimitMan,
      dsrLimitMan,
      dtiLimitMan,
      cap,
      dtiApplied,
      finalLimitMan,
    ),
    stressAddPct,
    stressRatePct,
    effectiveYears,
    monthlyPaymentMan,
    blocked: false,
    notes,
  };
}

/** 최종 한도와 같은 값인 제약만 반환. 숫자 계산은 calculateLoanLimit과 동일. */
export function pickLimitingConstraints(
  ltvLimitMan: number,
  dsrLimitMan: number,
  dtiLimitMan: number,
  cap: number | null,
  dtiApplied: boolean,
  finalLimitMan: number,
): LimitConstraintKey[] {
  const items: { key: LimitConstraintKey; value: number }[] = [
    { key: "ltv", value: Math.floor(ltvLimitMan) },
    { key: "dsr", value: Math.floor(dsrLimitMan) },
  ];
  if (dtiApplied) items.push({ key: "dti", value: Math.floor(dtiLimitMan) });
  if (cap != null) items.push({ key: "absolute_cap", value: Math.floor(cap) });
  return items
    .filter((item) => item.value === finalLimitMan)
    .map((item) => item.key);
}

export function formatMan(man: number): string {
  if (!Number.isFinite(man) || man <= 0) return "0만";
  return `${Math.round(man).toLocaleString("ko-KR")}만`;
}

export function formatEokFromMan(man: number): string {
  if (!Number.isFinite(man) || man <= 0) return "—";
  const eok = man / 10_000;
  if (eok >= 1) {
    const rounded = Math.round(eok * 100) / 100;
    return `${rounded}억`;
  }
  return `${Math.round(man).toLocaleString("ko-KR")}만`;
}

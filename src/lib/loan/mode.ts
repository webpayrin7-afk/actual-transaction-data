export type LoanPageMode = "limit" | "repayment" | "rates";

/** /loan 쿼리에서 계산 모드를 결정한다. */
export function loanPageModeFromSearchParams(sp: {
  get(name: string): string | null;
}): LoanPageMode {
  const mode = sp.get("mode");
  if (mode === "repayment") return "repayment";
  if (mode === "rates") return "rates";
  if (mode === "limit") return "limit";
  const rate = sp.get("rate");
  if (rate != null && rate.trim() !== "") return "repayment";
  return "limit";
}

export const LOAN_PAGE_MODES: { id: LoanPageMode; label: string; panelId: string }[] =
  [
    { id: "limit", label: "대출 한도", panelId: "loan-limit-panel" },
    { id: "repayment", label: "이자 계산", panelId: "loan-repay-panel" },
    { id: "rates", label: "금리 정보", panelId: "loan-rates-panel" },
  ];

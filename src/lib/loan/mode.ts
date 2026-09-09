export type LoanPageMode = "limit" | "repayment";

/** /loan 쿼리에서 계산 모드를 결정한다. */
export function loanPageModeFromSearchParams(sp: {
  get(name: string): string | null;
}): LoanPageMode {
  const mode = sp.get("mode");
  if (mode === "repayment") return "repayment";
  if (mode === "limit") return "limit";
  const rate = sp.get("rate");
  if (rate != null && rate.trim() !== "") return "repayment";
  return "limit";
}

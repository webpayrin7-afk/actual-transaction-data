/** 대출 금리 비교 — 서버(API)와 화면이 함께 쓰는 값·이름표. 서버 전용 코드는 fss-finlife.ts */

export const FSS_SOURCE_LABEL = "금융감독원 금융상품통합비교공시";
export const FSS_SOURCE_URL = "https://finlife.fss.or.kr";

/** 순위 목록 상한 (목록 정책: 최대 10개, 5개 먼저 + 더보기) */
export const LOAN_RATE_LIMIT = 10;

export type LoanKind = "mortgage" | "jeonse";
export type Sector = "bank" | "savings";
export type RateType = "fixed" | "variable" | "mixed";
export type RepayType = "installment" | "bullet";
export type Collateral = "apt" | "other";
export type LoanRateSort = "min" | "avg";

export const LOAN_KIND_LABEL: Record<LoanKind, string> = {
  mortgage: "주택담보대출",
  jeonse: "전세자금대출",
};
export const SECTOR_LABEL: Record<Sector, string> = { bank: "은행", savings: "저축은행" };
export const RATE_TYPE_LABEL: Record<RateType, string> = { fixed: "고정", variable: "변동", mixed: "혼합" };
export const REPAY_LABEL: Record<RepayType, string> = { installment: "분할상환", bullet: "만기일시" };
export const COLLATERAL_LABEL: Record<Collateral, string> = { apt: "아파트", other: "아파트 외" };

/** 화면 한 줄 = 상품의 금리 옵션 하나 */
export interface LoanRateOption {
  id: string;
  sector: Sector;
  bank: string;
  product: string;
  rateType: RateType | null;
  repay: RepayType | null;
  /** 주택담보대출만 (전세자금대출은 null) */
  collateral: Collateral | null;
  min: number | null;
  max: number | null;
  avg: number | null;
  /** 공시 월 YYYY-MM */
  dclsMonth: string;
}

export interface LoanRateFilters {
  kind: LoanKind;
  sector: Sector | "all";
  rateType: RateType | "all";
  repay: RepayType | "all";
  collateral: Collateral | "all";
  sort: LoanRateSort;
}

/** /api/loan-rates 응답 — 요청한 조건의 상위 목록만 */
export interface LoanRatesResponse {
  filters: LoanRateFilters;
  items: LoanRateOption[];
  /** 조건에 맞는 전체 옵션 수 (items는 상위 LOAN_RATE_LIMIT개) */
  matched: number;
  /** 가장 최근 공시 월 YYYY-MM */
  dclsMonth: string | null;
  fetchedAt: string;
  source: typeof FSS_SOURCE_LABEL;
}

export const DEFAULT_LOAN_RATE_FILTERS: LoanRateFilters = {
  kind: "mortgage",
  sector: "all",
  rateType: "all",
  repay: "all",
  collateral: "all",
  sort: "min",
};

function pick<T extends string>(v: string | null, allowed: readonly T[], fallback: T): T {
  return v && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

export function parseLoanRateFilters(sp: URLSearchParams): LoanRateFilters {
  const d = DEFAULT_LOAN_RATE_FILTERS;
  const kind = pick(sp.get("kind"), ["mortgage", "jeonse"] as const, d.kind);
  return {
    kind,
    sector: pick(sp.get("sector"), ["all", "bank", "savings"] as const, d.sector),
    rateType: pick(sp.get("rateType"), ["all", "fixed", "variable", "mixed"] as const, d.rateType),
    repay: pick(sp.get("repay"), ["all", "installment", "bullet"] as const, d.repay),
    // 담보유형은 주택담보대출에만 있다
    collateral:
      kind === "mortgage" ? pick(sp.get("collateral"), ["all", "apt", "other"] as const, d.collateral) : "all",
    sort: pick(sp.get("sort"), ["min", "avg"] as const, d.sort),
  };
}

export function loanRateQueryString(f: LoanRateFilters): string {
  const sp = new URLSearchParams({
    kind: f.kind,
    sector: f.sector,
    rateType: f.rateType,
    repay: f.repay,
    sort: f.sort,
  });
  if (f.kind === "mortgage") sp.set("collateral", f.collateral);
  return sp.toString();
}

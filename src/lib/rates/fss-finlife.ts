import "server-only";
import { unstable_cache } from "next/cache";
import {
  LOAN_RATE_LIMIT,
  FSS_SOURCE_LABEL,
  type Collateral,
  type LoanKind,
  type LoanRateFilters,
  type LoanRateOption,
  type LoanRatesResponse,
  type RateType,
  type RepayType,
  type Sector,
} from "@/lib/rates/loan-rate-model";

/**
 * 금융감독원 금융상품통합비교공시(finlife.fss.or.kr) Open API — 주택담보대출·전세자금대출.
 * baseList(상품) ↔ optionList(금리 옵션)를 fin_co_no + fin_prdt_cd 로 묶어 화면에 필요한 값만 남긴다.
 * 공시는 월 단위로 바뀌므로 서버에서 하루 동안 캐시한다.
 */

const FINLIFE_BASE =
  // 개발 점검용 대체 주소 (실서비스에서는 무시)
  (process.env.NODE_ENV !== "production" && process.env.FSS_FINLIFE_BASE_URL?.trim()) ||
  "https://finlife.fss.or.kr/finlifeapi";
const REVALIDATE_SECONDS = 60 * 60 * 24;
const MAX_PAGES = 30;
const FETCH_TIMEOUT_MS = 12_000;

const SERVICE: Record<LoanKind, string> = {
  mortgage: "mortgageLoanProductsSearch",
  jeonse: "rentHouseLoanProductsSearch",
};
const SECTOR_GROUP: Record<Sector, string> = { bank: "020000", savings: "030300" };

export interface LoanRateDataset {
  kind: LoanKind;
  options: LoanRateOption[];
  dclsMonth: string | null;
  fetchedAt: string;
}

export class FssFinlifeError extends Error {
  constructor(
    message: string,
    readonly code: "no-key" | "auth" | "upstream",
  ) {
    super(message);
    this.name = "FssFinlifeError";
  }
}

interface RawBase {
  dcls_month?: string;
  fin_co_no?: string;
  kor_co_nm?: string;
  fin_prdt_cd?: string;
  fin_prdt_nm?: string;
}

interface RawOption {
  dcls_month?: string;
  fin_co_no?: string;
  fin_prdt_cd?: string;
  mrtg_type?: string;
  mrtg_type_nm?: string;
  rpay_type?: string;
  rpay_type_nm?: string;
  lend_rate_type?: string;
  lend_rate_type_nm?: string;
  lend_rate_min?: number | string | null;
  lend_rate_max?: number | string | null;
  lend_rate_avg?: number | string | null;
}

interface RawResult {
  result?: {
    err_cd?: string;
    err_msg?: string;
    total_count?: number | string;
    max_page_no?: number | string;
    now_page_no?: number | string;
    baseList?: RawBase[];
    optionList?: RawOption[];
  };
}

function apiKey(): string {
  const key = process.env.FSS_FINLIFE_API_KEY?.trim();
  if (!key) throw new FssFinlifeError("금융감독원 Open API 인증키가 설정되지 않았습니다.", "no-key");
  return key;
}

function rate(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

function month(raw: string | undefined): string {
  const d = (raw ?? "").replaceAll(/\D/g, "");
  return d.length >= 6 ? `${d.slice(0, 4)}-${d.slice(4, 6)}` : "";
}

function toRateType(o: RawOption): RateType | null {
  const s = `${o.lend_rate_type_nm ?? ""}`;
  if (s.includes("혼합")) return "mixed";
  if (s.includes("고정")) return "fixed";
  if (s.includes("변동")) return "variable";
  if (o.lend_rate_type === "F") return "fixed";
  if (o.lend_rate_type === "C") return "variable";
  return null;
}

function toRepay(o: RawOption): RepayType | null {
  const s = `${o.rpay_type_nm ?? ""}`;
  if (s.includes("분할")) return "installment";
  if (s.includes("만기") || s.includes("일시")) return "bullet";
  if (o.rpay_type === "D") return "installment";
  if (o.rpay_type === "S") return "bullet";
  return null;
}

function toCollateral(o: RawOption): Collateral | null {
  const s = `${o.mrtg_type_nm ?? ""}`;
  if (!s && !o.mrtg_type) return null;
  if (s.includes("아파트외") || s.includes("아파트 외") || o.mrtg_type === "E") return "other";
  if (s.includes("아파트") || o.mrtg_type === "A") return "apt";
  return "other";
}

async function fetchPage(kind: LoanKind, sector: Sector, pageNo: number) {
  const url =
    `${FINLIFE_BASE}/${SERVICE[kind]}.json?auth=${encodeURIComponent(apiKey())}` +
    `&topFinGrpNo=${SECTOR_GROUP[sector]}&pageNo=${pageNo}`;
  let res: Response;
  try {
    res = await fetch(url, {
      cache: "no-store", // 정규화 결과를 unstable_cache로 캐시한다 (원본 응답은 저장하지 않음)
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new FssFinlifeError("금융감독원 공시 서버에 연결하지 못했습니다.", "upstream");
  }
  if (!res.ok) throw new FssFinlifeError(`금융감독원 공시 서버 응답 오류 (${res.status})`, "upstream");
  let body: RawResult;
  try {
    body = (await res.json()) as RawResult;
  } catch {
    throw new FssFinlifeError("금융감독원 공시 응답을 해석하지 못했습니다.", "upstream");
  }
  const r = body.result;
  const code = r?.err_cd ?? "";
  if (code !== "000") {
    // 010 미등록 인증키, 011 중지된 인증키, 012 삭제된 인증키, 013 샘플 인증키, 020 일일 검색 허용횟수 초과
    const auth = ["010", "011", "012", "013"].includes(code);
    throw new FssFinlifeError(
      auth
        ? `금융감독원 Open API 인증키가 유효하지 않습니다 (${r?.err_msg ?? code}).`
        : `금융감독원 공시 조회 오류 (${r?.err_msg ?? code ?? "알 수 없음"})`,
      auth ? "auth" : "upstream",
    );
  }
  return {
    base: r?.baseList ?? [],
    options: r?.optionList ?? [],
    maxPage: Math.max(1, Number(r?.max_page_no) || 1),
  };
}

async function fetchSector(kind: LoanKind, sector: Sector): Promise<LoanRateOption[]> {
  const first = await fetchPage(kind, sector, 1);
  const pages = [first];
  const last = Math.min(first.maxPage, MAX_PAGES);
  if (last > 1) {
    const rest = await Promise.all(
      Array.from({ length: last - 1 }, (_, i) => fetchPage(kind, sector, i + 2)),
    );
    pages.push(...rest);
  }

  const products = new Map<string, RawBase>();
  for (const p of pages) for (const b of p.base) products.set(`${b.fin_co_no}|${b.fin_prdt_cd}`, b);

  const out: LoanRateOption[] = [];
  for (const p of pages) {
    for (const o of p.options) {
      const b = products.get(`${o.fin_co_no}|${o.fin_prdt_cd}`);
      if (!b) continue;
      const min = rate(o.lend_rate_min);
      const max = rate(o.lend_rate_max);
      const avg = rate(o.lend_rate_avg);
      if (min == null && avg == null) continue;
      out.push({
        id: [sector, o.fin_co_no, o.fin_prdt_cd, o.mrtg_type ?? "", o.rpay_type ?? "", o.lend_rate_type ?? ""].join(":"),
        sector,
        bank: (b.kor_co_nm ?? "").trim(),
        product: (b.fin_prdt_nm ?? "").trim(),
        rateType: toRateType(o),
        repay: toRepay(o),
        collateral: kind === "mortgage" ? toCollateral(o) : null,
        min,
        max,
        avg,
        dclsMonth: month(o.dcls_month ?? b.dcls_month),
      });
    }
  }
  return out;
}

async function loadDataset(kind: LoanKind): Promise<LoanRateDataset> {
  const [bank, savings] = await Promise.all([fetchSector(kind, "bank"), fetchSector(kind, "savings")]);
  const options = [...bank, ...savings];
  const months = options.map((o) => o.dclsMonth).filter(Boolean).sort();
  return {
    kind,
    options,
    dclsMonth: months.length ? months[months.length - 1]! : null,
    fetchedAt: new Date().toISOString(),
  };
}

/** 대출 종류별 정규화 데이터 — 하루 캐시 (공시는 월 단위) */
export const getLoanRateDataset = unstable_cache(loadDataset, ["fss-finlife-loan-rates-v1"], {
  revalidate: REVALIDATE_SECONDS,
  tags: ["fss-finlife"],
});

function sortValue(o: LoanRateOption, key: "min" | "avg"): number {
  // 기준 금리가 공시되지 않은 옵션은 맨 뒤로
  return (key === "min" ? o.min : o.avg) ?? Number.POSITIVE_INFINITY;
}

/** Infinity 끼리 빼면 NaN이 되므로 비교로 */
function cmp(a: number, b: number): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

/** 요청한 조건에 맞는 상위 목록만 돌려준다 (원본 전체를 내보내지 않는다) */
export async function queryLoanRates(f: LoanRateFilters): Promise<LoanRatesResponse> {
  const data = await getLoanRateDataset(f.kind);
  const matched = data.options.filter(
    (o) =>
      (f.sector === "all" || o.sector === f.sector) &&
      (f.rateType === "all" || o.rateType === f.rateType) &&
      (f.repay === "all" || o.repay === f.repay) &&
      (f.collateral === "all" || o.collateral === f.collateral),
  );
  matched.sort(
    (a, b) =>
      cmp(sortValue(a, f.sort), sortValue(b, f.sort)) ||
      cmp(sortValue(a, f.sort === "min" ? "avg" : "min"), sortValue(b, f.sort === "min" ? "avg" : "min")) ||
      a.bank.localeCompare(b.bank, "ko"),
  );
  return {
    filters: f,
    items: matched.slice(0, LOAN_RATE_LIMIT),
    matched: matched.length,
    dclsMonth: data.dclsMonth,
    fetchedAt: data.fetchedAt,
    source: FSS_SOURCE_LABEL,
  };
}

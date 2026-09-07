export type DealType = "trade" | "rent";

export type AreaFilter =
  | "all"
  | "under-60"
  | "60-85"
  | "85-102"
  | "over-102";

export interface Transaction {
  id: string;
  dealType: DealType;
  dealDate: string; // YYYY-MM-DD
  aptName: string;
  gu: string; // 만안구 | 동안구
  dong: string;
  exclusiveArea: number; // ㎡
  dealAmount: number; // 만원 (매매) or 보증금 (전월세)
  monthlyRent: number; // 만원 (전월세만, 매매는 0)
  floor: number;
  buildYear: number | null;
  jibun: string;
  dealingGbn: string;
  /** 법정동코드 (웨어하우스 적재용) */
  lawdCd?: string;
}

export interface TransactionFilters {
  aptName: string;
  gu: string;
  dong: string;
  dealType: DealType | "all";
  area: AreaFilter;
  yearMonth: string; // YYYYMM
  page: number;
  pageSize: number;
}

export interface TransactionStats {
  totalCount: number;
  recentCount: number;
  todayCount: number;
  maxDeal: Transaction | null;
  avgDealAmount: number;
}

export interface TransactionsResponse {
  items: Transaction[];
  totalCount: number;
  page: number;
  pageSize: number;
  totalPages: number;
  stats: TransactionStats;
  source: "api" | "mock";
  yearMonth: string;
  warning?: string;
  apiConfigured?: boolean;
  lawdCodes?: string[];
}

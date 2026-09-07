import {
  RENT_API_URL,
  TRADE_API_URL,
} from "@/lib/constants/regions";
import {
  getApiResultCode,
  parseRentXml,
  parseTradeXml,
} from "@/lib/molit/parse";
import type { DealType, Transaction } from "@/types/transaction";

const FETCH_CONCURRENCY = 10;
const MONTH_CACHE_TTL_MS = 45 * 60 * 1000;

type MonthCacheEntry = {
  builtAt: number;
  items: Transaction[];
};

const monthCache = new Map<string, MonthCacheEntry>();
const monthInflight = new Map<string, Promise<Transaction[]>>();

function monthCacheKey(
  kind: "trade" | "rent",
  lawdCd: string,
  yearMonth: string,
): string {
  return `${kind}|${lawdCd}|${yearMonth}`;
}

function getCachedMonth(key: string): Transaction[] | null {
  const hit = monthCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.builtAt > MONTH_CACHE_TTL_MS) {
    monthCache.delete(key);
    return null;
  }
  return hit.items;
}

function setCachedMonth(key: string, items: Transaction[]) {
  monthCache.set(key, { builtAt: Date.now(), items });
}

function getServiceKey(): string | null {
  const raw = process.env.MOLIT_API_KEY?.trim();
  if (!raw) return null;
  // 인코딩 키가 아니면 encode, 이미 % 포함이면 그대로 사용
  return raw.includes("%") ? raw : encodeURIComponent(raw);
}

export function hasApiKey(): boolean {
  return Boolean(process.env.MOLIT_API_KEY?.trim());
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      try {
        const value = await mapper(items[index]);
        results[index] = { status: "fulfilled", value };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, Math.max(items.length, 1)) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

async function fetchMolitXml(
  baseUrl: string,
  lawdCd: string,
  yearMonth: string,
  pageNo = 1,
  numOfRows = 1000,
): Promise<string> {
  const serviceKey = getServiceKey();
  if (!serviceKey) {
    throw new Error("MOLIT_API_KEY is not configured");
  }

  const params = new URLSearchParams({
    LAWD_CD: lawdCd,
    DEAL_YMD: yearMonth,
    pageNo: String(pageNo),
    numOfRows: String(numOfRows),
  });

  const fullUrl = `${baseUrl}?serviceKey=${serviceKey}&${params.toString()}`;

  let lastStatus = 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const res = await fetch(fullUrl, {
      next: { revalidate: 1800 },
      headers: { Accept: "application/xml, text/xml, */*" },
    });
    lastStatus = res.status;
    if (res.status === 429 || res.status === 503) {
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
      continue;
    }
    if (!res.ok) {
      throw new Error(`MOLIT API HTTP ${res.status} (${lawdCd})`);
    }
    return res.text();
  }

  throw new Error(`MOLIT API HTTP ${lastStatus} (${lawdCd})`);
}

function isOkOrEmpty(xml: string): { ok: boolean; empty: boolean; message: string } {
  const { code, message } = getApiResultCode(xml);
  if (
    code === "00" ||
    code === "000" ||
    code === "0" ||
    code === "NORMAL_SERVICE"
  ) {
    return { ok: true, empty: false, message };
  }
  if (
    code === "03" ||
    message.includes("NODATA") ||
    message.includes("없는") ||
    message.includes("없음")
  ) {
    return { ok: true, empty: true, message };
  }
  return { ok: false, empty: false, message: `${code} ${message}` };
}

async function fetchOneTradeUncached(
  lawdCd: string,
  yearMonth: string,
): Promise<Transaction[]> {
  const xml = await fetchMolitXml(TRADE_API_URL, lawdCd, yearMonth);
  const status = isOkOrEmpty(xml);
  if (!status.ok) {
    throw new Error(`Trade API ${lawdCd}: ${status.message}`);
  }
  if (status.empty) return [];
  return parseTradeXml(xml, lawdCd);
}

async function fetchOneRentUncached(
  lawdCd: string,
  yearMonth: string,
): Promise<Transaction[]> {
  const xml = await fetchMolitXml(RENT_API_URL, lawdCd, yearMonth);
  const status = isOkOrEmpty(xml);
  if (!status.ok) {
    throw new Error(`Rent API ${lawdCd}: ${status.message}`);
  }
  if (status.empty) return [];
  return parseRentXml(xml, lawdCd);
}

async function fetchOneTrade(
  lawdCd: string,
  yearMonth: string,
): Promise<Transaction[]> {
  const key = monthCacheKey("trade", lawdCd, yearMonth);
  const cached = getCachedMonth(key);
  if (cached) return cached;

  const inflight = monthInflight.get(key);
  if (inflight) return inflight;

  const promise = fetchOneTradeUncached(lawdCd, yearMonth)
    .then((items) => {
      setCachedMonth(key, items);
      return items;
    })
    .finally(() => {
      monthInflight.delete(key);
    });

  monthInflight.set(key, promise);
  return promise;
}

async function fetchOneRent(
  lawdCd: string,
  yearMonth: string,
): Promise<Transaction[]> {
  const key = monthCacheKey("rent", lawdCd, yearMonth);
  const cached = getCachedMonth(key);
  if (cached) return cached;

  const inflight = monthInflight.get(key);
  if (inflight) return inflight;

  const promise = fetchOneRentUncached(lawdCd, yearMonth)
    .then((items) => {
      setCachedMonth(key, items);
      return items;
    })
    .finally(() => {
      monthInflight.delete(key);
    });

  monthInflight.set(key, promise);
  return promise;
}

/** 구/시군 코드별 병렬 조회. 일부 실패해도 성공분 반환 */
export async function fetchTradeTransactions(
  yearMonth: string,
  lawdCodes: string[],
): Promise<Transaction[]> {
  const settled = await mapWithConcurrency(
    lawdCodes,
    FETCH_CONCURRENCY,
    (lawdCd) => fetchOneTrade(lawdCd, yearMonth),
  );
  const items: Transaction[] = [];
  const errors: string[] = [];
  for (const r of settled) {
    if (r.status === "fulfilled") items.push(...r.value);
    else errors.push(String(r.reason));
  }
  if (items.length === 0 && errors.length === lawdCodes.length) {
    throw new Error(errors[0] || "Trade API failed");
  }
  if (errors.length) {
    console.warn("[molit] partial trade failures:", errors);
  }
  return items;
}

export async function fetchRentTransactions(
  yearMonth: string,
  lawdCodes: string[],
): Promise<Transaction[]> {
  const settled = await mapWithConcurrency(
    lawdCodes,
    FETCH_CONCURRENCY,
    (lawdCd) => fetchOneRent(lawdCd, yearMonth),
  );
  const items: Transaction[] = [];
  const errors: string[] = [];
  for (const r of settled) {
    if (r.status === "fulfilled") items.push(...r.value);
    else errors.push(String(r.reason));
  }
  if (items.length === 0 && errors.length === lawdCodes.length) {
    throw new Error(errors[0] || "Rent API failed");
  }
  if (errors.length) {
    console.warn("[molit] partial rent failures:", errors);
  }
  return items;
}

export async function fetchTransactionsByType(
  yearMonth: string,
  dealType: DealType | "all",
  lawdCodes: string[],
): Promise<Transaction[]> {
  if (!lawdCodes.length) return [];

  if (dealType === "trade") {
    return fetchTradeTransactions(yearMonth, lawdCodes);
  }
  if (dealType === "rent") {
    return fetchRentTransactions(yearMonth, lawdCodes);
  }

  const [trade, rent] = await Promise.all([
    fetchTradeTransactions(yearMonth, lawdCodes),
    fetchRentTransactions(yearMonth, lawdCodes),
  ]);
  return [...trade, ...rent];
}

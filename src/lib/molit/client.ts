import {
  LAWD_CD,
  RENT_API_URL,
  TRADE_API_URL,
} from "@/lib/constants/regions";
import {
  getApiResultCode,
  parseRentXml,
  parseTradeXml,
} from "@/lib/molit/parse";
import type { DealType, Transaction } from "@/types/transaction";

function getServiceKey(): string | null {
  const key = process.env.MOLIT_API_KEY?.trim();
  return key && key.length > 0 ? key : null;
}

async function fetchMolitXml(
  baseUrl: string,
  yearMonth: string,
  pageNo = 1,
  numOfRows = 1000,
): Promise<string> {
  const serviceKey = getServiceKey();
  if (!serviceKey) {
    throw new Error("MOLIT_API_KEY is not configured");
  }

  const url = new URL(baseUrl);
  // 공공데이터포털 키는 이미 URL-encoded 형태일 수 있음 → 직접 쿼리 문자열에 붙임
  const params = new URLSearchParams({
    LAWD_CD,
    DEAL_YMD: yearMonth,
    pageNo: String(pageNo),
    numOfRows: String(numOfRows),
  });

  const fullUrl = `${url.toString()}?serviceKey=${serviceKey}&${params.toString()}`;
  const res = await fetch(fullUrl, {
    next: { revalidate: 3600 },
    headers: { Accept: "application/xml" },
  });

  if (!res.ok) {
    throw new Error(`MOLIT API HTTP ${res.status}`);
  }

  return res.text();
}

export async function fetchTradeTransactions(
  yearMonth: string,
): Promise<Transaction[]> {
  const xml = await fetchMolitXml(TRADE_API_URL, yearMonth);
  const { code, message } = getApiResultCode(xml);
  if (code !== "00" && code !== "0" && code !== "NORMAL_SERVICE") {
    throw new Error(`Trade API error: ${code} ${message}`);
  }
  return parseTradeXml(xml);
}

export async function fetchRentTransactions(
  yearMonth: string,
): Promise<Transaction[]> {
  const xml = await fetchMolitXml(RENT_API_URL, yearMonth);
  const { code, message } = getApiResultCode(xml);
  if (code !== "00" && code !== "0" && code !== "NORMAL_SERVICE") {
    throw new Error(`Rent API error: ${code} ${message}`);
  }
  return parseRentXml(xml);
}

export async function fetchTransactionsByType(
  yearMonth: string,
  dealType: DealType | "all",
): Promise<Transaction[]> {
  if (dealType === "trade") {
    return fetchTradeTransactions(yearMonth);
  }
  if (dealType === "rent") {
    return fetchRentTransactions(yearMonth);
  }

  const [trade, rent] = await Promise.all([
    fetchTradeTransactions(yearMonth),
    fetchRentTransactions(yearMonth),
  ]);
  return [...trade, ...rent];
}

export function hasApiKey(): boolean {
  return Boolean(getServiceKey());
}

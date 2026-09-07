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

function getServiceKey(): string | null {
  const key = process.env.MOLIT_API_KEY?.trim();
  return key && key.length > 0 ? key : null;
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

  const url = new URL(baseUrl);
  const params = new URLSearchParams({
    LAWD_CD: lawdCd,
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
    throw new Error(`MOLIT API HTTP ${res.status} (${lawdCd})`);
  }

  return res.text();
}

function assertApiOk(xml: string, label: string) {
  const { code, message } = getApiResultCode(xml);
  if (code !== "00" && code !== "0" && code !== "NORMAL_SERVICE") {
    // NODATA is ok for empty months
    if (code === "03" || message.includes("NODATA") || message.includes("없음")) {
      return;
    }
    throw new Error(`${label} error: ${code} ${message}`);
  }
}

export async function fetchTradeTransactions(
  yearMonth: string,
  lawdCodes: string[],
): Promise<Transaction[]> {
  const results = await Promise.all(
    lawdCodes.map(async (lawdCd) => {
      const xml = await fetchMolitXml(TRADE_API_URL, lawdCd, yearMonth);
      assertApiOk(xml, `Trade API ${lawdCd}`);
      return parseTradeXml(xml, lawdCd);
    }),
  );
  return results.flat();
}

export async function fetchRentTransactions(
  yearMonth: string,
  lawdCodes: string[],
): Promise<Transaction[]> {
  const results = await Promise.all(
    lawdCodes.map(async (lawdCd) => {
      const xml = await fetchMolitXml(RENT_API_URL, lawdCd, yearMonth);
      assertApiOk(xml, `Rent API ${lawdCd}`);
      return parseRentXml(xml, lawdCd);
    }),
  );
  return results.flat();
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

export function hasApiKey(): boolean {
  return Boolean(getServiceKey());
}

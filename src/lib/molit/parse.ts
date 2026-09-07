import { XMLParser } from "fast-xml-parser";
import { districtNameFromCode } from "@/lib/constants/regions";
import type { DealType, Transaction } from "@/types/transaction";
import { pad2, parseManwon } from "@/lib/utils/format";

const parser = new XMLParser({
  ignoreAttributes: false,
  trimValues: true,
  isArray: (name) => name === "item",
});

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function text(value: unknown): string {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function buildDealDate(year: string, month: string, day: string): string {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function resolveGu(sggCd: string | undefined, lawdCd: string): string {
  const fromItem = districtNameFromCode(text(sggCd));
  if (fromItem) return fromItem;
  return districtNameFromCode(lawdCd) || "";
}

interface RawTradeItem {
  aptNm?: string;
  umdNm?: string;
  excluUseAr?: string | number;
  dealAmount?: string | number;
  floor?: string | number;
  buildYear?: string | number;
  dealYear?: string | number;
  dealMonth?: string | number;
  dealDay?: string | number;
  jibun?: string;
  dealingGbn?: string;
  sggCd?: string;
}

interface RawRentItem {
  aptNm?: string;
  umdNm?: string;
  excluUseAr?: string | number;
  deposit?: string | number;
  monthlyRent?: string | number;
  floor?: string | number;
  buildYear?: string | number;
  dealYear?: string | number;
  dealMonth?: string | number;
  dealDay?: string | number;
  jibun?: string;
  contractType?: string;
  sggCd?: string;
}

export function parseTradeXml(xml: string, lawdCd: string): Transaction[] {
  const json = parser.parse(xml);
  const items = asArray<RawTradeItem>(json?.response?.body?.items?.item);

  return items
    .map((item, index) => {
      const year = text(item.dealYear);
      const month = text(item.dealMonth);
      const day = text(item.dealDay);
      const aptName = text(item.aptNm);
      const dong = text(item.umdNm);
      const gu = resolveGu(item.sggCd, lawdCd);
      const exclusiveArea = Number(item.excluUseAr) || 0;
      const dealAmount = parseManwon(item.dealAmount);
      const floor = Number(text(item.floor)) || 0;

      if (!year || !month || !day || !aptName) return null;

      const dealDate = buildDealDate(year, month, day);
      const tx: Transaction = {
        id: `trade-${lawdCd}-${dealDate}-${aptName}-${dong}-${floor}-${dealAmount}-${exclusiveArea}-${index}`,
        dealType: "trade",
        dealDate,
        aptName,
        gu,
        dong,
        exclusiveArea,
        dealAmount,
        monthlyRent: 0,
        floor,
        buildYear: item.buildYear ? Number(item.buildYear) : null,
        jibun: text(item.jibun),
        dealingGbn: text(item.dealingGbn) || "중개거래",
        lawdCd,
      };
      return tx;
    })
    .filter((v): v is Transaction => v !== null);
}

export function parseRentXml(xml: string, lawdCd: string): Transaction[] {
  const json = parser.parse(xml);
  const items = asArray<RawRentItem>(json?.response?.body?.items?.item);

  return items
    .map((item, index) => {
      const year = text(item.dealYear);
      const month = text(item.dealMonth);
      const day = text(item.dealDay);
      const aptName = text(item.aptNm);
      const dong = text(item.umdNm);
      const gu = resolveGu(item.sggCd, lawdCd);
      const exclusiveArea = Number(item.excluUseAr) || 0;
      const dealAmount = parseManwon(item.deposit);
      const monthlyRent = parseManwon(item.monthlyRent);
      const floor = Number(text(item.floor)) || 0;

      if (!year || !month || !day || !aptName) return null;

      const dealDate = buildDealDate(year, month, day);
      const tx: Transaction = {
        id: `rent-${lawdCd}-${dealDate}-${aptName}-${dong}-${floor}-${dealAmount}-${monthlyRent}-${exclusiveArea}-${index}`,
        dealType: "rent",
        dealDate,
        aptName,
        gu,
        dong,
        exclusiveArea,
        dealAmount,
        monthlyRent,
        floor,
        buildYear: item.buildYear ? Number(item.buildYear) : null,
        jibun: text(item.jibun),
        dealingGbn: text(item.contractType) || "전월세",
        lawdCd,
      };
      return tx;
    })
    .filter((v): v is Transaction => v !== null);
}

export function getApiResultCode(xml: string): {
  code: string;
  message: string;
} {
  const json = parser.parse(xml);
  const header = json?.response?.header;
  return {
    code: text(header?.resultCode) || "UNKNOWN",
    message: text(header?.resultMsg) || "Unknown error",
  };
}

export function sortByDealDateDesc(items: Transaction[]): Transaction[] {
  return [...items].sort((a, b) => {
    if (a.dealDate === b.dealDate) {
      return b.dealAmount - a.dealAmount;
    }
    return a.dealDate < b.dealDate ? 1 : -1;
  });
}

export function filterTransactions(
  items: Transaction[],
  opts: {
    aptName?: string;
    gu?: string;
    dong?: string;
    dealType?: DealType | "all";
    areaMatcher?: (sqm: number) => boolean;
  },
): Transaction[] {
  const keyword = opts.aptName?.trim().toLowerCase() ?? "";
  return items.filter((item) => {
    if (opts.dealType && opts.dealType !== "all" && item.dealType !== opts.dealType) {
      return false;
    }
    if (
      opts.gu &&
      opts.gu !== "all" &&
      !item.gu.includes(opts.gu) &&
      opts.gu !== item.gu
    ) {
      return false;
    }
    if (opts.dong && opts.dong !== "all" && !item.dong.includes(opts.dong)) {
      return false;
    }
    if (keyword && !item.aptName.toLowerCase().includes(keyword)) {
      return false;
    }
    if (opts.areaMatcher && !opts.areaMatcher(item.exclusiveArea)) {
      return false;
    }
    return true;
  });
}

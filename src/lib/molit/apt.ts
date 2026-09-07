import {
  FEATURED_LAWD_CODES,
  ALL_REGIONS,
  getRegion,
  type RegionDef,
} from "@/lib/constants/regions";
import { fetchTransactionsByType, hasApiKey } from "@/lib/molit/client";
import { loadRawTransactions } from "@/lib/molit/service";
import {
  formatEok,
  recentYearMonths,
  toPyeong,
} from "@/lib/utils/format";
import type { Transaction } from "@/types/transaction";
import { buildRegionDemoTransactions } from "@/lib/mock/region-demo";

export interface AptSuggestion {
  aptName: string;
  regionSlug: string;
  regionName: string;
  gu: string;
  dong: string;
  dealCount: number;
  maxDealAmount: number;
  latestDealDate: string;
}

export interface AptAreaOption {
  key: string;
  label: string;
  exclusiveArea: number;
  count: number;
}

export interface AptHistoryItem extends Transaction {
  isSingoga: boolean;
  pyeong: number;
}

export interface AptDetailResponse {
  aptName: string;
  regionSlug: string;
  regionName: string;
  fullName: string;
  gu: string;
  dong: string;
  buildYear: number | null;
  source: "api" | "mock";
  yearMonth: string;
  warning?: string;
  stats: {
    recent3mCount: number;
    maxDealAmount: number;
    avgDealAmount: number;
    totalTradeCount: number;
  };
  areas: AptAreaOption[];
  items: AptHistoryItem[];
}

function normalizeName(name: string): string {
  return name.replace(/\s+/g, "").toLowerCase();
}

function areaKey(sqm: number): string {
  return String(Math.round(sqm * 100) / 100);
}

function areaLabel(sqm: number): string {
  const pyeong = toPyeong(sqm);
  return `${Math.round(pyeong)}평 (${sqm.toFixed(2)}㎡)`;
}

function threeMonthsAgoDate(): string {
  const d = new Date();
  d.setMonth(d.getMonth() - 3);
  return d.toISOString().slice(0, 10);
}

async function loadSuggestPool(): Promise<Transaction[]> {
  const months = recentYearMonths(2);
  const chunks = await Promise.all(
    months.map((ym) =>
      loadRawTransactions(ym, "trade", [...FEATURED_LAWD_CODES]),
    ),
  );
  return chunks.flatMap((c) => c.items);
}

function regionFromGu(gu: string): RegionDef | undefined {
  return ALL_REGIONS.find((r) => {
    if (r.metro === "seoul") return gu.includes(r.name) || r.name === gu;
    return (
      gu.includes(r.name) ||
      r.districts.some((d) => gu.includes(d.name) || d.name === gu)
    );
  });
}

/** 단지명 자동완성 */
export async function searchAptSuggestions(
  query: string,
  limit = 8,
): Promise<AptSuggestion[]> {
  const q = normalizeName(query.trim());
  if (q.length < 1) return [];

  const pool = await loadSuggestPool();
  const grouped = new Map<
    string,
    {
      aptName: string;
      gu: string;
      dong: string;
      dealCount: number;
      maxDealAmount: number;
      latestDealDate: string;
    }
  >();

  for (const tx of pool) {
    if (tx.dealType !== "trade") continue;
    const aptKey = normalizeName(tx.aptName);
    if (!aptKey.includes(q)) continue;
    const region = regionFromGu(tx.gu);
    if (!region) continue;
    const key = `${normalizeName(tx.aptName)}|${region.slug}`;
    const prev = grouped.get(key);
    if (!prev) {
      grouped.set(key, {
        aptName: tx.aptName,
        gu: tx.gu,
        dong: tx.dong,
        dealCount: 1,
        maxDealAmount: tx.dealAmount,
        latestDealDate: tx.dealDate,
      });
      continue;
    }
    prev.dealCount += 1;
    prev.maxDealAmount = Math.max(prev.maxDealAmount, tx.dealAmount);
    if (tx.dealDate > prev.latestDealDate) {
      prev.latestDealDate = tx.dealDate;
      prev.dong = tx.dong;
      prev.gu = tx.gu;
    }
  }

  return [...grouped.entries()]
    .map(([key, value]) => {
      const regionSlug = key.split("|")[1];
      const region = getRegion(regionSlug)!;
      return {
        aptName: value.aptName,
        regionSlug: region.slug,
        regionName: region.name,
        gu: value.gu,
        dong: value.dong,
        dealCount: value.dealCount,
        maxDealAmount: value.maxDealAmount,
        latestDealDate: value.latestDealDate,
      };
    })
    .sort((a, b) => {
      const aExact = normalizeName(a.aptName) === q ? 1 : 0;
      const bExact = normalizeName(b.aptName) === q ? 1 : 0;
      if (aExact !== bExact) return bExact - aExact;
      if (b.dealCount !== a.dealCount) return b.dealCount - a.dealCount;
      return b.maxDealAmount - a.maxDealAmount;
    })
    .slice(0, limit);
}

/** 단지 실거래 이력 (최근 N개월 매매 중심) */
export async function getAptDetail(params: {
  aptName: string;
  regionSlug: string;
  months?: number;
}): Promise<AptDetailResponse | null> {
  const region = getRegion(params.regionSlug);
  if (!region) return null;

  const aptName = params.aptName.trim();
  if (!aptName) return null;

  const months = recentYearMonths(params.months ?? 12);
  let source: "api" | "mock" = "mock";
  let warning: string | undefined;
  const collected: Transaction[] = [];

  if (hasApiKey()) {
    const settled = await Promise.allSettled(
      months.map(async (ym) => {
        try {
          return await fetchTransactionsByType(ym, "trade", [
            ...region.lawdCodes,
          ]);
        } catch {
          return [] as Transaction[];
        }
      }),
    );
    for (const result of settled) {
      if (result.status === "fulfilled" && result.value.length > 0) {
        source = "api";
        collected.push(...result.value);
      }
    }
    if (collected.length === 0) {
      warning = "선택한 단지·기간에 API 매매 데이터가 없습니다.";
    }
  } else {
    warning =
      "MOLIT_API_KEY가 없어 지역별 데모 데이터로 표시 중입니다. Vercel/로컬 환경변수에 키를 설정하세요.";
    for (const ym of months.slice(0, 3)) {
      collected.push(...buildRegionDemoTransactions(region, ym));
    }
  }

  const yearMonth = months[0];
  const aptKey = normalizeName(aptName);
  const matched = collected
    .filter(
      (tx) =>
        tx.dealType === "trade" &&
        normalizeName(tx.aptName).includes(aptKey),
    )
    .sort((a, b) => {
      if (a.dealDate === b.dealDate) return b.dealAmount - a.dealAmount;
      return a.dealDate < b.dealDate ? 1 : -1;
    });

  // Prefer exact name cluster if any
  const exact = matched.filter((tx) => normalizeName(tx.aptName) === aptKey);
  const trades = exact.length > 0 ? exact : matched;

  if (trades.length === 0) {
    return {
      aptName,
      regionSlug: region.slug,
      regionName: region.name,
      fullName: region.fullName,
      gu: region.districts[0]?.name ?? region.name,
      dong: "",
      buildYear: null,
      source,
      yearMonth,
      warning: warning ?? "해당 단지의 매매 실거래를 찾지 못했습니다.",
      stats: {
        recent3mCount: 0,
        maxDealAmount: 0,
        avgDealAmount: 0,
        totalTradeCount: 0,
      },
      areas: [],
      items: [],
    };
  }

  const canonicalName = trades[0].aptName;
  const since = threeMonthsAgoDate();
  const recent3m = trades.filter((t) => t.dealDate >= since);
  const maxDealAmount = Math.max(...trades.map((t) => t.dealAmount));
  const avgDealAmount = Math.round(
    trades.reduce((s, t) => s + t.dealAmount, 0) / trades.length,
  );

  const maxByArea = new Map<string, number>();
  for (const tx of trades) {
    const key = areaKey(tx.exclusiveArea);
    maxByArea.set(key, Math.max(maxByArea.get(key) ?? 0, tx.dealAmount));
  }

  const areaCount = new Map<string, { sqm: number; count: number }>();
  for (const tx of trades) {
    const key = areaKey(tx.exclusiveArea);
    const prev = areaCount.get(key);
    if (!prev) areaCount.set(key, { sqm: tx.exclusiveArea, count: 1 });
    else prev.count += 1;
  }

  const areas: AptAreaOption[] = [...areaCount.entries()]
    .map(([key, value]) => ({
      key,
      exclusiveArea: value.sqm,
      count: value.count,
      label: areaLabel(value.sqm),
    }))
    .sort((a, b) => a.exclusiveArea - b.exclusiveArea);

  const buildYears = trades
    .map((t) => t.buildYear)
    .filter((y): y is number => typeof y === "number" && y > 1900);
  const buildYear =
    buildYears.length > 0
      ? buildYears.sort(
          (a, b) =>
            buildYears.filter((x) => x === b).length -
            buildYears.filter((x) => x === a).length,
        )[0]
      : null;

  const items: AptHistoryItem[] = trades.map((tx) => ({
    ...tx,
    pyeong: toPyeong(tx.exclusiveArea),
    isSingoga:
      tx.dealAmount === (maxByArea.get(areaKey(tx.exclusiveArea)) ?? -1),
  }));

  return {
    aptName: canonicalName,
    regionSlug: region.slug,
    regionName: region.name,
    fullName: region.fullName,
    gu: trades[0].gu,
    dong: trades[0].dong,
    buildYear,
    source,
    yearMonth,
    warning,
    stats: {
      recent3mCount: recent3m.length,
      maxDealAmount,
      avgDealAmount,
      totalTradeCount: trades.length,
    },
    areas,
    items,
  };
}

export function aptDetailHref(aptName: string, regionSlug: string): string {
  return `/apt/${encodeURIComponent(aptName)}?region=${encodeURIComponent(regionSlug)}`;
}

export function formatAptPriceLabel(manwon: number): string {
  return formatEok(manwon);
}

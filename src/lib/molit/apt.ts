import {
  FEATURED_LAWD_CODES,
  ALL_REGIONS,
  getRegion,
  type RegionDef,
} from "@/lib/constants/regions";
import { fetchTransactionsByType, hasApiKey } from "@/lib/molit/client";
import {
  hasDb,
} from "@/lib/db/client";
import {
  queryAptTransactions,
  queryTradePool,
  searchAptAggregatesFromDb,
} from "@/lib/db/repository";
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

export interface AptChartPoint {
  yearMonth: string; // YYYYMM
  label: string; // YY.MM
  tradeAvg: number | null;
  tradeMax: number | null;
  tradeCount: number;
  jeonseAvg: number | null;
  jeonseCount: number;
  wolseCount: number;
  volume: number;
}

export interface AptDetailResponse {
  aptName: string;
  regionSlug: string;
  regionName: string;
  fullName: string;
  gu: string;
  dong: string;
  buildYear: number | null;
  source: "api" | "mock" | "db";
  yearMonth: string;
  warning?: string;
  /** 최근 N개월만 먼저 내려준 부분 응답 */
  partial?: boolean;
  loadedMonths: number;
  stats: {
    recent3mCount: number;
    maxDealAmount: number;
    avgDealAmount: number;
    totalTradeCount: number;
    totalRentCount: number;
  };
  areas: AptAreaOption[];
  chart: AptChartPoint[];
  items: AptHistoryItem[];
}

const SUGGEST_MONTHS = 4;
const SUGGEST_CACHE_TTL_MS = 45 * 60 * 1000;

type SuggestAgg = {
  aptName: string;
  gu: string;
  dong: string;
  dealCount: number;
  maxDealAmount: number;
  latestDealDate: string;
};

type SuggestCacheBucket = {
  builtAt: number;
  items: Transaction[];
};

const suggestPoolCache = new Map<string, SuggestCacheBucket>();
const suggestPoolInflight = new Map<string, Promise<Transaction[]>>();

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

/** FEATURED에 한 구만 있어도 같은 시의 나머지 구까지 포함 (예: 동안 → 만안) */
function expandFeaturedLawdCodes(): string[] {
  const featured = new Set<string>(FEATURED_LAWD_CODES);
  const codes = new Set<string>();
  for (const region of ALL_REGIONS) {
    if (region.lawdCodes.some((code) => featured.has(code))) {
      for (const code of region.lawdCodes) codes.add(code);
    }
  }
  return [...codes];
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

/** 구명이 있으면 해당 법정동코드만, 없으면 지역 전체 */
function resolveDetailLawdCodes(region: RegionDef, gu?: string): string[] {
  const needle = gu?.trim();
  if (!needle) return [...region.lawdCodes];
  const hit = region.districts.find(
    (d) => needle === d.name || needle.includes(d.name) || d.name.includes(needle),
  );
  if (hit) return [hit.code];
  return [...region.lawdCodes];
}

function regionNameKey(name: string): string {
  return normalizeName(name.replace(/(특별시|광역시|특별자치시|시|군|구)$/g, ""));
}

/** 검색어에 지역명이 보이면 해당 지역 LAWD를 추가로 조회 */
function hintedLawdCodes(queryNorm: string): string[] {
  if (queryNorm.length < 2) return [];
  const codes = new Set<string>();
  for (const region of ALL_REGIONS) {
    const keys = [
      regionNameKey(region.name),
      ...region.districts.map((d) => regionNameKey(d.name)),
    ].filter((k) => k.length >= 2);
    if (keys.some((k) => queryNorm.includes(k) || k.includes(queryNorm))) {
      for (const code of region.lawdCodes) codes.add(code);
    }
  }
  return [...codes];
}

function isSubsequence(query: string, target: string): boolean {
  let i = 0;
  for (const ch of target) {
    if (ch === query[i]) i += 1;
    if (i >= query.length) return true;
  }
  return false;
}

/** 공백 제거 후 연속 포함 + (긴 검색어) 부분 누락 허용 매칭 */
function matchScore(query: string, aptKey: string): number {
  if (!query) return 0;
  if (aptKey === query) return 10_000;
  if (aptKey.startsWith(query)) return 5_000 + query.length;
  if (aptKey.includes(query)) return 3_000 + query.length;
  // "안양한양수자인" ↔ "안양역한양수자인리버파크" 처럼 중간 글자 누락
  if (query.length >= 4 && isSubsequence(query, aptKey)) {
    return 1_000 + query.length;
  }
  return 0;
}

function cacheKey(lawdCodes: string[], months: string[]): string {
  return `${[...lawdCodes].sort().join(",")}|${months.join(",")}`;
}

async function loadTradePool(
  lawdCodes: string[],
  monthCount: number,
): Promise<Transaction[]> {
  if (lawdCodes.length === 0) return [];
  const months = recentYearMonths(monthCount);
  const key = cacheKey(lawdCodes, months);
  const cached = suggestPoolCache.get(key);
  if (cached && Date.now() - cached.builtAt < SUGGEST_CACHE_TTL_MS) {
    return cached.items;
  }

  const inflight = suggestPoolInflight.get(key);
  if (inflight) return inflight;

  const promise = (async () => {
    const fromDb = hasDb()
      ? await queryTradePool({ lawdCodes, yearMonths: months })
      : null;
    if (fromDb) {
      suggestPoolCache.set(key, { builtAt: Date.now(), items: fromDb });
      return fromDb;
    }

    const items: Transaction[] = [];
    if (hasApiKey()) {
      // 2개월씩 묶어서 조회 (429 완화 + 초기 지연 단축)
      for (let i = 0; i < months.length; i += 2) {
        const batch = months.slice(i, i + 2);
        const settled = await Promise.allSettled(
          batch.map((ym) => fetchTransactionsByType(ym, "trade", lawdCodes)),
        );
        for (const result of settled) {
          if (result.status === "fulfilled") items.push(...result.value);
          else console.warn("[apt-suggest] month fetch failed:", result.reason);
        }
      }
    } else {
      // 키 없을 때: 지역별 데모로 최소한의 자동완성 유지
      const regions = ALL_REGIONS.filter((r) =>
        r.lawdCodes.some((code) => lawdCodes.includes(code)),
      );
      for (const region of regions) {
        for (const ym of months.slice(0, 2)) {
          items.push(
            ...buildRegionDemoTransactions(region, ym).filter(
              (tx) => tx.dealType === "trade",
            ),
          );
        }
      }
    }
    suggestPoolCache.set(key, { builtAt: Date.now(), items });
    return items;
  })().finally(() => {
    suggestPoolInflight.delete(key);
  });

  suggestPoolInflight.set(key, promise);
  return promise;
}

async function loadSuggestPool(queryNorm: string): Promise<Transaction[]> {
  const baseCodes = expandFeaturedLawdCodes();
  const hinted = hintedLawdCodes(queryNorm);
  const extra = hinted.filter((code) => !baseCodes.includes(code));

  const [baseItems, hintItems] = await Promise.all([
    loadTradePool(baseCodes, SUGGEST_MONTHS),
    extra.length > 0 ? loadTradePool(extra, SUGGEST_MONTHS) : Promise.resolve([]),
  ]);

  if (extra.length === 0) return baseItems;
  return [...baseItems, ...hintItems];
}

function aggregateSuggestions(
  pool: Transaction[],
  queryNorm: string,
  limit: number,
): AptSuggestion[] {
  const grouped = new Map<string, SuggestAgg & { score: number; regionSlug: string }>();

  for (const tx of pool) {
    if (tx.dealType !== "trade") continue;
    const aptKey = normalizeName(tx.aptName);
    const score = matchScore(queryNorm, aptKey);
    if (score <= 0) continue;

    const region =
      regionFromGu(tx.gu) ??
      // gu 매핑 실패 시 단지명에 시·구명이 들어있는 경우 대비
      ALL_REGIONS.find((r) => aptKey.includes(regionNameKey(r.name)));
    if (!region) continue;

    const key = `${aptKey}|${region.slug}`;
    const prev = grouped.get(key);
    if (!prev) {
      grouped.set(key, {
        aptName: tx.aptName,
        gu: tx.gu,
        dong: tx.dong,
        dealCount: 1,
        maxDealAmount: tx.dealAmount,
        latestDealDate: tx.dealDate,
        score,
        regionSlug: region.slug,
      });
      continue;
    }
    prev.dealCount += 1;
    prev.maxDealAmount = Math.max(prev.maxDealAmount, tx.dealAmount);
    prev.score = Math.max(prev.score, score);
    if (tx.dealDate > prev.latestDealDate) {
      prev.latestDealDate = tx.dealDate;
      prev.dong = tx.dong;
      prev.gu = tx.gu;
      prev.aptName = tx.aptName;
    }
  }

  return [...grouped.values()]
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.dealCount !== a.dealCount) return b.dealCount - a.dealCount;
      return b.maxDealAmount - a.maxDealAmount;
    })
    .slice(0, limit)
    .map((value) => {
      const region = getRegion(value.regionSlug)!;
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
    });
}

/** 단지명 자동완성 */
export async function searchAptSuggestions(
  query: string,
  limit = 8,
): Promise<AptSuggestion[]> {
  const q = normalizeName(query.trim());
  if (q.length < 1) return [];

  // 1) DB LIKE 집계 — 적재된 전체 기간에서 즉시 검색
  if (hasDb() && q.length >= 2) {
    const hits = await searchAptAggregatesFromDb({ queryNorm: q, limit: limit * 2 });
    if (hits && hits.length > 0) {
      const mapped: AptSuggestion[] = [];
      for (const hit of hits) {
        const region =
          regionFromGu(hit.gu) ??
          ALL_REGIONS.find((r) =>
            normalizeName(hit.aptName).includes(regionNameKey(r.name)),
          );
        if (!region) continue;
        mapped.push({
          aptName: hit.aptName,
          regionSlug: region.slug,
          regionName: region.name,
          gu: hit.gu,
          dong: hit.dong,
          dealCount: hit.dealCount,
          maxDealAmount: hit.maxDealAmount,
          latestDealDate: hit.latestDealDate,
        });
        if (mapped.length >= limit) break;
      }
      if (mapped.length > 0) return mapped;
    }
  }

  // 2) 풀 로드(부분 DB → MOLIT) 후 부분일치·subsequence 매칭
  const pool = await loadSuggestPool(q);
  let suggestions = aggregateSuggestions(pool, q, limit);

  // 주요·힌트 지역에 없으면 전체 시군구 최근 1개월로 보강
  if (suggestions.length === 0 && q.length >= 4) {
    const allCodes = [
      ...new Set(ALL_REGIONS.flatMap((r) => r.lawdCodes)),
    ];
    const widePool = await loadTradePool(allCodes, 1);
    suggestions = aggregateSuggestions([...pool, ...widePool], q, limit);
  }

  return suggestions;
}

function yearMonthFromDealDate(dealDate: string): string {
  return `${dealDate.slice(0, 4)}${dealDate.slice(5, 7)}`;
}

function chartLabel(ym: string): string {
  return `${ym.slice(2, 4)}.${ym.slice(4, 6)}`;
}

function buildChartPoints(
  items: Transaction[],
  months: string[],
): AptChartPoint[] {
  const byMonth = new Map<
    string,
    {
      tradeSums: number[];
      jeonseSums: number[];
      wolseCount: number;
    }
  >();

  for (const ym of months) {
    byMonth.set(ym, { tradeSums: [], jeonseSums: [], wolseCount: 0 });
  }

  for (const tx of items) {
    const ym = yearMonthFromDealDate(tx.dealDate);
    let bucket = byMonth.get(ym);
    if (!bucket) {
      bucket = { tradeSums: [], jeonseSums: [], wolseCount: 0 };
      byMonth.set(ym, bucket);
    }
    if (tx.dealType === "trade") {
      bucket.tradeSums.push(tx.dealAmount);
    } else if (tx.monthlyRent > 0) {
      bucket.wolseCount += 1;
    } else {
      bucket.jeonseSums.push(tx.dealAmount);
    }
  }

  const ordered = [...byMonth.keys()].sort();
  return ordered.map((ym) => {
    const bucket = byMonth.get(ym)!;
    const tradeCount = bucket.tradeSums.length;
    const jeonseCount = bucket.jeonseSums.length;
    const tradeAvg =
      tradeCount > 0
        ? Math.round(
            bucket.tradeSums.reduce((a, b) => a + b, 0) / tradeCount,
          )
        : null;
    const tradeMax =
      tradeCount > 0 ? Math.max(...bucket.tradeSums) : null;
    const jeonseAvg =
      jeonseCount > 0
        ? Math.round(
            bucket.jeonseSums.reduce((a, b) => a + b, 0) / jeonseCount,
          )
        : null;
    return {
      yearMonth: ym,
      label: chartLabel(ym),
      tradeAvg,
      tradeMax,
      tradeCount,
      jeonseAvg,
      jeonseCount,
      wolseCount: bucket.wolseCount,
      volume: tradeCount + jeonseCount + bucket.wolseCount,
    };
  });
}

async function fetchAptHistoryPool(
  months: string[],
  lawdCodes: string[],
  options?: { includeRent?: boolean },
): Promise<Transaction[]> {
  const includeRent = options?.includeRent ?? true;
  // 최근 48개월만 전월세 포함 (전체 기간은 매매로 차트·이력 확보)
  const recentSet = new Set(months.slice(0, 48));
  const jobs = months.map((ym) => ({
    ym,
    dealType: (includeRent && recentSet.has(ym) ? "all" : "trade") as
      | "all"
      | "trade",
  }));

  const items: Transaction[] = [];
  // 매매만이면 병렬을 더 열고, 배치 대기 대신 워커 풀로 유휴 시간을 줄임
  const concurrency = includeRent ? 6 : 12;
  let next = 0;

  async function worker() {
    while (next < jobs.length) {
      const index = next;
      next += 1;
      const job = jobs[index];
      try {
        const txs = await fetchTransactionsByType(
          job.ym,
          job.dealType,
          lawdCodes,
        );
        items.push(...txs);
      } catch (reason) {
        console.warn("[apt-detail] month fetch failed:", job.ym, reason);
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, Math.max(jobs.length, 1)) },
      () => worker(),
    ),
  );
  return items;
}

function trimChartToActivity(points: AptChartPoint[]): AptChartPoint[] {
  if (points.length === 0) return points;
  const first = points.findIndex((p) => p.volume > 0);
  if (first < 0) return points;
  let last = points.length - 1;
  while (last > first && points[last].volume === 0) last -= 1;
  return points.slice(first, last + 1);
}

const DETAIL_CACHE_TTL_MS = 60 * 60 * 1000;
const detailCache = new Map<
  string,
  { builtAt: number; data: AptDetailResponse }
>();
const detailInflight = new Map<string, Promise<AptDetailResponse | null>>();

function detailCacheKey(
  regionSlug: string,
  aptName: string,
  monthCount: number,
  lawdScope: string,
): string {
  return `v2|${regionSlug}|${normalizeName(aptName)}|${monthCount}|${lawdScope}`;
}

/** 단지 실거래 이력 (매매·전월세 + 시세 차트용 월별 집계) */
export async function getAptDetail(params: {
  aptName: string;
  regionSlug: string;
  months?: number;
  gu?: string;
}): Promise<AptDetailResponse | null> {
  const region = getRegion(params.regionSlug);
  if (!region) return null;

  const aptName = params.aptName.trim();
  if (!aptName) return null;

  const monthCount = Math.min(Math.max(params.months ?? 120, 6), 120);
  const lawdCodes = resolveDetailLawdCodes(region, params.gu);
  const lawdScope = lawdCodes.slice().sort().join(",");
  const cacheKey = detailCacheKey(region.slug, aptName, monthCount, lawdScope);
  const cached = detailCache.get(cacheKey);
  if (cached && Date.now() - cached.builtAt < DETAIL_CACHE_TTL_MS) {
    return cached.data;
  }

  const inflight = detailInflight.get(cacheKey);
  if (inflight) return inflight;

  const promise = buildAptDetail({
    region,
    aptName,
    monthCount,
    lawdCodes,
  }).then((data) => {
    if (data) {
      detailCache.set(cacheKey, { builtAt: Date.now(), data });
    }
    return data;
  }).finally(() => {
    detailInflight.delete(cacheKey);
  });

  detailInflight.set(cacheKey, promise);
  return promise;
}

async function buildAptDetail(params: {
  region: RegionDef;
  aptName: string;
  monthCount: number;
  lawdCodes: string[];
}): Promise<AptDetailResponse | null> {
  const { region, aptName, monthCount, lawdCodes } = params;
  const months = recentYearMonths(monthCount);
  let source: "api" | "mock" | "db" = "mock";
  let warning: string | undefined;
  let collected: Transaction[] = [];
  const timing: Record<string, number> = {};
  const mark = (key: string, started: number) => {
    timing[key] = Math.round(performance.now() - started);
  };

  // DB가 있으면 사용자 경로에서는 항상 DB만 사용 (coverage 미완이어도 MOLIT 실시간 호출 금지).
  // 매매+전월세를 함께 읽어 quick(36m)에서도 전월세 KPI가 비지 않게 한다.
  if (hasDb()) {
    const tDb = performance.now();
    collected = await queryAptTransactions({
      lawdCodes,
      aptName,
      yearMonths: months,
      dealKinds: ["trade", "rent"],
    });
    mark("dbQueryMs", tDb);
    source = "db";
    if (collected.length === 0) {
      warning = "선택한 단지·기간에 실거래 데이터가 없습니다.";
    }
  } else if (hasApiKey()) {
    // DB 미설정 환경(로컬 데모)만 API. 운영(hasDb)에서는 도달하지 않음.
    const includeRent = monthCount > 36;
    const tApi = performance.now();
    collected = await fetchAptHistoryPool(months, lawdCodes, {
      includeRent,
    });
    mark("apiPoolMs", tApi);
    if (collected.length > 0) source = "api";
    else warning = "선택한 단지·기간에 API 실거래 데이터가 없습니다.";
  } else {
    warning =
      "MOLIT_API_KEY가 없어 지역별 데모 데이터로 표시 중입니다. Vercel/로컬 환경변수에 키를 설정하세요.";
    for (const ym of months.slice(0, Math.min(12, months.length))) {
      collected.push(...buildRegionDemoTransactions(region, ym));
    }
  }

  const tProc = performance.now();
  const yearMonth = months[0];
  const aptKey = normalizeName(aptName);
  const matched = collected
    .filter((tx) => normalizeName(tx.aptName).includes(aptKey))
    .sort((a, b) => {
      if (a.dealDate === b.dealDate) return b.dealAmount - a.dealAmount;
      return a.dealDate < b.dealDate ? 1 : -1;
    });

  const exact = matched.filter((tx) => normalizeName(tx.aptName) === aptKey);
  const deals = exact.length > 0 ? exact : matched;
  const trades = deals.filter((tx) => tx.dealType === "trade");
  const rents = deals.filter((tx) => tx.dealType === "rent");
  const partial = monthCount < 120;

  const emptyResponse = (
    extraWarning?: string,
  ): AptDetailResponse => ({
    aptName,
    regionSlug: region.slug,
    regionName: region.name,
    fullName: region.fullName,
    gu: region.districts[0]?.name ?? region.name,
    dong: "",
    buildYear: null,
    source,
    yearMonth,
    warning: extraWarning ?? warning ?? "해당 단지의 실거래를 찾지 못했습니다.",
    partial,
    loadedMonths: monthCount,
    stats: {
      recent3mCount: 0,
      maxDealAmount: 0,
      avgDealAmount: 0,
      totalTradeCount: 0,
      totalRentCount: 0,
    },
    areas: [],
    chart: trimChartToActivity(buildChartPoints([], months)),
    items: [],
  });

  if (deals.length === 0) {
    return emptyResponse();
  }

  const canonicalName = deals[0].aptName;
  const since = threeMonthsAgoDate();
  const recent3m = trades.filter((t) => t.dealDate >= since);
  const maxDealAmount =
    trades.length > 0 ? Math.max(...trades.map((t) => t.dealAmount)) : 0;
  const avgDealAmount =
    trades.length > 0
      ? Math.round(
          trades.reduce((s, t) => s + t.dealAmount, 0) / trades.length,
        )
      : 0;

  const maxByArea = new Map<string, number>();
  for (const tx of trades) {
    const key = areaKey(tx.exclusiveArea);
    maxByArea.set(key, Math.max(maxByArea.get(key) ?? 0, tx.dealAmount));
  }

  const areaCount = new Map<string, { sqm: number; count: number }>();
  for (const tx of deals) {
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

  const buildYears = deals
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

  const items: AptHistoryItem[] = deals.map((tx) => ({
    ...tx,
    pyeong: toPyeong(tx.exclusiveArea),
    isSingoga:
      tx.dealType === "trade" &&
      tx.dealAmount === (maxByArea.get(areaKey(tx.exclusiveArea)) ?? -1),
  }));

  const chart = trimChartToActivity(
    buildChartPoints(deals, months).sort((a, b) =>
      a.yearMonth < b.yearMonth ? -1 : 1,
    ),
  );
  mark("processMs", tProc);

  if (process.env.APT_DETAIL_TIMING === "1") {
    console.info("[apt-detail:timing]", {
      aptName,
      monthCount,
      source,
      items: deals.length,
      ...timing,
    });
  }

  return {
    aptName: canonicalName,
    regionSlug: region.slug,
    regionName: region.name,
    fullName: region.fullName,
    gu: deals[0].gu,
    dong: deals[0].dong,
    buildYear,
    source,
    yearMonth,
    warning,
    partial,
    loadedMonths: monthCount,
    stats: {
      recent3mCount: recent3m.length,
      maxDealAmount,
      avgDealAmount,
      totalTradeCount: trades.length,
      totalRentCount: rents.length,
    },
    areas,
    chart,
    items,
  };
}

export function aptDetailHref(
  aptName: string,
  regionSlug: string,
  gu?: string,
  areaKey?: string,
): string {
  const qs = new URLSearchParams({ region: regionSlug });
  if (gu?.trim()) qs.set("gu", gu.trim());
  if (areaKey?.trim() && areaKey.trim() !== "all") {
    qs.set("area", areaKey.trim());
  }
  return `/apt/${encodeURIComponent(aptName)}?${qs.toString()}`;
}

export function formatAptPriceLabel(manwon: number): string {
  return formatEok(manwon);
}

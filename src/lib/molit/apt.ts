import {
  FEATURED_LAWD_CODES,
  ALL_REGIONS,
  getRegion,
  LAWD_TO_REGION,
  LEGACY_REGION_SLUGS,
  type RegionDef,
} from "@/lib/constants/regions";
import { fetchTransactionsByType, hasApiKey } from "@/lib/molit/client";
import {
  getDb,
  hasDb,
} from "@/lib/db/client";
import {
  queryAptTransactions,
  queryTradePool,
  searchAptAggregatesFromDb,
  splitAptByLawd,
} from "@/lib/db/repository";
import {
  recentYearMonths,
  toPyeong,
} from "@/lib/utils/format";
import type { Transaction } from "@/types/transaction";
import { buildRegionDemoTransactions } from "@/lib/mock/region-demo";

import type {
  AptSuggestion,
  AptAreaOption,
  AptHistoryItem,
  AptChartPoint,
  AptDetailResponse,
} from "@/lib/molit/apt-client";
export type {
  AptSuggestion,
  AptAreaOption,
  AptHistoryItem,
  AptChartPoint,
  AptDetailResponse,
} from "@/lib/molit/apt-client";
export { aptDetailHref, formatAptPriceLabel } from "@/lib/molit/apt-client";

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

/**
 * 거래 구명(gu: "중구", "수성구", "천안시 서북구") 과 이름이 정확히 같은 구의 법정동코드들.
 * 중구·동구·서구·남구·북구·강서구·고성군처럼 여러 시·도에 같은 이름이 있으면 여러 개다.
 * (부분 포함으로 찾으면 "천안시 서북구"→부산 북구, "남동구"→부산 동구로 잘못 붙는다)
 */
function lawdCodesForGu(gu: string): string[] {
  const g = gu.replace(/\s+/g, " ").trim();
  if (!g) return [];
  const codes = new Set<string>();
  for (const r of ALL_REGIONS) {
    for (const d of r.districts) {
      if (d.name === g || r.name === g || `${r.name} ${d.name}` === g) codes.add(d.code);
    }
  }
  return [...codes];
}

/** 구명만으로 지역이 하나로 정해질 때만 돌려준다 — 같은 이름 구가 여러 시·도에 있으면 undefined */
function regionFromGu(gu: string): RegionDef | undefined {
  const regions = new Set(
    lawdCodesForGu(gu)
      .map((code) => LAWD_TO_REGION[code])
      .filter((r): r is RegionDef => Boolean(r)),
  );
  return regions.size === 1 ? [...regions][0] : undefined;
}

/** 거래 한 건의 지역 — 법정동코드가 있으면 그것으로, 없으면 구명이 하나로 정해질 때만 */
function regionForTx(tx: Pick<Transaction, "lawdCd" | "gu">): RegionDef | undefined {
  return (tx.lawdCd ? LAWD_TO_REGION[tx.lawdCd] : undefined) ?? regionFromGu(tx.gu);
}

/**
 * 구명(gu)이 빈 채로 적재된 거래의 법정동코드 — 레지스트리에 코드가 들어오기 전에 적재돼 구명을 못 붙인 곳.
 * 코드가 바뀐 지역(광주·전남 12, 강원 51, 전북 52 — slug 는 옛 코드)과 인천 분할 신설 구.
 * (2026-09 확인: 전국 코드별 표본에서 빈 구명은 이 64개 코드 중 63개에서만 나왔다 — 나머지 1개는 표본 거래 없음)
 */
const EMPTY_GU_LAWD_CODES: string[] = (() => {
  const codes = new Set<string>();
  for (const r of ALL_REGIONS) {
    const suffix = r.slug.slice(r.slug.lastIndexOf("-") + 1);
    if (!/^\d{5}$/.test(suffix)) continue;
    for (const code of r.lawdCodes) if (code !== suffix) codes.add(code);
  }
  for (const targets of Object.values(LEGACY_REGION_SLUGS)) {
    for (const slug of targets) for (const code of getRegion(slug)?.lawdCodes ?? []) codes.add(code);
  }
  return [...codes];
})();

type CatalogHit = NonNullable<Awaited<ReturnType<typeof searchAptAggregatesFromDb>>>[number];

/**
 * 단지명 카탈로그 결과 → 지역이 붙은 추천.
 * 카탈로그는 (단지명, 구명) 으로만 묶여 있어 "대구 동구 태왕메트로시티" 가 부산 동구로 가는 식의
 * 오류가 났다. 구명이 한 지역으로 안 정해지면(같은 이름 구·구명 없음) 거래에서 법정동코드별로
 * 다시 나눠 각 코드의 지역으로 보낸다. 지역을 못 정한 단지는 빼고 틀린 지역으로 보내지 않는다.
 */
async function suggestionsFromCatalogHits(
  hits: CatalogHit[],
  limit: number,
): Promise<AptSuggestion[]> {
  const resolveHit = async (hit: CatalogHit): Promise<AptSuggestion[]> => {
    const region = regionFromGu(hit.gu);
    if (region) {
      return [
        {
          aptName: hit.aptName,
          regionSlug: region.slug,
          regionName: region.name,
          gu: hit.gu,
          dong: hit.dong,
          dealCount: hit.dealCount,
          maxDealAmount: hit.maxDealAmount,
          latestDealDate: hit.latestDealDate,
        },
      ];
    }
    const candidates = lawdCodesForGu(hit.gu);
    const split = await splitAptByLawd({
      aptNameNorm: hit.aptNameNorm,
      gu: hit.gu,
      lawdCodes: hit.gu.trim() ? candidates : EMPTY_GU_LAWD_CODES,
    }).catch((err) => {
      console.warn("[apt-suggest] lawd split failed:", err);
      return null;
    });
    const out: AptSuggestion[] = [];
    for (const row of split ?? []) {
      const r = LAWD_TO_REGION[row.lawdCd];
      if (!r) continue;
      const district = r.districts.find((d) => d.code === row.lawdCd);
      out.push({
        aptName: row.aptName || hit.aptName,
        regionSlug: r.slug,
        regionName: r.name,
        // 구명이 비어 있으면 여러 구 시(전주시 등)에서 상세가 그 구만 보도록 구 이름을 채운다
        gu: hit.gu || (r.districts.length > 1 && district ? `${r.name} ${district.name}` : ""),
        dong: row.dong,
        dealCount: row.dealCount,
        maxDealAmount: row.maxDealAmount,
        latestDealDate: row.latestDealDate,
      });
    }
    return out;
  };

  // 필요한 만큼만 나눠 조회 — 앞쪽 limit개로 다 차면 뒤 후보는 거래를 읽지 않는다
  const out: Array<AptSuggestion & { score: number }> = [];
  for (let i = 0; i < hits.length && out.length < limit; i += limit) {
    const batch = hits.slice(i, i + limit);
    const resolved = await Promise.all(batch.map(resolveHit));
    resolved.forEach((rows, j) => {
      for (const row of rows) out.push({ ...row, score: batch[j]!.score });
    });
  }
  // 코드별로 나뉜 줄도 카탈로그와 같은 순서(일치 점수 → 거래 수 → 최고가)로 — 한 이름이 목록을 다 차지하지 않게
  out.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.dealCount !== a.dealCount) return b.dealCount - a.dealCount;
    return b.maxDealAmount - a.maxDealAmount;
  });
  return out.slice(0, limit).map((row) => ({
    aptName: row.aptName,
    regionSlug: row.regionSlug,
    regionName: row.regionName,
    gu: row.gu,
    dong: row.dong,
    dealCount: row.dealCount,
    maxDealAmount: row.maxDealAmount,
    latestDealDate: row.latestDealDate,
  }));
}

/** 구명(gu)과 맞는 구의 법정동코드. 못 찾으면 undefined */
export function matchDistrictLawdCode(
  region: RegionDef,
  gu?: string,
): string | undefined {
  const needle = gu?.trim();
  if (!needle) return undefined;
  return region.districts.find(
    (d) => needle === d.name || needle.includes(d.name) || d.name.includes(needle),
  )?.code;
}

/** 구명이 있으면 해당 법정동코드만, 없으면 지역 전체 */
function resolveDetailLawdCodes(region: RegionDef, gu?: string): string[] {
  const hit = matchDistrictLawdCode(region, gu);
  if (hit) return [hit];
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
    if (hasDb()) {
      const items = fromDb ?? [];
      suggestPoolCache.set(key, { builtAt: Date.now(), items });
      return items;
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

    // 단지명에 든 글자("동아"의 "동")로 지역을 짐작하지 않는다 — 틀린 지역으로 보내느니 뺀다
    const region = regionForTx(tx);
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

  // 0) "잠실동 엘스"·"잠실 엘스"처럼 동·구 + 단지명 — 첫 단어를 동·구 이름 앞부분으로 보고 그 안에서 단지명 검색
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (hasDb() && words.length >= 2) {
    const loc = words[0]!;
    const rest = normalizeName(words.slice(1).join(""));
    if (loc.length >= 2 && rest.length >= 1) {
      const hits = await searchAptAggregatesFromDb({ queryNorm: rest, limit: limit * 2, locations: [loc] });
      const mapped = await suggestionsFromCatalogHits(hits ?? [], limit);
      if (mapped.length > 0) return mapped;
    }
  }

  // 1) DB LIKE 집계 — 적재된 전체 기간에서 즉시 검색
  if (hasDb() && q.length >= 2) {
    const hits = await searchAptAggregatesFromDb({ queryNorm: q, limit: limit * 2 });
    if (hits && hits.length > 0) {
      const mapped = await suggestionsFromCatalogHits(hits, limit);
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

function yearMonthsInclusive(fromYm: string, toYm: string): string[] {
  if (fromYm.length !== 6 || toYm.length !== 6 || fromYm > toYm) return [];
  const out: string[] = [];
  let y = Number(fromYm.slice(0, 4));
  let m = Number(fromYm.slice(4, 6));
  const ty = Number(toYm.slice(0, 4));
  const tm = Number(toYm.slice(4, 6));
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
    if (out.length > 240) break;
  }
  return out;
}

function chartMonthsFromDeals(
  items: Transaction[],
  fallbackMonths: string[],
): string[] {
  let minYm = "";
  let maxYm = "";
  for (const tx of items) {
    const ym = yearMonthFromDealDate(tx.dealDate);
    if (ym.length !== 6) continue;
    if (!minYm || ym < minYm) minYm = ym;
    if (!maxYm || ym > maxYm) maxYm = ym;
  }
  if (!minYm || !maxYm) return fallbackMonths;
  return yearMonthsInclusive(minYm, maxYm);
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
  boundMonths: boolean,
): string {
  return `v2|${regionSlug}|${normalizeName(aptName)}|${monthCount}|${lawdScope}|bound=${boundMonths ? 1 : 0}`;
}

/** 단지 실거래 이력 (매매·전월세 + 시세 차트용 월별 집계) */
export async function getAptDetail(params: {
  aptName: string;
  regionSlug: string;
  months?: number;
  gu?: string;
  /**
   * When true, DB/API reads are clipped to `months` (transaction archive).
   * Default false: DB returns full warehouse history for Complex Detail
   * (full-history serving invariant; months still sizes non-DB/API windows).
   */
  boundMonths?: boolean;
}): Promise<AptDetailResponse | null> {
  const region = getRegion(params.regionSlug);
  if (!region) return null;

  const aptName = params.aptName.trim();
  if (!aptName) return null;

  const boundMonths = params.boundMonths === true;
  // DB + unbounded = 전체 이력이라 months와 무관하게 결과가 같음 → 120으로 고정해
  // 캐시 키 하나로 묶기 (months=36/120 요청이 같은 4~5MB를 DB에서 두 번 만들던 문제).
  const monthCount =
    hasDb() && !boundMonths
      ? 120
      : Math.min(Math.max(params.months ?? 120, 6), 120);
  const lawdCodes = resolveDetailLawdCodes(region, params.gu);
  const lawdScope = lawdCodes.slice().sort().join(",");
  const cacheKey = detailCacheKey(
    region.slug,
    aptName,
    monthCount,
    lawdScope,
    boundMonths,
  );
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
    boundMonths,
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
  boundMonths: boolean;
}): Promise<AptDetailResponse | null> {
  const { region, aptName, monthCount, lawdCodes, boundMonths } = params;
  const months = recentYearMonths(monthCount);
  let source: "api" | "mock" | "db" = "mock";
  let warning: string | undefined;
  let collected: Transaction[] = [];
  const timing: Record<string, number> = {};
  const mark = (key: string, started: number) => {
    timing[key] = Math.round(performance.now() - started);
  };

  // DB가 있으면 사용자 경로에서는 항상 DB만 사용 (coverage 미완이어도 MOLIT 실시간 호출 금지).
  // Default: full warehouse history (Complex Detail / full-history serving).
  // boundMonths=true: clip to monthCount window (transaction archive periods).
  if (hasDb()) {
    const tDb = performance.now();
    collected = await queryAptTransactions({
      lawdCodes,
      aptName,
      yearMonths: boundMonths ? months : [],
      dealKinds: ["trade", "rent"],
    });
    mark("dbQueryMs", tDb);
    source = "db";
    if (collected.length === 0) {
      warning = "선택한 단지에 실거래 데이터가 없습니다.";
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
    else warning = "선택한 단지·기간에 확인된 실거래 데이터가 없습니다.";
  } else {
    warning =
      "실거래 데이터 연동이 없어 지역별 데모 데이터로 표시 중입니다.";
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
  const chartMonths =
    source === "db" ? chartMonthsFromDeals(deals, months) : months;
  // Unbounded DB = full warehouse (partial false). Bound mode reports window size.
  const loadedMonths =
    source === "db" && !boundMonths
      ? chartMonths.length
      : monthCount;
  const partial =
    source === "db" && !boundMonths ? false : monthCount < 120;

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
    loadedMonths,
    stats: {
      recent3mCount: 0,
      maxDealAmount: 0,
      avgDealAmount: 0,
      totalTradeCount: 0,
      totalRentCount: 0,
    },
    areas: [],
    chart: trimChartToActivity(buildChartPoints([], chartMonths)),
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

  const {
    applyPilotSingoga,
    attachCanonicalPyeongLabelSource,
    buildMarketGroupAreas,
    loadPilotMasterForApt,
    pilotMetaFromBundle,
  } = await import("@/lib/unit-type/apply-pilot");
  const pilotBundle = await loadPilotMasterForApt(canonicalName);
  const pilotMeta = pilotMetaFromBundle(pilotBundle);
  const useMarketGroups = pilotMeta?.selectorMode === "market_group";

  const areaCount = new Map<string, { sqm: number; count: number }>();
  for (const tx of deals) {
    const key = areaKey(tx.exclusiveArea);
    const prev = areaCount.get(key);
    if (!prev) areaCount.set(key, { sqm: tx.exclusiveArea, count: 1 });
    else prev.count += 1;
  }

  const exclusiveAreas: AptAreaOption[] = [...areaCount.entries()]
    .map(([key, value]) =>
      attachCanonicalPyeongLabelSource(
        {
          key,
          exclusiveArea: value.sqm,
          count: value.count,
          label: areaLabel(value.sqm),
          selectorKind: "exclusive" as const,
        },
        pilotBundle,
      ),
    )
    .sort((a, b) => a.exclusiveArea - b.exclusiveArea);

  const areas: AptAreaOption[] =
    useMarketGroups && pilotBundle
      ? buildMarketGroupAreas(pilotBundle, deals)
      : (await import("@/lib/apt/area-groups")).groupAreaOptions(exclusiveAreas);

  // 최빈 준공연도 — 한 번 훑어 세기 (거래 1.6만 건 단지에서 filter-in-sort는 수 초).
  // 동률이면 deals 순서(최근 거래)에서 먼저 나온 연도 = 기존 안정 정렬 결과와 동일.
  const buildYearCount = new Map<number, number>();
  for (const tx of deals) {
    const y = tx.buildYear;
    if (typeof y !== "number" || y <= 1900) continue;
    buildYearCount.set(y, (buildYearCount.get(y) ?? 0) + 1);
  }
  let buildYear: number | null = null;
  let buildYearTop = 0;
  for (const [y, count] of buildYearCount) {
    if (count > buildYearTop) {
      buildYear = y;
      buildYearTop = count;
    }
  }

  let baselinePriorMax: Map<string, number> | undefined;
  if (useMarketGroups && pilotBundle) {
    const { isMarketGroupBaselineSingogaEnabled } = await import(
      "@/lib/unit-type/baseline-gate"
    );
    if (isMarketGroupBaselineSingogaEnabled()) {
      const { loadBaselinePriorMaxByComplex } = await import(
        "@/lib/unit-type/baselines"
      );
      const db = getDb();
      if (db) {
        baselinePriorMax = await loadBaselinePriorMaxByComplex(
          db,
          pilotBundle.classification.complexKey,
        );
      }
    }
  }

  const singogaFlags = applyPilotSingoga({
    bundle: pilotBundle,
    deals: deals.map((tx) => ({
      id: tx.id,
      dealType: tx.dealType,
      dealDate: tx.dealDate,
      dealAmount: tx.dealAmount,
      exclusiveArea: tx.exclusiveArea,
    })),
    baselinePriorMax,
  });

  const items: AptHistoryItem[] = deals.map((tx) => ({
    ...tx,
    pyeong: toPyeong(tx.exclusiveArea),
    isSingoga:
      tx.dealType === "trade" && (singogaFlags.get(tx.id) ?? false),
  }));
  const chart = trimChartToActivity(
    buildChartPoints(deals, chartMonths).sort((a, b) =>
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
    loadedMonths,
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
    unitTypePilot: pilotMeta,
  };
}


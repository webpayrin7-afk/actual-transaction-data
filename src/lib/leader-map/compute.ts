import { SEOUL_REGIONS } from "@/lib/constants/regions";
import { getDb, hasDb } from "@/lib/db/client";
import { seoulToday } from "@/lib/market/time";
import { aptDetailHref } from "@/lib/molit/apt";
import {
  buildComplexStats,
  complexKeyOf,
  pickLeader,
  rankEligible,
  SAMPLE_GOOD_MIN,
  windowFromTo,
  yearMonthsInclusive,
  type ComplexLeaderStats,
  type LeaderTrade,
} from "@/lib/leader-map/metrics";
import type {
  DongLeaderRow,
  GuLeaderRow,
  LeaderComplex,
  LeaderMapResponse,
} from "@/lib/leader-map/types";

const READ_CACHE_TTL_MS = 30 * 60 * 1000;

let readCache: { expiresAt: number; key: string; data: LeaderMapResponse } | null =
  null;

type RawRow = {
  lawdCd: string;
  gu: string;
  dong: string;
  aptName: string;
  aptNameNorm: string;
  dealDate: string;
  dealAmount: number;
  exclusiveArea: number;
  floor: number;
};

function emptyResponse(warning?: string): LeaderMapResponse {
  const to = seoulToday();
  const { from } = windowFromTo(to);
  return {
    metro: "seoul",
    source: "empty",
    asOfDate: null,
    window: { from, to, months: 12 },
    computedAt: new Date().toISOString(),
    eligibleComplexCount: 0,
    gus: SEOUL_REGIONS.map((r) => ({
      lawdCd: r.lawdCodes[0]!,
      name: r.name,
      slug: r.slug,
      leader: null,
    })),
    dongsByGu: Object.fromEntries(SEOUL_REGIONS.map((r) => [r.name, []])),
    top5: [],
    warning,
  };
}

function toLeaderComplex(stats: ComplexLeaderStats, regionSlug: string): LeaderComplex {
  return {
    complexKey: stats.complexKey,
    lawdCd: stats.lawdCd,
    gu: stats.gu,
    dong: stats.dong,
    aptName: stats.aptName,
    aptNameNorm: stats.aptNameNorm,
    regionSlug,
    href: aptDetailHref(stats.aptName, regionSlug, stats.gu),
    tradeCount12m: stats.tradeCount12m,
    medianPpsqm: stats.medianPpsqm,
    medianPyeongPrice: stats.medianPyeongPrice,
    normalized84Price: stats.normalized84Price,
    latestDeal: stats.latestDeal,
    previousDeal: stats.previousDeal,
    latestChange: stats.latestChange,
    sampleQuality: stats.sampleQuality,
  };
}

export async function getSeoulLeaderMap(): Promise<LeaderMapResponse> {
  const to = seoulToday();
  const cacheKey = `seoul:${to}`;
  if (readCache && readCache.key === cacheKey && readCache.expiresAt > Date.now()) {
    return readCache.data;
  }

  if (!hasDb()) {
    return emptyResponse("실거래 DB가 연결되지 않았습니다.");
  }
  const db = getDb();
  if (!db) return emptyResponse("실거래 DB가 연결되지 않았습니다.");

  const { from } = windowFromTo(to);
  const yearMonths = yearMonthsInclusive(from, to);
  const lawdCodes = SEOUL_REGIONS.map((r) => r.lawdCodes[0]!);
  const lawdPlaceholders = lawdCodes.map(() => "?").join(",");
  const ymPlaceholders = yearMonths.map(() => "?").join(",");

  // Keep predicates on (lawd_cd, year_month, deal_type) so SQLite uses
  // idx_tx_lawd_ym_type instead of scanning every trade in the date range.
  // Exact 12-month deal_date window is applied in JS.
  const result = await db.execute({
    sql: `SELECT lawd_cd, gu, dong, apt_name, apt_name_norm, deal_date,
                 deal_amount, exclusive_area, floor
          FROM transactions
          WHERE deal_type = 'trade'
            AND lawd_cd IN (${lawdPlaceholders})
            AND year_month IN (${ymPlaceholders})
            AND deal_amount > 0
            AND exclusive_area > 0`,
    args: [...lawdCodes, ...yearMonths],
  });

  const rows: RawRow[] = [];
  for (const row of result.rows) {
    const dealDate = String(row.deal_date).slice(0, 10);
    if (dealDate < from || dealDate > to) continue;
    rows.push({
      lawdCd: String(row.lawd_cd),
      gu: String(row.gu ?? ""),
      dong: String(row.dong ?? ""),
      aptName: String(row.apt_name),
      aptNameNorm: String(row.apt_name_norm),
      dealDate,
      dealAmount: Number(row.deal_amount) || 0,
      exclusiveArea: Number(row.exclusive_area) || 0,
      floor: Number(row.floor) || 0,
    });
  }

  const byComplex = new Map<
    string,
    { meta: RawRow; trades: LeaderTrade[] }
  >();
  let maxDealDate = "";
  for (const row of rows) {
    if (row.dealDate > maxDealDate) maxDealDate = row.dealDate;
    const key = complexKeyOf(row.lawdCd, row.dong, row.aptNameNorm);
    const prev = byComplex.get(key);
    const trade: LeaderTrade = {
      dealDate: row.dealDate,
      dealAmount: row.dealAmount,
      exclusiveArea: row.exclusiveArea,
      floor: row.floor,
    };
    if (prev) {
      prev.trades.push(trade);
      if (row.dealDate >= prev.meta.dealDate) prev.meta = row;
    } else {
      byComplex.set(key, { meta: row, trades: [trade] });
    }
  }

  const slugByLawd = Object.fromEntries(
    SEOUL_REGIONS.map((r) => [r.lawdCodes[0]!, r.slug]),
  );
  const nameByLawd = Object.fromEntries(
    SEOUL_REGIONS.map((r) => [r.lawdCodes[0]!, r.name]),
  );

  const complexes: ComplexLeaderStats[] = [];
  for (const { meta, trades } of byComplex.values()) {
    const stats = buildComplexStats({
      complexKey: complexKeyOf(meta.lawdCd, meta.dong, meta.aptNameNorm),
      lawdCd: meta.lawdCd,
      gu: nameByLawd[meta.lawdCd] || meta.gu || "",
      dong: meta.dong,
      aptName: meta.aptName,
      aptNameNorm: meta.aptNameNorm,
      trades,
    });
    if (stats) complexes.push(stats);
  }

  const byGu = new Map<string, ComplexLeaderStats[]>();
  const byGuDong = new Map<string, Map<string, ComplexLeaderStats[]>>();
  for (const c of complexes) {
    const guList = byGu.get(c.lawdCd) ?? [];
    guList.push(c);
    byGu.set(c.lawdCd, guList);
    if (!c.dong) continue;
    const dongMap = byGuDong.get(c.lawdCd) ?? new Map();
    const dongList = dongMap.get(c.dong) ?? [];
    dongList.push(c);
    dongMap.set(c.dong, dongList);
    byGuDong.set(c.lawdCd, dongMap);
  }

  const gus: GuLeaderRow[] = SEOUL_REGIONS.map((region) => {
    const lawdCd = region.lawdCodes[0]!;
    const picked = pickLeader(byGu.get(lawdCd) ?? []);
    return {
      lawdCd,
      name: region.name,
      slug: region.slug,
      leader: picked ? toLeaderComplex(picked, region.slug) : null,
    };
  });

  const dongsByGu: Record<string, DongLeaderRow[]> = {};
  for (const region of SEOUL_REGIONS) {
    const lawdCd = region.lawdCodes[0]!;
    const dongMap = byGuDong.get(lawdCd);
    const rowsForGu: DongLeaderRow[] = [];
    if (dongMap) {
      for (const [dong, list] of dongMap) {
        const picked = pickLeader(list);
        rowsForGu.push({
          dong,
          leader: picked ? toLeaderComplex(picked, region.slug) : null,
        });
      }
      rowsForGu.sort((a, b) => {
        const ap = a.leader?.normalized84Price ?? -1;
        const bp = b.leader?.normalized84Price ?? -1;
        if (ap !== bp) return bp - ap;
        return a.dong.localeCompare(b.dong, "ko");
      });
    }
    dongsByGu[region.name] = rowsForGu;
  }

  const eligible = rankEligible(complexes, SAMPLE_GOOD_MIN);
  const top5 = eligible.slice(0, 5).map((c) => {
    const slug = slugByLawd[c.lawdCd] ?? "seoul-gangnam";
    return toLeaderComplex(c, slug);
  });

  const data: LeaderMapResponse = {
    metro: "seoul",
    source: "db",
    asOfDate: maxDealDate || to,
    window: { from, to, months: 12 },
    computedAt: new Date().toISOString(),
    eligibleComplexCount: eligible.length,
    gus,
    dongsByGu,
    top5,
  };
  readCache = { expiresAt: Date.now() + READ_CACHE_TTL_MS, key: cacheKey, data };
  return data;
}

export function clearLeaderMapCache(): void {
  readCache = null;
}

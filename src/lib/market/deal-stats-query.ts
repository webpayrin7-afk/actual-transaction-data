import "server-only";
import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db/client";
import { normalizeDongName } from "@/lib/region/region-scope";
import {
  DEAL_STATS_TABLE,
  PRICE_BAND_COUNT,
  dealStatsTargetForRegion,
  dongScopeKey,
  lastCompleteVolumeMonth,
  type AreaBand,
  type DealKind,
  type DealStatsPayload,
  type DealStatsPoint,
  type DealStatsScope,
} from "@/lib/market/deal-stats";
import { trendRegionById, type TrendRegion } from "@/lib/market/trends-regions";

const REVALIDATE_SECONDS = 21_600;

const BAND_COLUMNS = Array.from({ length: PRICE_BAND_COUNT }, (_, i) => `band_${i}`);

async function readPoints(
  scope: DealStatsScope,
  scopeKey: string,
  to: string,
): Promise<DealStatsPoint[]> {
  const db = getDb();
  if (!db) return [];
  const res = await db.execute({
    sql: `SELECT year_month, deal_kind, area_band, deal_count, median_price, median_ppp,
                 ${BAND_COLUMNS.join(", ")}
          FROM ${DEAL_STATS_TABLE}
          WHERE scope = ? AND scope_key = ? AND year_month <= ?
          ORDER BY year_month`,
    args: [scope, scopeKey, to],
  });
  return res.rows.map((row) => ({
    ym: String(row.year_month),
    kind: String(row.deal_kind) as DealKind,
    area: String(row.area_band) as AreaBand,
    count: Number(row.deal_count) || 0,
    median: row.median_price == null ? null : Number(row.median_price),
    ppp: row.median_ppp == null ? null : Number(row.median_ppp),
    bands: BAND_COLUMNS.map((c) => Number(row[c] ?? 0)),
  }));
}

const cachedPoints = unstable_cache(
  async (scope: DealStatsScope, scopeKey: string, to: string) => readPoints(scope, scopeKey, to),
  ["market-deal-stats-v1"],
  { revalidate: REVALIDATE_SECONDS, tags: ["market-deal-stats"] },
);

function payload(
  scope: DealStatsScope,
  scopeKey: string,
  medianMethod: "pooled" | "single",
  points: DealStatsPoint[],
  note?: string,
): DealStatsPayload {
  const months = points.map((p) => p.ym).sort();
  return {
    status: "ok",
    scope,
    scopeKey,
    medianMethod,
    points,
    from: months[0] ?? null,
    to: months.at(-1) ?? null,
    note,
  };
}

export async function getDealStatsForRegion(region: TrendRegion): Promise<DealStatsPayload> {
  const target = dealStatsTargetForRegion(region);
  const to = lastCompleteVolumeMonth();
  if (!target) {
    return payload("region", region.id, "single", [], region.volumeNote ?? "이 지역은 실거래 시군구와 맞지 않아 집계하지 않습니다.");
  }
  const points = await cachedPoints(target.scope, target.scopeKey, to);
  return payload(target.scope, target.scopeKey, target.medianMethod, points);
}

export async function getDealStatsForDong(lawdCd: string, dong: string): Promise<DealStatsPayload> {
  const name = normalizeDongName(dong);
  const to = lastCompleteVolumeMonth();
  if (!/^\d{5}$/.test(lawdCd) || !name) {
    return payload("dong", "", "single", [], "지역을 확인하지 못했습니다.");
  }
  const key = dongScopeKey(lawdCd, name);
  const points = await cachedPoints("dong", key, to);
  return payload("dong", key, "single", points);
}

export function regionFromDealStatsParam(id: string | null): TrendRegion | null {
  return trendRegionById(id);
}

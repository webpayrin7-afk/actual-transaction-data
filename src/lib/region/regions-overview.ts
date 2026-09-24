/**
 * 지역 조회 첫 페이지 — 시·군·구 타일 숫자.
 * 최근 완결 월의 매매 전용 평당 중위가(market_monthly_deal_stats, lawd 범위)와 전년 같은 달 대비 변화.
 * 여러 구를 묶은 시(성남시 등)는 구별 중위가를 합칠 수 없으니 구별 범위(최저~최고)만 보인다. 읽기 전용.
 */
import type { Client } from "@libsql/client";
import { ALL_REGIONS } from "@/lib/constants/regions";
import { DEAL_STATS_TABLE, lastCompleteVolumeMonth, ymShift } from "@/lib/market/deal-stats";

/** 한 달 거래가 이보다 적으면 중위가를 보이지 않는다 */
const MIN_DEALS = 10;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export type RegionTileStat = {
  /** 평당 중위가 (만원). 여러 구면 null */
  ppp: number | null;
  /** 여러 구: 구별 평당 중위가 최저~최고 (만원) */
  range: [number, number] | null;
  /** 전년 같은 달 대비 (%) — 단일 구, 두 달 모두 MIN_DEALS 이상일 때만 */
  yoyPct: number | null;
  deals: number;
};

export type RegionsOverview = {
  yearMonth: string;
  compareYearMonth: string;
  regions: Record<string, RegionTileStat>;
};

let cache: { at: number; value: RegionsOverview } | null = null;

export async function readRegionsOverview(db: Client): Promise<RegionsOverview> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;
  // 최근 완결 월 중 테이블에 실제로 있는 가장 최근 달
  const latest = await db.execute({
    sql: `SELECT MAX(year_month) AS ym FROM ${DEAL_STATS_TABLE}
          WHERE scope = 'lawd' AND deal_kind = 'trade' AND area_band = 'all' AND year_month <= ?`,
    args: [lastCompleteVolumeMonth()],
  });
  const ym = String(latest.rows[0]?.ym ?? "");
  const prev = ym ? ymShift(ym, -12) : "";
  const res = ym
    ? await db.execute({
        sql: `SELECT scope_key, year_month, deal_count, median_ppp FROM ${DEAL_STATS_TABLE}
              WHERE scope = 'lawd' AND deal_kind = 'trade' AND area_band = 'all' AND year_month IN (?, ?)`,
        args: [ym, prev],
      })
    : { rows: [] };
  const byLawd = new Map<string, { now?: { n: number; ppp: number | null }; prev?: { n: number; ppp: number | null } }>();
  for (const r of res.rows) {
    const k = String(r.scope_key);
    const e = byLawd.get(k) ?? {};
    const v = { n: Number(r.deal_count), ppp: r.median_ppp == null ? null : Number(r.median_ppp) };
    if (String(r.year_month) === ym) e.now = v;
    else e.prev = v;
    byLawd.set(k, e);
  }

  const regions: Record<string, RegionTileStat> = {};
  for (const region of ALL_REGIONS) {
    const codes = region.lawdCodes;
    const deals = codes.reduce((s, c) => s + (byLawd.get(c)?.now?.n ?? 0), 0);
    if (codes.length === 1) {
      const e = byLawd.get(codes[0]!);
      const ok = (x?: { n: number; ppp: number | null }) => x && x.n >= MIN_DEALS && x.ppp != null;
      const ppp = ok(e?.now) ? e!.now!.ppp! : null;
      const yoyPct =
        ppp != null && ok(e?.prev) ? Math.round(((ppp - e!.prev!.ppp!) / e!.prev!.ppp!) * 1000) / 10 : null;
      regions[region.slug] = { ppp, range: null, yoyPct, deals };
    } else {
      const vals = codes
        .map((c) => byLawd.get(c)?.now)
        .filter((x): x is { n: number; ppp: number } => !!x && x.n >= MIN_DEALS && x.ppp != null)
        .map((x) => x.ppp);
      regions[region.slug] = {
        ppp: vals.length === 1 ? vals[0]! : null,
        range: vals.length > 1 ? [Math.min(...vals), Math.max(...vals)] : null,
        yoyPct: null,
        deals,
      };
    }
  }
  const value = { yearMonth: ym, compareYearMonth: prev, regions };
  cache = { at: Date.now(), value };
  return value;
}

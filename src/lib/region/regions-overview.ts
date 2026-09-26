/**
 * 지역 조회 첫 페이지 — 시·군·구 타일 숫자.
 * 지역 상세와 같은 '지역 시세 평당가'(region_price_index, 공급평 · 단지 최근 거래 세대수 가중)의
 * 최신 월 값과 전년 같은 달 대비 변화.
 * 여러 구를 묶은 시(성남시 등)는 구별 값의 범위(최저~최고)만 보인다. 적재본이 없는 지역은 값 없이 보낸다. 읽기 전용.
 */
import type { Client } from "@libsql/client";
import { ALL_REGIONS } from "@/lib/constants/regions";
import { ymShift } from "@/lib/market/deal-stats";
import { REGION_PRICE_INDEX_METHOD, REGION_PRICE_INDEX_TABLE } from "@/lib/region/region-price-index";

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export type RegionTileStat = {
  /** 지역 시세 평당가 (만원/공급평). 여러 구면 null */
  ppp: number | null;
  /** 여러 구: 구별 시세 평당가 최저~최고 (만원) */
  range: [number, number] | null;
  /** 전년 같은 달 대비 (%) — 단일 구, 두 달 모두 값이 있을 때만 */
  yoyPct: number | null;
  /** 그 달 매매 건수 */
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
  const latest = await db
    .execute({
      sql: `SELECT MAX(year_month) AS ym FROM ${REGION_PRICE_INDEX_TABLE}
            WHERE method_version = ? AND scope = 'gu' AND pyeong_price IS NOT NULL`,
      args: [REGION_PRICE_INDEX_METHOD],
    })
    .catch(() => null);
  const ym = String(latest?.rows[0]?.ym ?? "");
  const prev = ym ? ymShift(ym, -12) : "";
  const res = ym
    ? await db.execute({
        sql: `SELECT region_code, year_month, pyeong_price, trade_count FROM ${REGION_PRICE_INDEX_TABLE}
              WHERE method_version = ? AND scope = 'gu' AND year_month IN (?, ?)`,
        args: [REGION_PRICE_INDEX_METHOD, ym, prev],
      })
    : { rows: [] };
  type V = { ppp: number | null; n: number };
  const byLawd = new Map<string, { now?: V; prev?: V }>();
  for (const r of res.rows) {
    const k = String(r.region_code);
    const e = byLawd.get(k) ?? {};
    const v = { ppp: r.pyeong_price == null ? null : Math.round(Number(r.pyeong_price)), n: Number(r.trade_count ?? 0) };
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
      const ppp = e?.now?.ppp ?? null;
      const before = e?.prev?.ppp ?? null;
      const yoyPct = ppp != null && before ? Math.round(((ppp - before) / before) * 1000) / 10 : null;
      regions[region.slug] = { ppp, range: null, yoyPct, deals };
    } else {
      const vals = codes.map((c) => byLawd.get(c)?.now?.ppp).filter((v): v is number => v != null);
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

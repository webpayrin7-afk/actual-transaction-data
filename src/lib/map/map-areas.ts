/**
 * 지도로 찾기 — 축소 화면용 지역(구·동) 시세 말풍선. 읽기 전용.
 * 위치: 영역 안 단지 좌표(NAVER 중심점 우선)의 평균. 가격: 최근 12개월 거래의 전용 평당가 중위값.
 * 추정·보간 없음 — 기간 안 거래가 없는 지역은 가격 없이 보낸다.
 */
import type { Client } from "@libsql/client";
import { districtNameFromCode } from "@/lib/constants/regions-registry";
import { hasAnchorTable, type MapAreaRange, type MapBBox, type MapDealKind } from "@/lib/map/map-complexes";

export type MapAreaLevel = "gu" | "dong";

export type MapArea = {
  id: string;
  level: MapAreaLevel;
  lawdCd: string;
  name: string;
  lat: number;
  lng: number;
  complexCount: number;
  /** 전용 3.3㎡(1평)당 중위가, 만원 */
  medianPerPyeongMan: number | null;
  tradeCount12m: number;
};

const PYEONG_SQM = 3.3058;
const WINDOW_MONTHS = 12;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

type LawdAgg = {
  at: number;
  /** dong name → 평당가 list */
  byDong: Map<string, number[]>;
  all: number[];
};
/** Per server instance: lawd|deal|area range → per-dong 평당가 samples. */
const lawdCache = new Map<string, LawdAgg>();

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function sinceYearMonth(): string {
  const d = new Date();
  d.setMonth(d.getMonth() - WINDOW_MONTHS);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`;
}

async function lawdPrices(
  db: Client,
  lawd: string,
  deal: MapDealKind,
  area: MapAreaRange,
): Promise<LawdAgg> {
  const key = `${lawd}|${deal}|${area.min}-${area.max}`;
  const hit = lawdCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit;
  // idx_tx_lawd_ym_type (lawd_cd, year_month, deal_type)
  const res = await db.execute({
    sql: `SELECT dong, exclusive_area, deal_amount
          FROM transactions
          WHERE lawd_cd = ? AND year_month >= ? AND deal_type = ?
            AND exclusive_area >= ? AND exclusive_area <= ?
            ${deal === "jeonse" ? "AND COALESCE(monthly_rent, 0) = 0" : ""}`,
    args: [lawd, sinceYearMonth(), deal === "trade" ? "trade" : "rent", area.min, area.max],
  });
  const byDong = new Map<string, number[]>();
  const all: number[] = [];
  for (const r of res.rows) {
    const sqm = Number(r.exclusive_area);
    const amount = Number(r.deal_amount);
    if (!(sqm > 0) || !(amount > 0)) continue;
    const per = amount / (sqm / PYEONG_SQM);
    all.push(per);
    const dong = r.dong ? String(r.dong).trim() : "";
    if (!dong) continue;
    const list = byDong.get(dong) ?? [];
    list.push(per);
    byDong.set(dong, list);
  }
  const agg = { at: Date.now(), byDong, all };
  lawdCache.set(key, agg);
  return agg;
}

export async function readMapAreas(
  db: Client,
  bbox: MapBBox,
  level: MapAreaLevel,
  area: MapAreaRange,
  deal: MapDealKind,
): Promise<MapArea[]> {
  const anchored = await hasAnchorTable(db);
  const lat = anchored ? "COALESCE(a.lat, m.latitude)" : "m.latitude";
  const lng = anchored ? "COALESCE(a.lng, m.longitude)" : "m.longitude";
  const groupCol = level === "gu" ? "m.lawd_cd" : "m.lawd_cd, m.legal_dong_name";
  const groups = await db.execute({
    sql: `SELECT m.lawd_cd, ${level === "dong" ? "m.legal_dong_name AS dong," : ""}
                 AVG(${lat}) AS lat, AVG(${lng}) AS lng, COUNT(*) AS n
          FROM apt_complex_master m
          ${anchored ? "LEFT JOIN complex_map_anchor a ON a.complex_id = m.complex_id" : ""}
          WHERE ${lat} BETWEEN ? AND ? AND ${lng} BETWEEN ? AND ?
            ${level === "dong" ? "AND m.legal_dong_name IS NOT NULL AND m.legal_dong_name <> ''" : ""}
          GROUP BY ${groupCol}`,
    args: [bbox.swLat, bbox.neLat, bbox.swLng, bbox.neLng],
  });

  const lawds = [...new Set(groups.rows.map((r) => String(r.lawd_cd)))];
  const prices = new Map<string, LawdAgg>();
  await Promise.all(
    lawds.map(async (l) => {
      prices.set(l, await lawdPrices(db, l, deal, area));
    }),
  );

  return groups.rows.map((r) => {
    const lawd = String(r.lawd_cd);
    const agg = prices.get(lawd);
    const dong = level === "dong" ? String(r.dong) : null;
    const samples = (dong ? agg?.byDong.get(dong) : agg?.all) ?? [];
    const med = median(samples);
    return {
      id: dong ? `${lawd}|${dong}` : lawd,
      level,
      lawdCd: lawd,
      name: dong ?? (districtNameFromCode(lawd) || lawd),
      lat: Number(r.lat),
      lng: Number(r.lng),
      complexCount: Number(r.n),
      medianPerPyeongMan: med == null ? null : Math.round(med),
      tradeCount12m: samples.length,
    };
  });
}

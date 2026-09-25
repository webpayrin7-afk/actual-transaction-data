/**
 * 지역 시세 평당가 월별 적재본 (region_price_index).
 *
 * scope = 'gu'   → region_code = 5자리 lawd_cd
 * scope = 'dong' → region_code = lawd_cd + bjdong_cd (10자리)
 * pyeong_price는 반올림 전 값(만원/공급평)이며, 읽을 때 반올림한다.
 */
import type { RankingReader } from "@/lib/region-ranking/query";
import { seoulLawdCodes } from "@/lib/region-ranking/price-position-read";

export const REGION_PRICE_INDEX_TABLE = "region_price_index";
export const REGION_PRICE_INDEX_METHOD = "COMPLEX_LATEST_36M_HOUSEHOLD_WEIGHTED_V1";

export const REGION_PRICE_INDEX_DDL = [
  `CREATE TABLE IF NOT EXISTS ${REGION_PRICE_INDEX_TABLE} (
    method_version TEXT NOT NULL,
    scope TEXT NOT NULL CHECK (scope IN ('gu', 'dong')),
    region_code TEXT NOT NULL,
    region_name TEXT NOT NULL,
    year_month TEXT NOT NULL,
    pyeong_price REAL,
    complex_count INTEGER NOT NULL DEFAULT 0,
    trade_count INTEGER NOT NULL DEFAULT 0,
    calculated_at TEXT NOT NULL,
    PRIMARY KEY (method_version, scope, region_code, year_month)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_region_price_index_month
    ON ${REGION_PRICE_INDEX_TABLE} (method_version, scope, year_month)`,
];

export async function ensureRegionPriceIndexTable(db: RankingReader): Promise<void> {
  for (const sql of REGION_PRICE_INDEX_DDL) await db.execute({ sql });
}

export type SeoulGuPriceRank = {
  lawdCd: string;
  name: string;
  pyeongPrice: number;
  change1y: number | null;
  priceRank: number;
  change1yRank: number | null;
};

export type SeoulGuPriceRanks = {
  yearMonth: string;
  total: number;
  gus: SeoulGuPriceRank[];
};

const RANK_CACHE_TTL_MS = 30 * 60 * 1000;
let rankCache: { at: number; value: SeoulGuPriceRanks | null } | null = null;
let rankInflight: Promise<SeoulGuPriceRanks | null> | null = null;

function monthIndex(ym: string): number {
  return Number(ym.slice(0, 4)) * 12 + Number(ym.slice(4, 6)) - 1;
}

function ymFromIndex(idx: number): string {
  return `${Math.floor(idx / 12)}${String((idx % 12) + 1).padStart(2, "0")}`;
}

function competitionRanks<T>(items: T[], score: (item: T) => number): Map<T, number> {
  const sorted = [...items].sort((a, b) => score(b) - score(a));
  const ranks = new Map<T, number>();
  sorted.forEach((item, i) => {
    const prev = sorted[i - 1];
    ranks.set(item, prev !== undefined && score(prev) === score(item) ? ranks.get(prev)! : i + 1);
  });
  return ranks;
}

async function computeSeoulGuPriceRanks(db: RankingReader): Promise<SeoulGuPriceRanks | null> {
  const seoul = new Set(seoulLawdCodes());
  const coverage = await db.execute({
    sql: `SELECT year_month AS ym, COUNT(*) AS n
          FROM ${REGION_PRICE_INDEX_TABLE}
          WHERE method_version = ? AND scope = 'gu' AND pyeong_price IS NOT NULL
            AND region_code LIKE '11%'
          GROUP BY year_month
          ORDER BY year_month DESC
          LIMIT 36`,
    args: [REGION_PRICE_INDEX_METHOD],
  });
  const counts = coverage.rows.map((r) => ({ ym: String(r.ym), n: Number(r.n) }));
  const maxCount = Math.max(0, ...counts.map((c) => c.n));
  if (maxCount === 0) return null;
  const target = counts.find((c) => c.n >= Math.ceil(maxCount * 0.8));
  if (!target) return null;
  const prevYm = ymFromIndex(monthIndex(target.ym) - 12);

  const rows = await db.execute({
    sql: `SELECT region_code, region_name, year_month, pyeong_price
          FROM ${REGION_PRICE_INDEX_TABLE}
          WHERE method_version = ? AND scope = 'gu' AND year_month IN (?, ?)
            AND pyeong_price IS NOT NULL`,
    args: [REGION_PRICE_INDEX_METHOD, target.ym, prevYm],
  });
  const now = new Map<string, { name: string; price: number }>();
  const prev = new Map<string, number>();
  for (const r of rows.rows) {
    const code = String(r.region_code);
    if (!seoul.has(code)) continue;
    const price = Math.round(Number(r.pyeong_price));
    if (!Number.isFinite(price) || price <= 0) continue;
    if (String(r.year_month) === target.ym) now.set(code, { name: String(r.region_name), price });
    else prev.set(code, price);
  }

  const base = [...now.entries()].map(([lawdCd, { name, price }]) => {
    const p = prev.get(lawdCd);
    return {
      lawdCd,
      name,
      pyeongPrice: price,
      change1y: p != null && p > 0 ? Math.round(((price - p) / p) * 10000) / 100 : null,
    };
  });
  const priceRanks = competitionRanks(base, (g) => g.pyeongPrice);
  const withChange = base.filter((g) => g.change1y != null);
  const changeRanks = competitionRanks(withChange, (g) => g.change1y!);
  const gus: SeoulGuPriceRank[] = base
    .map((g) => ({
      ...g,
      priceRank: priceRanks.get(g)!,
      change1yRank: changeRanks.get(g) ?? null,
    }))
    .sort((a, b) => a.priceRank - b.priceRank);

  return { yearMonth: target.ym, total: gus.length, gus };
}

export async function readSeoulGuPriceRanks(db: RankingReader): Promise<SeoulGuPriceRanks | null> {
  if (rankCache && Date.now() - rankCache.at < RANK_CACHE_TTL_MS) return rankCache.value;
  if (rankInflight) return rankInflight;
  rankInflight = computeSeoulGuPriceRanks(db)
    .then((value) => {
      rankCache = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      rankInflight = null;
    });
  return rankInflight;
}

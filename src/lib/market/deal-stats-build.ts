/**
 * market_monthly_deal_stats 빌드 — transactions를 시군구(lawd_cd)·기간 창 단위로 읽어
 * (idx_tx_lawd_ym_type 사용) 로컬에서 월별 분포를 계산한다. 추정값 없음: 모든 값은 실거래 원자료에서 직접 센다.
 *
 * 범위(scope)
 * - lawd:   시군구 한 곳 (scope_key = lawd_cd). 수집(sync_months)된 달은 거래가 0건이어도 area_band='all' 행을 남긴다.
 * - dong:   법정동 (scope_key = "lawd_cd|동이름"). 거래가 있는 달만, 기본은 area_band='all'만
 *           (면적대까지 넣으면 약 2.4배 — 전체 기간 97만 행).
 * - region: 시장 흐름 지역(전국·수도권·지방·시도; trends-regions의 lawdRanges). 모든 소속 시군구가 수집된 달만
 *           만들고, 소속 거래를 합쳐 정확한 중위값을 계산한다(중위값의 평균이 아님).
 */
import type { Client, InStatement, Row } from "@libsql/client";
import {
  AREA_BANDS,
  DEAL_STATS_BUILD_VERSION,
  DEAL_STATS_DDL,
  DEAL_STATS_TABLE,
  PRICE_BAND_COUNT,
  PYEONG_M2,
  areaBandOf,
  dongScopeKey,
  priceBandIndex,
  type AreaBand,
  type DealKind,
  type DealStatsScope,
} from "@/lib/market/deal-stats";
import { TREND_REGIONS } from "@/lib/market/trends-regions";
import { normalizeDongName } from "@/lib/region/region-scope";

export type DealStatsRow = {
  scope: DealStatsScope;
  scope_key: string;
  deal_kind: DealKind;
  area_band: AreaBand;
  year_month: string;
  deal_count: number;
  median_price: number | null;
  p25_price: number | null;
  p75_price: number | null;
  area_count: number;
  median_ppp: number | null;
  p25_ppp: number | null;
  p75_ppp: number | null;
  bands: number[];
};

const VALUE_FIELDS = [
  "deal_count",
  "median_price",
  "p25_price",
  "p75_price",
  "area_count",
  "median_ppp",
  "p25_ppp",
  "p75_ppp",
] as const;

const BAND_COLUMNS = Array.from({ length: PRICE_BAND_COUNT }, (_, i) => `band_${i}`);

const ALL_COLUMNS = [
  "scope",
  "scope_key",
  "deal_kind",
  "area_band",
  "year_month",
  ...VALUE_FIELDS,
  ...BAND_COLUMNS,
  "build_version",
  "computed_at",
];

export function rowKey(r: Pick<DealStatsRow, "scope" | "scope_key" | "deal_kind" | "area_band" | "year_month">): string {
  return `${r.scope}\u0001${r.scope_key}\u0001${r.deal_kind}\u0001${r.area_band}\u0001${r.year_month}`;
}

/** 선형 보간 분위수 (정렬된 배열). */
function quantile(sorted: Float64Array, q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

class Acc {
  prices: number[] = [];
  ppps: number[] = [];
  bands: number[] = new Array(PRICE_BAND_COUNT).fill(0);

  add(kind: DealKind, price: number, ppp: number | null) {
    this.prices.push(price);
    if (ppp != null) this.ppps.push(ppp);
    this.bands[priceBandIndex(kind, price)]!++;
  }

  finish(
    key: Pick<DealStatsRow, "scope" | "scope_key" | "deal_kind" | "area_band" | "year_month">,
  ): DealStatsRow {
    const p = Float64Array.from(this.prices).sort();
    const a = Float64Array.from(this.ppps).sort();
    const q = (arr: Float64Array, v: number) => (arr.length ? Math.round(quantile(arr, v)) : null);
    return {
      ...key,
      deal_count: p.length,
      median_price: q(p, 0.5),
      p25_price: q(p, 0.25),
      p75_price: q(p, 0.75),
      area_count: a.length,
      median_ppp: q(a, 0.5),
      p25_ppp: q(a, 0.25),
      p75_ppp: q(a, 0.75),
      bands: [...this.bands],
    };
  }
}

function emptyRow(
  key: Pick<DealStatsRow, "scope" | "scope_key" | "deal_kind" | "area_band" | "year_month">,
): DealStatsRow {
  return new Acc().finish(key);
}

type SyncKind = "trade" | "rent";
const SYNC_KIND: Record<DealKind, SyncKind> = { trade: "trade", jeonse: "rent" };

/** sync_months: deal_kind → lawd_cd → 수집된 계약월 */
export type Coverage = Record<SyncKind, Map<string, Set<string>>>;

export async function loadCoverage(db: Client): Promise<Coverage> {
  const res = await db.execute(`SELECT deal_kind, lawd_cd, year_month FROM sync_months`);
  const cov: Coverage = { trade: new Map(), rent: new Map() };
  for (const row of res.rows) {
    const kind = String(row.deal_kind) as SyncKind;
    const m = cov[kind];
    if (!m) continue;
    const lawd = String(row.lawd_cd);
    let set = m.get(lawd);
    if (!set) m.set(lawd, (set = new Set()));
    set.add(String(row.year_month));
  }
  return cov;
}

export type AggRegion = { id: string; ranges: Array<[string, string]> };

/** 정확한 합산 집계를 만드는 지역: 시장 흐름의 권역·시도 중 시군구 범위가 있고 시군구 하나가 아닌 곳. */
export function aggregateRegions(): AggRegion[] {
  return TREND_REGIONS.flatMap((r) => {
    if (!r.lawdRanges) return [];
    const single = r.lawdRanges.length === 1 && r.lawdRanges[0]![0] === r.lawdRanges[0]![1];
    return single ? [] : [{ id: r.id, ranges: r.lawdRanges }];
  });
}

function inRanges(lawd: string, ranges: Array<[string, string]>): boolean {
  return ranges.some(([a, b]) => lawd >= a && lawd <= b);
}

/**
 * 지역·계약월이 "완전"한지: 소속 시군구가 모두 수집을 시작한 뒤(가장 늦은 시작월 이후)이고
 * 그 달을 모든 소속 시군구가 수집했을 때만. 일부만 수집된 달은 합계·중위값이 왜곡되므로 만들지 않는다.
 */
export function completeRegionMonths(cov: Coverage, region: AggRegion, kind: DealKind): Set<string> {
  const members = [...cov[SYNC_KIND[kind]].entries()].filter(([lawd]) => inRanges(lawd, region.ranges));
  const out = new Set<string>();
  if (!members.length) return out;
  const from = members.map(([, s]) => [...s].sort()[0]!).sort().at(-1)!;
  const [, first] = members[0]!;
  for (const ym of first) {
    if (ym < from) continue;
    if (members.every(([, s]) => s.has(ym))) out.add(ym);
  }
  return out;
}

export type BuildWindow = { from: string; to: string };

export type BuildOptions = {
  window: BuildWindow;
  coverage: Coverage;
  concurrency?: number;
  /** 동 행을 만들 면적대. 빈 배열이면 동 행 없음. 기본 ['all']. */
  dongBands?: AreaBand[];
  onLawd?: (info: { lawd: string; rows: number; ms: number; done: number; total: number }) => void;
};

async function mapPool<T>(items: T[], n: number, fn: (item: T, i: number) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
}

/** 창(window) 안의 모든 행을 계산한다. 결과는 결정적이다(같은 원자료면 같은 값). */
export async function computeDealStatsWindow(db: Client, opts: BuildOptions): Promise<DealStatsRow[]> {
  const { window, coverage } = opts;
  const dongBands = new Set<AreaBand>(opts.dongBands ?? ["all"]);
  const regions = aggregateRegions();
  const regionComplete = new Map<string, Record<DealKind, Set<string>>>();
  for (const r of regions) {
    regionComplete.set(r.id, {
      trade: completeRegionMonths(coverage, r, "trade"),
      jeonse: completeRegionMonths(coverage, r, "jeonse"),
    });
  }
  const regionAcc = new Map<string, Acc>();
  const out: DealStatsRow[] = [];

  const synced = (kind: DealKind, lawd: string) =>
    [...(coverage[SYNC_KIND[kind]].get(lawd) ?? [])].filter((ym) => ym >= window.from && ym <= window.to);

  const lawds = [...new Set([...coverage.trade.keys(), ...coverage.rent.keys()])]
    .filter((l) => synced("trade", l).length || synced("jeonse", l).length)
    .sort();

  let done = 0;
  await mapPool(lawds, opts.concurrency ?? 4, async (lawd) => {
    const t0 = performance.now();
    const lawdRegions = regions.filter((r) => inRanges(lawd, r.ranges));
    const syncedMonths: Record<DealKind, Set<string>> = {
      trade: new Set(synced("trade", lawd)),
      jeonse: new Set(synced("jeonse", lawd)),
    };
    const acc = new Map<string, Acc>();
    const dongAcc = new Map<string, Acc>();
    const bump = (map: Map<string, Acc>, key: string) => {
      let a = map.get(key);
      if (!a) map.set(key, (a = new Acc()));
      return a;
    };
    let fetched = 0;
    for (const kind of ["trade", "jeonse"] as const) {
      if (!syncedMonths[kind].size) continue;
      const res = await db.execute({
        sql:
          kind === "trade"
            ? `SELECT year_month, deal_amount, exclusive_area, dong FROM transactions
               WHERE lawd_cd = ? AND year_month BETWEEN ? AND ? AND deal_type = 'trade'`
            : `SELECT year_month, deal_amount, exclusive_area, dong FROM transactions
               WHERE lawd_cd = ? AND year_month BETWEEN ? AND ? AND deal_type = 'rent'
                 AND COALESCE(monthly_rent, 0) = 0`,
        args: [lawd, window.from, window.to],
      });
      fetched += res.rows.length;
      for (const row of res.rows as Row[]) {
        const ym = String(row.year_month);
        if (!syncedMonths[kind].has(ym)) continue;
        const price = Number(row.deal_amount);
        if (!(price > 0)) continue;
        const area = Number(row.exclusive_area);
        const band = areaBandOf(area);
        const ppp = band ? price / (area / PYEONG_M2) : null;
        const bands: AreaBand[] = band ? ["all", band] : ["all"];
        const dong = dongBands.size ? normalizeDongName(String(row.dong ?? "")) : null;
        for (const b of bands) {
          bump(acc, `${kind}|${b}|${ym}`).add(kind, price, ppp);
          if (dong && dongBands.has(b)) bump(dongAcc, `${dong}|${kind}|${b}|${ym}`).add(kind, price, ppp);
          for (const r of lawdRegions) {
            if (!regionComplete.get(r.id)![kind].has(ym)) continue;
            bump(regionAcc, `${r.id}|${kind}|${b}|${ym}`).add(kind, price, ppp);
          }
        }
      }
    }
    let rows = 0;
    for (const kind of ["trade", "jeonse"] as const) {
      for (const ym of syncedMonths[kind]) {
        for (const b of AREA_BANDS) {
          const a = acc.get(`${kind}|${b}|${ym}`);
          const key = { scope: "lawd" as const, scope_key: lawd, deal_kind: kind, area_band: b, year_month: ym };
          if (a) out.push(a.finish(key));
          else if (b === "all") out.push(emptyRow(key));
          else continue;
          rows++;
        }
      }
    }
    for (const [k, a] of dongAcc) {
      const [dong, kind, band, ym] = k.split("|") as [string, DealKind, AreaBand, string];
      out.push(
        a.finish({ scope: "dong", scope_key: dongScopeKey(lawd, dong), deal_kind: kind, area_band: band, year_month: ym }),
      );
      rows++;
    }
    done++;
    opts.onLawd?.({ lawd, rows: fetched, ms: Math.round(performance.now() - t0), done, total: lawds.length });
  });

  for (const r of regions) {
    const complete = regionComplete.get(r.id)!;
    for (const kind of ["trade", "jeonse"] as const) {
      for (const ym of complete[kind]) {
        if (ym < window.from || ym > window.to) continue;
        for (const b of AREA_BANDS) {
          const key = { scope: "region" as const, scope_key: r.id, deal_kind: kind, area_band: b, year_month: ym };
          const a = regionAcc.get(`${r.id}|${kind}|${b}|${ym}`);
          if (a) out.push(a.finish(key));
          else if (b === "all") out.push(emptyRow(key));
        }
      }
    }
  }
  return out;
}

function rowFromDb(row: Row): DealStatsRow {
  const n = (v: unknown) => (v == null ? null : Number(v));
  return {
    scope: String(row.scope) as DealStatsScope,
    scope_key: String(row.scope_key),
    deal_kind: String(row.deal_kind) as DealKind,
    area_band: String(row.area_band) as AreaBand,
    year_month: String(row.year_month),
    deal_count: Number(row.deal_count),
    median_price: n(row.median_price),
    p25_price: n(row.p25_price),
    p75_price: n(row.p75_price),
    area_count: Number(row.area_count),
    median_ppp: n(row.median_ppp),
    p25_ppp: n(row.p25_ppp),
    p75_ppp: n(row.p75_ppp),
    bands: BAND_COLUMNS.map((c) => Number(row[c] ?? 0)),
  };
}

function sameRow(a: DealStatsRow, b: DealStatsRow): boolean {
  for (const f of VALUE_FIELDS) if (a[f] !== b[f]) return false;
  return a.bands.every((v, i) => v === b.bands[i]);
}

export async function tableExists(db: Client): Promise<boolean> {
  const res = await db.execute({
    sql: `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`,
    args: [DEAL_STATS_TABLE],
  });
  return res.rows.length > 0;
}

export async function ensureDealStatsTable(db: Client): Promise<void> {
  await db.executeMultiple(DEAL_STATS_DDL);
}

export async function readExistingWindow(
  db: Client,
  window: BuildWindow,
  staleKeys: Set<string>,
): Promise<Map<string, DealStatsRow>> {
  const map = new Map<string, DealStatsRow>();
  if (!(await tableExists(db))) return map;
  const res = await db.execute({
    sql: `SELECT * FROM ${DEAL_STATS_TABLE} WHERE year_month BETWEEN ? AND ?`,
    args: [window.from, window.to],
  });
  for (const row of res.rows) {
    const r = rowFromDb(row);
    if (String(row.build_version) !== DEAL_STATS_BUILD_VERSION) staleKeys.add(rowKey(r));
    map.set(rowKey(r), r);
  }
  return map;
}

export type DealStatsDiff = {
  insert: DealStatsRow[];
  update: DealStatsRow[];
  remove: DealStatsRow[];
  unchanged: number;
};

/** 버전이 다른 기존 행은 값이 같아도 갱신 대상 (versionStale 키 집합). */
export function diffRows(
  computed: DealStatsRow[],
  existing: Map<string, DealStatsRow>,
  staleKeys: Set<string> = new Set(),
): DealStatsDiff {
  const diff: DealStatsDiff = { insert: [], update: [], remove: [], unchanged: 0 };
  const seen = new Set<string>();
  for (const r of computed) {
    const k = rowKey(r);
    seen.add(k);
    const prev = existing.get(k);
    if (!prev) diff.insert.push(r);
    else if (!sameRow(prev, r) || staleKeys.has(k)) diff.update.push(r);
    else diff.unchanged++;
  }
  for (const [k, r] of existing) if (!seen.has(k)) diff.remove.push(r);
  return diff;
}

const ROWS_PER_INSERT = 100;
const STATEMENTS_PER_BATCH = 5;
const MAX_ATTEMPTS = 4;

/** INSERT OR REPLACE·DELETE는 다시 실행해도 결과가 같아 일시 오류는 재시도한다. */
async function batchWithRetry(db: Client, statements: InStatement[]): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await db.batch(statements, "write");
      return;
    } catch (error) {
      if (attempt >= MAX_ATTEMPTS) throw error;
      console.warn(`[deal-stats] batch retry ${attempt}:`, error instanceof Error ? error.message : error);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

export async function applyDiff(db: Client, diff: DealStatsDiff, computedAt: string): Promise<void> {
  const statements: InStatement[] = [];
  const upserts = [...diff.insert, ...diff.update];
  for (let i = 0; i < upserts.length; i += ROWS_PER_INSERT) {
    const chunk = upserts.slice(i, i + ROWS_PER_INSERT);
    statements.push({
      sql: `INSERT OR REPLACE INTO ${DEAL_STATS_TABLE} (${ALL_COLUMNS.join(", ")})
            VALUES ${chunk.map(() => `(${ALL_COLUMNS.map(() => "?").join(", ")})`).join(", ")}`,
      args: chunk.flatMap((r) => [
        r.scope,
        r.scope_key,
        r.deal_kind,
        r.area_band,
        r.year_month,
        ...VALUE_FIELDS.map((f) => r[f]),
        ...r.bands,
        DEAL_STATS_BUILD_VERSION,
        computedAt,
      ]),
    });
  }
  for (const r of diff.remove) {
    statements.push({
      sql: `DELETE FROM ${DEAL_STATS_TABLE}
            WHERE scope = ? AND scope_key = ? AND deal_kind = ? AND area_band = ? AND year_month = ?`,
      args: [r.scope, r.scope_key, r.deal_kind, r.area_band, r.year_month],
    });
  }
  for (let i = 0; i < statements.length; i += STATEMENTS_PER_BATCH) {
    await batchWithRetry(db, statements.slice(i, i + STATEMENTS_PER_BATCH));
  }
}

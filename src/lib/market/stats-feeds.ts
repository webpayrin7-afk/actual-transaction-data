/**
 * /stats 시장동향용 기간별 실거래 피드.
 * 요청 시 transactions 전체를 스캔하지 않고, rebuild 때 만든 스냅샷만 읽는다.
 */
import { getDb, hasDb, ensureSchema } from "@/lib/db/client";
import { LAWD_TO_REGION } from "@/lib/constants/regions";
import { aptDetailHref } from "@/lib/molit/apt";
import {
  DROP_THRESHOLD,
  MARKET_COMPLEX_KEY_VERSION,
  addDays,
  addMonths,
  scopeMatchesLawd,
  typeKey,
  weekStartMonday,
  type StatsPeriod,
  type StatsScope,
} from "@/lib/market/keys";
import type { MarketDealItem, MarketVolumeItem } from "@/lib/market/home";

const FEED_LIST_LIMIT = 12;
const HIGH_PRICE_MAN = 200_000; // 20억
const ACTIVE_MIN_COUNT = 2;

export interface StatsPeriodWindow {
  curFrom: string;
  curTo: string;
  prevFrom: string;
  prevTo: string;
  windowLabel: string;
  prevWindowLabel: string;
  /** 진행 중 주/월을 동일 경과일으로 맞췄는지 */
  alignedPartial: boolean;
}

export interface StatsDealFeed {
  period: StatsPeriod;
  scope: StatsScope;
  asOfDate: string;
  window: StatsPeriodWindow;
  notables: MarketDealItem[];
  singoga: MarketDealItem[];
  drops: MarketDealItem[];
  activeComplexes: MarketVolumeItem[];
}

interface RawTrade {
  id: string;
  lawdCd: string;
  dealDate: string;
  aptName: string;
  aptNameNorm: string;
  gu: string;
  dong: string;
  exclusiveArea: number;
  dealAmount: number;
}

function regionSlugFor(lawdCd: string, gu: string): string {
  const byLawd = LAWD_TO_REGION[lawdCd];
  if (byLawd) return byLawd.slug;
  const found = Object.values(LAWD_TO_REGION).find(
    (r) =>
      gu.includes(r.name) ||
      r.districts.some((d) => gu.includes(d.name) || d.name.includes(gu)),
  );
  return found?.slug ?? "seoul-gangnam";
}

function hrefFor(row: {
  aptName: string;
  lawdCd: string;
  gu: string;
}): string {
  return aptDetailHref(row.aptName, regionSlugFor(row.lawdCd, row.gu), row.gu);
}

function daysBetweenInclusive(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00Z`).getTime();
  const b = new Date(`${to}T00:00:00Z`).getTime();
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

/** 진행 중 주/월은 직전 기간도 같은 경과일 길이로 맞춘다. */
export function periodWindows(
  asOf: string,
  period: StatsPeriod,
): StatsPeriodWindow {
  if (period === "daily") {
    const curTo = asOf;
    const curFrom = addDays(asOf, -6);
    const prevTo = addDays(curFrom, -1);
    const prevFrom = addDays(prevTo, -6);
    return {
      curFrom,
      curTo,
      prevFrom,
      prevTo,
      windowLabel: "최근 7일",
      prevWindowLabel: "직전 7일",
      alignedPartial: false,
    };
  }

  if (period === "weekly") {
    const thisWeek = weekStartMonday(asOf);
    const curFrom = thisWeek;
    const curTo = asOf;
    const elapsed = daysBetweenInclusive(curFrom, curTo);
    const prevFrom = addDays(thisWeek, -7);
    const prevTo = addDays(prevFrom, elapsed);
    const partial = curTo < addDays(thisWeek, 6);
    return {
      curFrom,
      curTo,
      prevFrom,
      prevTo,
      windowLabel: "이번 주",
      prevWindowLabel: partial ? "지난 주 동일 경과일" : "지난 주",
      alignedPartial: partial,
    };
  }

  const ym = asOf.slice(0, 7);
  const curFrom = `${ym}-01`;
  const curTo = asOf;
  const dayNum = Number(asOf.slice(8, 10));
  const prevFrom = addMonths(curFrom, -1);
  const prevMonthLast = addDays(curFrom, -1);
  const candidate = `${prevFrom.slice(0, 7)}-${String(dayNum).padStart(2, "0")}`;
  const prevTo = candidate <= prevMonthLast ? candidate : prevMonthLast;
  const monthEnd = addDays(addMonths(curFrom, 1), -1);
  const isPartial = curTo < monthEnd;
  return {
    curFrom,
    curTo,
    prevFrom,
    prevTo,
    windowLabel: "이번 달",
    prevWindowLabel: isPartial ? "지난 달 동일 경과일" : "지난 달",
    alignedPartial: isPartial,
  };
}

function emptyFeed(
  period: StatsPeriod,
  scope: StatsScope,
  asOfDate: string,
): StatsDealFeed {
  return {
    period,
    scope,
    asOfDate,
    window: periodWindows(asOfDate || "1970-01-01", period),
    notables: [],
    singoga: [],
    drops: [],
    activeComplexes: [],
  };
}

export async function computeStatsDealFeed(
  asOfDate: string,
  period: StatsPeriod,
  scope: StatsScope,
): Promise<StatsDealFeed> {
  const db = getDb();
  if (!db || !asOfDate) return emptyFeed(period, scope, asOfDate);

  const window = periodWindows(asOfDate, period);
  const { curFrom, curTo, prevFrom, prevTo } = window;

  const [curResult, volResult] = await Promise.all([
    db.execute({
      sql: `SELECT id, lawd_cd, deal_date, apt_name, apt_name_norm, gu, dong,
                   exclusive_area, deal_amount
            FROM transactions
            WHERE deal_type = ?
              AND deal_date >= ?
              AND deal_date <= ?
            ORDER BY deal_date ASC, id ASC`,
      args: ["trade", curFrom, curTo],
    }),
    db.execute({
      sql: `SELECT apt_name_norm, apt_name, gu, dong, lawd_cd, deal_date
            FROM transactions
            WHERE deal_type = ?
              AND deal_date >= ?
              AND deal_date <= ?`,
      args: ["trade", prevFrom, curTo],
    }),
  ]);

  const recent: RawTrade[] = curResult.rows
    .map((row) => ({
      id: String(row.id),
      lawdCd: String(row.lawd_cd),
      dealDate: String(row.deal_date),
      aptName: String(row.apt_name),
      aptNameNorm: String(row.apt_name_norm),
      gu: String(row.gu ?? ""),
      dong: String(row.dong ?? ""),
      exclusiveArea: Number(row.exclusive_area) || 0,
      dealAmount: Number(row.deal_amount) || 0,
    }))
    .filter((tx) => scopeMatchesLawd(scope, tx.lawdCd));

  if (recent.length === 0) {
    return { ...emptyFeed(period, scope, asOfDate), window };
  }

  const norms = [...new Set(recent.map((r) => r.aptNameNorm))];
  const priorMax = new Map<string, number>();
  const CHUNK = 250;
  await Promise.all(
    Array.from({ length: Math.ceil(norms.length / CHUNK) }, (_, i) => {
      const slice = norms.slice(i * CHUNK, i * CHUNK + CHUNK);
      const placeholders = slice.map(() => "?").join(",");
      return db
        .execute({
          sql: `SELECT apt_name_norm, lawd_cd, dong, exclusive_area,
                       MAX(deal_amount) AS max_amt
                FROM transactions
                WHERE deal_type = ?
                  AND deal_date < ?
                  AND apt_name_norm IN (${placeholders})
                GROUP BY apt_name_norm, lawd_cd, dong, ROUND(exclusive_area * 100)`,
          args: ["trade", curFrom, ...slice],
        })
        .then((hist) => {
          for (const row of hist.rows) {
            const key = typeKey(
              String(row.apt_name_norm),
              String(row.lawd_cd),
              String(row.dong ?? ""),
              Number(row.exclusive_area) || 0,
            );
            priorMax.set(key, Number(row.max_amt) || 0);
          }
        });
    }),
  );

  const running = new Map<string, number>(priorMax);
  const singoga: MarketDealItem[] = [];
  const drops: MarketDealItem[] = [];

  for (const tx of recent) {
    const key = typeKey(tx.aptNameNorm, tx.lawdCd, tx.dong, tx.exclusiveArea);
    const prior = running.get(key) ?? 0;

    if (prior > 0 && tx.dealAmount > prior) {
      const changeAmount = tx.dealAmount - prior;
      const changePct = Math.round((changeAmount / prior) * 1000) / 10;
      singoga.push({
        id: tx.id,
        aptName: tx.aptName,
        gu: tx.gu,
        dong: tx.dong,
        exclusiveArea: tx.exclusiveArea,
        dealAmount: tx.dealAmount,
        dealDate: tx.dealDate,
        href: hrefFor(tx),
        priorMaxAmount: prior,
        changeAmount,
        changePct,
        kind: "singoga",
        kindLabel: "신고가",
      });
    }

    if (prior > 0) {
      const ratio = (tx.dealAmount - prior) / prior;
      if (ratio <= DROP_THRESHOLD) {
        drops.push({
          id: tx.id,
          aptName: tx.aptName,
          gu: tx.gu,
          dong: tx.dong,
          exclusiveArea: tx.exclusiveArea,
          dealAmount: tx.dealAmount,
          dealDate: tx.dealDate,
          href: hrefFor(tx),
          priorMaxAmount: prior,
          changeAmount: tx.dealAmount - prior,
          changePct: Math.round(ratio * 1000) / 10,
          kind: "drop",
          kindLabel: "큰 폭 하락",
        });
      }
    }

    running.set(key, Math.max(prior, tx.dealAmount));
  }

  singoga.sort((a, b) => (b.changeAmount ?? 0) - (a.changeAmount ?? 0));
  drops.sort((a, b) => (a.changePct ?? 0) - (b.changePct ?? 0));

  type VolAgg = {
    aptName: string;
    gu: string;
    dong: string;
    lawdCd: string;
    recentCount: number;
    priorCount: number;
  };
  const volMap = new Map<string, VolAgg>();
  for (const row of volResult.rows) {
    const lawdCd = String(row.lawd_cd);
    if (!scopeMatchesLawd(scope, lawdCd)) continue;
    const norm = String(row.apt_name_norm);
    const dong = String(row.dong ?? "");
    const key = `${norm}|${lawdCd}|${dong}`;
    const dealDate = String(row.deal_date);
    let agg = volMap.get(key);
    if (!agg) {
      agg = {
        aptName: String(row.apt_name),
        gu: String(row.gu ?? ""),
        dong,
        lawdCd,
        recentCount: 0,
        priorCount: 0,
      };
      volMap.set(key, agg);
    }
    if (dealDate >= curFrom && dealDate <= curTo) agg.recentCount += 1;
    else if (dealDate >= prevFrom && dealDate <= prevTo) agg.priorCount += 1;
  }

  const activeComplexes: MarketVolumeItem[] = [...volMap.values()]
    .filter((v) => v.recentCount >= ACTIVE_MIN_COUNT)
    .map((v) => ({
      aptName: v.aptName,
      gu: v.gu,
      dong: v.dong,
      href: hrefFor({ aptName: v.aptName, lawdCd: v.lawdCd, gu: v.gu }),
      recentCount: v.recentCount,
      priorCount: v.priorCount,
      increaseCount: v.recentCount - v.priorCount,
      growthPct:
        v.priorCount > 0
          ? Math.round(
              ((v.recentCount - v.priorCount) / v.priorCount) * 1000,
            ) / 10
          : null,
    }))
    .sort(
      (a, b) =>
        b.recentCount - a.recentCount || b.increaseCount - a.increaseCount,
    )
    .slice(0, FEED_LIST_LIMIT);

  const shownIds = new Set<string>([
    ...singoga.slice(0, FEED_LIST_LIMIT).map((i) => i.id),
    ...drops.slice(0, FEED_LIST_LIMIT).map((i) => i.id),
  ]);

  const nearHigh: MarketDealItem[] = recent
    .filter((tx) => {
      if (shownIds.has(tx.id)) return false;
      const key = typeKey(tx.aptNameNorm, tx.lawdCd, tx.dong, tx.exclusiveArea);
      const prior = priorMax.get(key) ?? 0;
      if (prior <= 0) return false;
      const ratio = tx.dealAmount / prior;
      return ratio >= 0.95 && ratio < 1;
    })
    .map((tx) => {
      const key = typeKey(tx.aptNameNorm, tx.lawdCd, tx.dong, tx.exclusiveArea);
      const prior = priorMax.get(key)!;
      const changeAmount = tx.dealAmount - prior;
      return {
        id: tx.id,
        aptName: tx.aptName,
        gu: tx.gu,
        dong: tx.dong,
        exclusiveArea: tx.exclusiveArea,
        dealAmount: tx.dealAmount,
        dealDate: tx.dealDate,
        href: hrefFor(tx),
        priorMaxAmount: prior,
        changeAmount,
        changePct: Math.round((changeAmount / prior) * 1000) / 10,
        kind: "high" as const,
        kindLabel: "최고가 근접",
      };
    })
    .sort((a, b) => (b.changePct ?? 0) - (a.changePct ?? 0));

  const highDeals: MarketDealItem[] = recent
    .filter((tx) => tx.dealAmount >= HIGH_PRICE_MAN && !shownIds.has(tx.id))
    .map((tx) => ({
      id: tx.id,
      aptName: tx.aptName,
      gu: tx.gu,
      dong: tx.dong,
      exclusiveArea: tx.exclusiveArea,
      dealAmount: tx.dealAmount,
      dealDate: tx.dealDate,
      href: hrefFor(tx),
      priorMaxAmount: priorMax.get(
        typeKey(tx.aptNameNorm, tx.lawdCd, tx.dong, tx.exclusiveArea),
      ) ?? null,
      changeAmount: null,
      changePct: null,
      kind: "high" as const,
      kindLabel: "고가 거래",
    }))
    .sort((a, b) => b.dealAmount - a.dealAmount);

  const notables: MarketDealItem[] = [
    ...singoga.slice(0, 4),
    ...nearHigh.slice(0, 3),
    ...highDeals.slice(0, 6),
    ...drops.slice(0, 3),
  ]
    .filter((item, idx, arr) => arr.findIndex((x) => x.id === item.id) === idx)
    .sort(
      (a, b) =>
        b.dealDate.localeCompare(a.dealDate) || b.dealAmount - a.dealAmount,
    )
    .slice(0, FEED_LIST_LIMIT);

  return {
    period,
    scope,
    asOfDate,
    window,
    notables,
    singoga: singoga.slice(0, FEED_LIST_LIMIT),
    drops: drops.slice(0, FEED_LIST_LIMIT),
    activeComplexes,
  };
}

export async function saveStatsDealFeeds(
  asOfDate: string,
  feeds: StatsDealFeed[],
): Promise<void> {
  const db = getDb();
  if (!db) return;
  const computedAt = new Date().toISOString();
  await db.execute({
    sql: `DELETE FROM market_stats_feeds`,
    args: [],
  });
  for (const feed of feeds) {
    await db.execute({
      sql: `INSERT INTO market_stats_feeds
              (period, scope, as_of_date, computed_at, complex_key_version, payload)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [
        feed.period,
        feed.scope,
        asOfDate,
        computedAt,
        MARKET_COMPLEX_KEY_VERSION,
        JSON.stringify(feed),
      ],
    });
  }
}

export async function readStatsDealFeed(
  period: StatsPeriod,
  scope: StatsScope,
): Promise<StatsDealFeed | null> {
  const db = getDb();
  if (!db) return null;
  try {
    const result = await db.execute({
      sql: `SELECT payload FROM market_stats_feeds
            WHERE period = ? AND scope = ?`,
      args: [period, scope],
    });
    const raw = result.rows[0]?.payload;
    if (!raw) return null;
    return JSON.parse(String(raw)) as StatsDealFeed;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/no such table|BLOCKED/i.test(msg)) return null;
    console.warn("[stats-feeds] read failed:", msg);
    return null;
  }
}

export async function rebuildAllStatsDealFeeds(
  asOfDate: string,
): Promise<number> {
  if (!hasDb()) return 0;
  await ensureSchema();
  const periods: StatsPeriod[] = ["daily", "weekly", "monthly"];
  const scopes: StatsScope[] = ["all", "seoul", "gyeonggi"];
  const feeds: StatsDealFeed[] = [];
  for (const period of periods) {
    for (const scope of scopes) {
      feeds.push(await computeStatsDealFeed(asOfDate, period, scope));
    }
  }
  await saveStatsDealFeeds(asOfDate, feeds);
  return feeds.length;
}

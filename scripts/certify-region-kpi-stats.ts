/**
 * READ-only KPI / Section2 / stats fallback certification.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();
import { getDb } from "../src/lib/db/client";
import { TRUSTED_DISCOVERY_COPY } from "../src/lib/db/discovery-axis";
import { newlySeenCompactStatus } from "../src/lib/region/market-insight";
import { clearRegionDailyCaches, getRegionDaily } from "../src/lib/molit/service";
import { getMarketStats } from "../src/lib/market/stats";

async function wh(
  db: NonNullable<ReturnType<typeof getDb>>,
  lawds: string[],
  ym: string,
  kind: string,
) {
  const ph = lawds.map(() => "?").join(",");
  const r = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM transactions WHERE lawd_cd IN (${ph}) AND year_month=? AND deal_type=?`,
    args: [...lawds, ym, kind],
  });
  return Number(r.rows[0]?.n || 0);
}

async function main() {
  const db = getDb();
  if (!db) throw new Error("no db");
  clearRegionDailyCaches();
  function shiftYm(ym: string, delta: number): string {
    const y = Number(ym.slice(0, 4));
    const m = Number(ym.slice(4, 6));
    const d = y * 12 + (m - 1) + delta;
    const ny = Math.floor(d / 12);
    const nm = (d % 12) + 1;
    return `${ny}${String(nm).padStart(2, "0")}`;
  }

  const discNn = await db.execute(
    `SELECT COUNT(*) AS n FROM transactions WHERE discovery_at IS NOT NULL AND discovery_at != ''`,
  );
  const trusted = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM transactions WHERE discovery_at >= ? AND discovery_at < ?`,
    args: [
      TRUSTED_DISCOVERY_COPY.fromInclusive,
      TRUSTED_DISCOVERY_COPY.toExclusive,
    ],
  });
  const histRentDisc = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM transactions
          WHERE lawd_cd='11680' AND deal_type='rent' AND year_month='202302'
            AND discovery_at IS NOT NULL AND discovery_at != ''`,
    args: [],
  });

  const kpis = [];
  for (const sample of [
    { slug: "seoul-gangnam", lawds: ["11680"], ym: "202608" },
    { slug: "seoul-songpa", lawds: ["11710"], ym: "202608" },
    { slug: "seoul-yongsan", lawds: ["11170"], ym: "202608" },
    { slug: "gyeonggi-seongnam", lawds: ["41131", "41133", "41135"], ym: "202608" },
    { slug: "gyeonggi-suwon", lawds: ["41111", "41113", "41115", "41117"], ym: "202608" },
    { slug: "gyeonggi-bucheon", lawds: ["41192", "41194", "41196"], ym: "202508" },
    { slug: "gyeonggi-hwaseong", lawds: ["41591", "41593", "41595", "41597"], ym: "202508" },
  ]) {
    const market = await getRegionDaily({
      regionSlug: sample.slug,
      part: "market",
      yearMonth: sample.ym,
      contractMonth: sample.ym,
    });
    const latest = await getRegionDaily({
      regionSlug: sample.slug,
      part: "latest",
      yearMonth: sample.ym,
    });
    const trade = await wh(db, sample.lawds, sample.ym, "trade");
    const rent = await wh(db, sample.lawds, sample.ym, "rent");
    const prevYm = shiftYm(sample.ym, -1);
    const prev = await wh(db, sample.lawds, prevYm, "trade");
    const yearAgoYm = shiftYm(sample.ym, -12);
    const yearAgo = await wh(db, sample.lawds, yearAgoYm, "trade");
    const compact = newlySeenCompactStatus({
      isToday: Boolean(latest.latestIsToday),
      heroDate: latest.selectedDate,
    });
    kpis.push({
      slug: sample.slug,
      ym: sample.ym,
      warehouseTrade: trade,
      warehouseRent: rent,
      kpiMonth: market.monthTradeCount,
      matchMonth: trade === market.monthTradeCount,
      rentNotMixed: rent === 0 || rent !== market.monthTradeCount,
      warehousePrev: prev,
      kpiPrev: market.prevMonthTradeCount,
      matchPrev: prev === market.prevMonthTradeCount,
      warehouseYearAgo: yearAgo,
      kpiYearAgo: market.yearAgoMonthTradeCount,
      matchYearAgo: yearAgo === market.yearAgoMonthTradeCount,
      singoga: market.monthSingogaCount,
      singogaShare:
        market.monthTradeCount > 0 && market.monthSingogaCount != null
          ? market.monthSingogaCount / market.monthTradeCount
          : null,
      medianPyeong: market.medianPyeongPrice,
      latestIsToday: latest.latestIsToday,
      firstSeenReady: latest.firstSeenReady,
      selectedDate: latest.selectedDate,
      compactEmptyCopy: compact,
    });
  }
  const statsNow = await getMarketStats({ period: "monthly", scope: "all" });
  const stats2020 = await getMarketStats({
    period: "monthly",
    scope: "all",
    date: "2020-03-01",
  });
  const stats2023 = await getMarketStats({
    period: "monthly",
    scope: "all",
    date: "2023-01-01",
  });
  console.log(
    JSON.stringify(
      {
        kpis,
        statsNow: {
          source: statsNow.source,
          asOf: statsNow.asOfDate,
          trade: statsNow.kpi?.tradeCount,
          canGoPrev: statsNow.kpi?.canGoPrev,
          window: statsNow.kpi?.windowLabel,
        },
        stats2020: {
          source: stats2020.source,
          trade: stats2020.kpi?.tradeCount,
          window: stats2020.kpi?.windowLabel,
          canGoPrev: stats2020.kpi?.canGoPrev,
        },
        stats2023: {
          source: stats2023.source,
          trade: stats2023.kpi?.tradeCount,
          window: stats2023.kpi?.windowLabel,
        },
        discovery: {
          nonNull: Number(discNn.rows[0]?.n) || 0,
          trusted: Number(trusted.rows[0]?.n) || 0,
          trustedExpected: TRUSTED_DISCOVERY_COPY.expectedRows,
          gangnamRent202302Discovery: Number(histRentDisc.rows[0]?.n) || 0,
        },
        gates: {
          kpiMonth: kpis.every((k) => k.matchMonth),
          kpiPrev: kpis.every((k) => k.matchPrev),
          kpiYearAgo: kpis.every((k) => k.matchYearAgo),
          rentNotMixed: kpis.every((k) => k.rentNotMixed),
          historicalRepairHidden: Number(histRentDisc.rows[0]?.n) === 0,
          trustedUnchanged: Number(trusted.rows[0]?.n) === 2303,
        },
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

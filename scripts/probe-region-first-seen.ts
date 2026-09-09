/**
 * READ-ONLY: 지역 일별 신규 확인 거래 스모크. production write 없음.
 *   npx tsx scripts/probe-region-first-seen.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { getDb, ensureSchema } from "../src/lib/db/client";
import { getRegionDaily } from "../src/lib/molit/service";
import { fetchOneTradeForSync } from "../src/lib/molit/client";
import { seoulDateOf, seoulDayBoundsUtc } from "../src/lib/market/time";

const SLUGS = [
  "seoul-gangnam",
  "seoul-songpa",
  "gyeonggi-seongnam",
  "gyeonggi-suwon",
  "gyeonggi-gwangju",
  "seoul-yongsan",
];

async function time<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  const result = await fn();
  console.log(`  ${label}: ${Math.round(performance.now() - t0)}ms`);
  return result;
}

async function main() {
  await ensureSchema();
  const db = getDb();
  if (!db) throw new Error("no db");

  const bounds = seoulDayBoundsUtc("2026-09-09");
  const yongsan = await db.execute({
    sql: `SELECT apt_name, dong, exclusive_area, floor, deal_amount, deal_date, first_seen_at
          FROM transactions
          WHERE lawd_cd = ? AND deal_type = 'trade'
            AND first_seen_at IS NOT NULL AND first_seen_at != ''
            AND first_seen_at >= ? AND first_seen_at < ?
          ORDER BY deal_amount DESC`,
    args: ["11170", bounds.startIso, bounds.endIso],
  });
  console.log("DB 용산 9/9 first_seen", yongsan.rows.length);
  for (const row of yongsan.rows) {
    console.log({
      apt: row.apt_name,
      dong: row.dong,
      sqm: row.exclusive_area,
      floor: row.floor,
      amount: row.deal_amount,
      dealDate: row.deal_date,
      kst: seoulDateOf(String(row.first_seen_at)),
    });
  }

  const miju = await db.execute({
    sql: `SELECT id, apt_name, deal_date, deal_amount, exclusive_area, floor, first_seen_at
          FROM transactions
          WHERE lawd_cd = ? AND deal_type = 'trade' AND apt_name = ? AND year_month = ?`,
    args: ["11170", "미주B", "202606"],
  });
  console.log("DB 용산 미주B 202606", miju.rows);

  for (const slug of SLUGS) {
    console.log(`\n=== ${slug} ===`);
    const latestCold = await time("latest cold", () =>
      getRegionDaily({ regionSlug: slug, part: "latest" }),
    );
    const latestWarm = await time("latest warm", () =>
      getRegionDaily({ regionSlug: slug, part: "latest" }),
    );
    const market = await time("market", () =>
      getRegionDaily({
        regionSlug: slug,
        part: "market",
        contractMonth: "202609",
      }),
    );
    const history = await time("history", () =>
      getRegionDaily({
        regionSlug: slug,
        part: "history",
        yearMonth: "202609",
      }),
    );
    const dayDates = history.days
      .filter((d) => d.dealCount > 0 && !d.bulkIngestDay)
      .slice(0, 2)
      .map((d) => d.date);
    const days = dayDates.length
      ? await time("days", () =>
          getRegionDaily({
            regionSlug: slug,
            part: "days",
            yearMonth: "202609",
            dates: dayDates,
          }),
        )
      : null;
    const json = Buffer.byteLength(
      JSON.stringify({ latestCold, market, history, days }),
    );
    console.log(
      JSON.stringify({
        selected: latestCold.selectedDate,
        isToday: latestCold.latestIsToday,
        n: latestCold.tradeCount,
        singoga: latestCold.selectedDaySingogaCount,
        bulk: latestCold.bulkIngestDay,
        median: market.medianDealAmount,
        monthN: market.monthTradeCount,
        historyDays: history.days.map((d) => ({
          date: d.date,
          n: d.dealCount,
          bulk: d.bulkIngestDay,
        })),
        historyTotal: history.historyTotalCount,
        daySections: days?.historySections.map((s) => ({
          date: s.date,
          n: s.totalCount,
          singoga: s.singogaCount,
          known: s.singogaKnown,
          bulk: s.bulkIngestDay,
        })),
        json,
        names: latestCold.deals.slice(0, 8).map((d) => ({
          name: d.aptName,
          singoga: d.singogaKind,
          dealDate: d.dealDate,
          amt: d.dealAmount,
        })),
        warmSelected: latestWarm.selectedDate,
      }),
    );
  }

  console.log("\n=== 미주B MOLIT vs DB (READ, no write) ===");
  const api = await fetchOneTradeForSync("11170", "202606");
  const apiUnique = new Map(api.map((tx) => [tx.id, tx]));
  const apiMiju = [...apiUnique.values()].filter((tx) =>
    tx.aptName.replace(/\s+/g, "").includes("미주B"),
  );
  const dbJune = await db.execute({
    sql: `SELECT apt_name, deal_date, exclusive_area, floor, deal_amount
          FROM transactions
          WHERE lawd_cd = ? AND year_month = ? AND deal_type = 'trade'`,
    args: ["11170", "202606"],
  });
  function nk(row: Record<string, unknown> | { aptName?: string; dealDate?: string; exclusiveArea?: number; floor?: number; dealAmount?: number }) {
    const r = row as Record<string, unknown>;
    const apt = String(r.aptName ?? r.apt_name ?? "");
    const date = String(r.dealDate ?? r.deal_date ?? "").slice(0, 10);
    const sqm = Number(r.exclusiveArea ?? r.exclusive_area ?? 0);
    const floor = Number(r.floor ?? 0);
    const amt = Number(r.dealAmount ?? r.deal_amount ?? 0);
    return `${apt}|${date}|${sqm}|${floor}|${amt}`;
  }
  const apiKeys = new Set([...apiUnique.values()].map((tx) => nk(tx)));
  const dbKeys = new Set(dbJune.rows.map((row) => nk(row)));
  const missing = [...apiUnique.values()].filter((tx) => !dbKeys.has(nk(tx)));
  const extra = dbJune.rows.filter((row) => !apiKeys.has(nk(row)));
  console.log({
    apiCount: api.length,
    apiUnique: apiUnique.size,
    dbCount: dbJune.rows.length,
    apiMiju: apiMiju.map((tx) => ({
      name: tx.aptName,
      date: tx.dealDate,
      sqm: tx.exclusiveArea,
      floor: tx.floor,
      amt: tx.dealAmount,
    })),
    missing: missing.map((tx) => ({
      name: tx.aptName,
      date: tx.dealDate,
      sqm: tx.exclusiveArea,
      floor: tx.floor,
      amt: tx.dealAmount,
    })),
    extraInDb: extra.length,
    expectedInserts: missing.length,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

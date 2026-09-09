/**
 * READ-only production QA for Seoul leader map (no writes).
 *   npx tsx scripts/qa-leader-map-readonly.ts
 */
import { createClient } from "@libsql/client";
import { SEOUL_REGIONS } from "../src/lib/constants/regions";
import {
  buildComplexStats,
  complexKeyOf,
  pickLeader,
  rankEligible,
  windowFromTo,
  yearMonthsInclusive,
  type ComplexLeaderStats,
  type LeaderTrade,
} from "../src/lib/leader-map/metrics";
import { seoulToday } from "../src/lib/market/time";

const QA_GUS = [
  "seoul-gangnam",
  "seoul-seocho",
  "seoul-songpa",
  "seoul-yongsan",
  "seoul-seongdong",
  "seoul-mapo",
  "seoul-nowon",
];

async function main() {
  const url = process.env.TURSO_DATABASE_URL?.trim() ?? "";
  if (!url || url.startsWith("file:")) throw new Error("need remote TURSO");
  const db = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN ?? "" });

  const to = seoulToday();
  const { from } = windowFromTo(to);
  const yearMonths = yearMonthsInclusive(from, to);
  const lawdCodes = SEOUL_REGIONS.map((r) => r.lawdCodes[0]!);
  const lawdPh = lawdCodes.map(() => "?").join(",");
  const ymPh = yearMonths.map(() => "?").join(",");

  const expl = await db.execute({
    sql: `EXPLAIN QUERY PLAN
          SELECT lawd_cd, apt_name_norm FROM transactions
          WHERE deal_type = 'trade'
            AND lawd_cd IN (${lawdPh})
            AND year_month IN (${ymPh})
            AND deal_amount > 0
            AND exclusive_area > 0`,
    args: [...lawdCodes, ...yearMonths],
  });
  console.log(
    JSON.stringify(
      {
        step: "explain",
        from,
        to,
        months: yearMonths.length,
        plan: expl.rows.map((r) => String(r.detail ?? JSON.stringify(r))),
      },
      null,
      2,
    ),
  );

  const t0 = Date.now();
  const result = await db.execute({
    sql: `SELECT lawd_cd, gu, dong, apt_name, apt_name_norm, deal_date,
                 deal_amount, exclusive_area, floor
          FROM transactions
          WHERE deal_type = 'trade'
            AND lawd_cd IN (${lawdPh})
            AND year_month IN (${ymPh})
            AND deal_amount > 0
            AND exclusive_area > 0`,
    args: [...lawdCodes, ...yearMonths],
  });
  const fetchMs = Date.now() - t0;

  const byComplex = new Map<string, { name: string; lawd: string; gu: string; dong: string; trades: LeaderTrade[] }>();
  for (const row of result.rows) {
    const dealDate = String(row.deal_date).slice(0, 10);
    if (dealDate < from || dealDate > to) continue;
    const lawd = String(row.lawd_cd);
    const dong = String(row.dong ?? "");
    const norm = String(row.apt_name_norm);
    const key = complexKeyOf(lawd, dong, norm);
    const trade: LeaderTrade = {
      dealDate: String(row.deal_date).slice(0, 10),
      dealAmount: Number(row.deal_amount) || 0,
      exclusiveArea: Number(row.exclusive_area) || 0,
      floor: Number(row.floor) || 0,
    };
    const prev = byComplex.get(key);
    if (prev) prev.trades.push(trade);
    else {
      byComplex.set(key, {
        name: String(row.apt_name),
        lawd,
        gu: String(row.gu ?? ""),
        dong,
        trades: [trade],
      });
    }
  }

  const complexes: ComplexLeaderStats[] = [];
  for (const [key, c] of byComplex) {
    const stats = buildComplexStats({
      complexKey: key,
      lawdCd: c.lawd,
      gu: c.gu,
      dong: c.dong,
      aptName: c.name,
      aptNameNorm: key.split("|")[2] ?? c.name,
      trades: c.trades,
    });
    if (stats) complexes.push(stats);
  }

  const byLawd = new Map<string, ComplexLeaderStats[]>();
  const byDong = new Map<string, number>();
  for (const c of complexes) {
    const list = byLawd.get(c.lawdCd) ?? [];
    list.push(c);
    byLawd.set(c.lawdCd, list);
    if (c.dong) byDong.set(`${c.lawdCd}|${c.dong}`, (byDong.get(`${c.lawdCd}|${c.dong}`) ?? 0) + 1);
  }

  const leaders = SEOUL_REGIONS.map((r) => {
    const picked = pickLeader(byLawd.get(r.lawdCodes[0]!) ?? []);
    return { slug: r.slug, name: r.name, leader: picked };
  });
  const found = leaders.filter((l) => l.leader).length;
  const dongLeaders = [...byDong.keys()].length;
  const eligible = rankEligible(complexes, 5);

  const qa: Record<string, unknown> = {};
  for (const slug of QA_GUS) {
    const region = SEOUL_REGIONS.find((r) => r.slug === slug);
    const picked = pickLeader(byLawd.get(region?.lawdCodes[0] ?? "") ?? []);
    qa[slug] = picked
      ? {
          apt: picked.aptName,
          dong: picked.dong,
          trades: picked.tradeCount12m,
          medianPyeong: picked.medianPyeongPrice,
          n84: picked.normalized84Price,
          latest: picked.latestDeal,
          quality: picked.sampleQuality,
        }
      : null;
  }

  const t1 = Date.now();
  const warm = await db.execute({
    sql: `SELECT lawd_cd, gu, dong, apt_name, apt_name_norm, deal_date,
                 deal_amount, exclusive_area, floor
          FROM transactions
          WHERE deal_type='trade' AND lawd_cd IN (${lawdPh})
            AND year_month IN (${ymPh})
            AND deal_amount > 0 AND exclusive_area > 0`,
    args: [...lawdCodes, ...yearMonths],
  });
  const warmMs = Date.now() - t1;

  console.log(
    JSON.stringify(
      {
        step: "summary",
        rows: result.rows.length,
        complexes: complexes.length,
        eligible5: eligible.length,
        guLeadersFound: found,
        dongGroups: dongLeaders,
        fetchMs,
        warmFetchMs: warmMs,
        warmRows: warm.rows.length,
        qa,
        top5: eligible.slice(0, 5).map((c) => ({
          apt: c.aptName,
          gu: c.gu,
          n84: c.normalized84Price,
          trades: c.tradeCount12m,
        })),
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

/**
 * READ-ONLY warehouse vs region API visibility audit.
 * No INSERT/UPDATE/DELETE. No MOLIT.
 *
 *   npx tsx scripts/audit-region-visibility-r2.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { getDb } from "../src/lib/db/client";
import { getRegion } from "../src/lib/constants/regions";
import { clearRegionDailyCaches, getRegionDaily } from "../src/lib/molit/service";
import { queryAptTransactions } from "../src/lib/db/repository";

const TARGETS: { slug: string; label: string; months: string[] }[] = [
  { slug: "seoul-gangnam", label: "강남구", months: ["202609", "202608", "202607"] },
  { slug: "seoul-songpa", label: "송파구", months: ["202609", "202608", "202607"] },
  { slug: "seoul-yongsan", label: "용산구", months: ["202609", "202608", "202607", "202606"] },
  { slug: "gyeonggi-seongnam", label: "성남시", months: ["202609", "202608", "202607"] },
  { slug: "gyeonggi-suwon", label: "수원시", months: ["202609", "202608", "202607"] },
];

async function countWarehouse(
  db: NonNullable<ReturnType<typeof getDb>>,
  lawdCodes: string[],
  ym: string,
  kind: "trade" | "rent",
) {
  const ph = lawdCodes.map(() => "?").join(",");
  const rows = await db.execute({
    sql: `SELECT COUNT(*) AS n,
                 SUM(CASE WHEN dealing_gbn = '취소' THEN 1 ELSE 0 END) AS cancelled,
                 MIN(deal_date) AS min_d,
                 MAX(deal_date) AS max_d
          FROM transactions
          WHERE lawd_cd IN (${ph}) AND year_month = ? AND deal_type = ?`,
    args: [...lawdCodes, ym, kind],
  });
  const r = rows.rows[0];
  return {
    n: Number(r?.n ?? 0),
    cancelled: Number(r?.cancelled ?? 0),
    min: r?.min_d == null ? null : String(r.min_d),
    max: r?.max_d == null ? null : String(r.max_d),
  };
}

async function main() {
  const db = getDb();
  if (!db) throw new Error("no db");
  clearRegionDailyCaches();

  const discovery = await db.execute(
    `SELECT COUNT(*) AS n,
            MIN(discovery_at) AS min_d,
            MAX(discovery_at) AS max_d
     FROM transactions
     WHERE discovery_at IS NOT NULL AND discovery_at != ''`,
  );
  const discoveryToday = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM transactions
          WHERE discovery_at IS NOT NULL AND discovery_at != ''
            AND date(discovery_at, '+9 hours') = date('now', '+9 hours')`,
  });

  const out: Record<string, unknown> = {
    discovery_nn: Number(discovery.rows[0]?.n ?? 0),
    discovery_min: discovery.rows[0]?.min_d,
    discovery_max: discovery.rows[0]?.max_d,
    discovery_today_kst: Number(discoveryToday.rows[0]?.n ?? 0),
    regions: [] as unknown[],
    fail_db_gt0_ui_eq0: [] as string[],
  };

  for (const target of TARGETS) {
    const region = getRegion(target.slug);
    if (!region) throw new Error(target.slug);
    const latest = await getRegionDaily({ regionSlug: target.slug, part: "latest" });
    const months: Record<string, unknown> = {};
    for (const ym of target.months) {
      const trade = await countWarehouse(db, [...region.lawdCodes], ym, "trade");
      const rent = await countWarehouse(db, [...region.lawdCodes], ym, "rent");
      const market = await getRegionDaily({
        regionSlug: target.slug,
        part: "market",
        contractMonth: ym,
      });
      const history = await getRegionDaily({
        regionSlug: target.slug,
        part: "history",
        yearMonth: ym,
      });
      const row = {
        trade_wh: trade.n,
        rent_wh: rent.n,
        trade_min: trade.min,
        trade_max: trade.max,
        section1: market.monthTradeCount,
        section3_total: history.historyTotalCount,
        section3_days: history.days.length,
        activity_has_month: latest.activityYearMonths.includes(ym),
        contract_has_month: (market.contractMonthOptions ?? []).includes(ym),
      };
      months[ym] = row;
      if (trade.n > 0 && history.historyTotalCount === 0) {
        (out.fail_db_gt0_ui_eq0 as string[]).push(`${target.slug}:${ym}`);
      }
    }
    (out.regions as unknown[]).push({
      slug: target.slug,
      label: target.label,
      lawds: region.lawdCodes,
      activityYearMonthsHead: latest.activityYearMonths.slice(0, 8),
      section2_selected: latest.selectedDate,
      section2_count: latest.tradeCount,
      months,
    });
  }

  const mijub = await queryAptTransactions({
    lawdCodes: ["11170"],
    aptName: "미주B",
    yearMonths: ["202606", "202607", "202608", "202609"],
    dealKinds: ["trade"],
  });
  out.mijub = mijub.map((t) => ({
    dealDate: t.dealDate,
    amount: t.dealAmount,
    area: t.exclusiveArea,
    floor: t.floor,
  }));

  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

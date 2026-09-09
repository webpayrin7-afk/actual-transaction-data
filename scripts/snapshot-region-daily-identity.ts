/**
 * Identity snapshot for region-daily 신고가 / KPI / calendar.
 * READ ONLY. Used to diff before/after perf work.
 *   npx tsx scripts/snapshot-region-daily-identity.ts > /tmp/region-identity.json
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { clearRegionDailyCaches, getRegionDaily } from "../src/lib/molit/service";

const CASES = [
  ["gyeonggi-seongnam", "202608"],
  ["gyeonggi-seongnam", "202607"],
  ["gyeonggi-seongnam", "202609"],
  ["seoul-yongsan", "202608"],
  ["seoul-yongsan", "202609"],
  ["gyeonggi-suwon", "202608"],
  ["gyeonggi-suwon", "202609"],
  ["seoul-gangnam", "202608"],
  ["seoul-gangnam", "202609"],
] as const;

function dealIdentity(deal: {
  id: string;
  aptName: string;
  exclusiveArea: number;
  dealDate: string;
  dealAmount: number;
  singogaKind: string | null;
  increaseAmount: number;
  typeMaxAmount: number;
}) {
  return {
    id: deal.id,
    aptName: deal.aptName,
    exclusiveArea: deal.exclusiveArea,
    dealDate: deal.dealDate,
    dealAmount: deal.dealAmount,
    singogaKind: deal.singogaKind,
    increaseAmount: deal.increaseAmount,
    typeMaxAmount: deal.typeMaxAmount,
    priorMax: deal.dealAmount - (deal.increaseAmount || 0),
  };
}

async function main() {
  clearRegionDailyCaches();
  const out: Record<string, unknown> = {};
  for (const [slug, ym] of CASES) {
    const market = await getRegionDaily({
      regionSlug: slug,
      part: "market",
      contractMonth: ym,
    });
    const latest = await getRegionDaily({
      regionSlug: slug,
      part: "latest",
      contractMonth: ym,
    });
    const history = await getRegionDaily({
      regionSlug: slug,
      part: "history",
      yearMonth: ym,
    });
    out[`${slug}:${ym}`] = {
      kpi: {
        monthTradeCount: market.monthTradeCount,
        prevMonthTradeCount: market.prevMonthTradeCount,
        yearAgoMonthTradeCount: market.yearAgoMonthTradeCount,
        monthSingogaCount: market.monthSingogaCount,
        medianPyeongPrice: market.medianPyeongPrice,
        contractYearMonth: market.contractYearMonth,
      },
      latest: {
        selectedDate: latest.selectedDate,
        tradeCount: latest.tradeCount,
        selectedDaySingogaCount: latest.selectedDaySingogaCount,
        bulkIngestDay: latest.bulkIngestDay,
        deals: latest.deals.map(dealIdentity),
      },
      history: {
        historyTotalCount: history.historyTotalCount,
        days: history.days.map((d) => ({
          date: d.date,
          dealCount: d.dealCount,
        })),
        activityYearMonths: history.activityYearMonths,
        contractMonthOptions: market.contractMonthOptions,
      },
    };
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

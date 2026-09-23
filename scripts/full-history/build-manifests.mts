/**
 * Build SALE / RENT full-history manifests (missing-only, temporal lawd aware).
 *
 *   npx tsx scripts/full-history/build-manifests.mts
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });
config({ quiet: true });

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@libsql/client";
import {
  metroFromLawdNationwide,
  type NationwideMetro,
} from "../../src/lib/constants/nationwide-lawd";
import { runnableAptTradeRequestLawds } from "../../src/lib/molit/aptrade-lawd-mapping";
import {
  APTRENT_FULL_HISTORY_EARLIEST_YM,
  APTTRADE_FULL_HISTORY_EARLIEST_YM,
  APTTRADE_REGISTRATION_BASELINE_FROM_YM,
  currentContractYearMonth,
  rentFullHistoryMonths,
  saleFullHistoryMonths,
  salePre2023Months,
} from "../../src/lib/molit/full-history-range";
import type { ManifestCell } from "../../src/lib/molit/full-history-shared";
import { FULL_HISTORY_OUT as OUT } from "../../src/lib/molit/full-history-shared";
import {
  incheonTrueNodataLawds,
  planAptTradeRequestLawd,
} from "../../src/lib/molit/temporal-lawd";

export type { ManifestCell, CellStatus } from "../../src/lib/molit/full-history-shared";

function capitalMetro(m: NationwideMetro): boolean {
  return m === "seoul" || m === "gyeonggi";
}

function priorityFor(cell: {
  source: "SALE" | "RENT";
  metro: NationwideMetro;
  yearMonth: string;
}): 0 | 1 | 2 | 3 {
  const cap = capitalMetro(cell.metro);
  if (cell.source === "RENT" && cap) return 0;
  if (
    cell.source === "SALE" &&
    cap &&
    cell.yearMonth < APTTRADE_REGISTRATION_BASELINE_FROM_YM
  ) {
    return 1;
  }
  if (cell.source === "RENT") return 2;
  return 3;
}

function summarize(cells: ManifestCell[]) {
  const byStatus: Record<string, number> = {};
  const byPriority: Record<string, number> = {};
  let ready = 0;
  let complete = 0;
  let nodata = 0;
  for (const c of cells) {
    byStatus[c.rowStatus] = (byStatus[c.rowStatus] ?? 0) + 1;
    byPriority[String(c.priority)] = (byPriority[String(c.priority)] ?? 0) + 1;
    if (c.rowStatus === "READY") ready += 1;
    if (c.rowStatus === "COMPLETE") complete += 1;
    if (c.rowStatus === "NODATA_CONFIRMED") nodata += 1;
  }
  return {
    expected: cells.length,
    complete,
    ready,
    nodata,
    byStatus,
    byPriority,
  };
}

function sortCells(cells: ManifestCell[]) {
  return [...cells].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.metro !== b.metro) return a.metro.localeCompare(b.metro);
    if (a.yearMonth !== b.yearMonth) return a.yearMonth.localeCompare(b.yearMonth);
    return a.requestLawd.localeCompare(b.requestLawd);
  });
}

async function main() {
  const asOf = new Date();
  const currentYm = currentContractYearMonth(asOf);
  const saleMonths = saleFullHistoryMonths(asOf);
  const rentMonths = rentFullHistoryMonths(asOf);
  const pre2023 = salePre2023Months(asOf);

  const requestLawds = runnableAptTradeRequestLawds();
  const trueNodata = new Set(incheonTrueNodataLawds());

  const db = createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN!,
  });

  const syncRows = await db.execute({
    sql: `SELECT lawd_cd AS l, year_month AS ym, deal_kind AS k, row_count AS rc
          FROM sync_months
          WHERE year_month >= ? AND year_month <= ?`,
    args: [APTTRADE_FULL_HISTORY_EARLIEST_YM, currentYm],
  });
  const sync = new Map<string, number>();
  for (const r of syncRows.rows) {
    sync.set(`${r.k}|${r.l}|${r.ym}`, Number(r.rc ?? 0));
  }

  const saleMap = new Map<string, ManifestCell>();
  for (const lawd of requestLawds) {
    const metro = metroFromLawdNationwide(lawd);
    for (const yearMonth of saleMonths) {
      const requestLawd = planAptTradeRequestLawd(lawd, yearMonth);
      const mapKey = `${requestLawd}|${yearMonth}`;
      if (saleMap.has(mapKey)) continue;

      const syncKey = `trade|${requestLawd}|${yearMonth}`;
      if (trueNodata.has(requestLawd) || trueNodata.has(lawd)) {
        saleMap.set(mapKey, {
          source: "SALE",
          dealKind: "trade",
          lawd: requestLawd,
          yearMonth,
          requestLawd,
          canonicalGeography: requestLawd,
          metro,
          existingSyncState: sync.has(syncKey) ? "present" : "absent",
          rowStatus: "NODATA_CONFIRMED",
          requiredAction: "HOLD",
          attempt: 0,
          priority: priorityFor({ source: "SALE", metro, yearMonth }),
        });
        continue;
      }

      const present = sync.has(syncKey);
      saleMap.set(mapKey, {
        source: "SALE",
        dealKind: "trade",
        lawd: requestLawd,
        yearMonth,
        requestLawd,
        canonicalGeography: requestLawd,
        metro,
        existingSyncState: present ? "present" : "absent",
        rowStatus: present ? "COMPLETE" : "READY",
        requiredAction: present ? "SKIP" : "FETCH",
        attempt: 0,
        priority: priorityFor({ source: "SALE", metro, yearMonth }),
      });
    }
  }

  const rentMap = new Map<string, ManifestCell>();
  for (const lawd of requestLawds) {
    const metro = metroFromLawdNationwide(lawd);
    for (const yearMonth of rentMonths) {
      const requestLawd = planAptTradeRequestLawd(lawd, yearMonth);
      const mapKey = `${requestLawd}|${yearMonth}`;
      if (rentMap.has(mapKey)) continue;

      const syncKey = `rent|${requestLawd}|${yearMonth}`;
      if (trueNodata.has(requestLawd) || trueNodata.has(lawd)) {
        rentMap.set(mapKey, {
          source: "RENT",
          dealKind: "rent",
          lawd: requestLawd,
          yearMonth,
          requestLawd,
          canonicalGeography: requestLawd,
          metro,
          existingSyncState: sync.has(syncKey) ? "present" : "absent",
          rowStatus: "NODATA_CONFIRMED",
          requiredAction: "HOLD",
          attempt: 0,
          priority: priorityFor({ source: "RENT", metro, yearMonth }),
        });
        continue;
      }

      const present = sync.has(syncKey);
      rentMap.set(mapKey, {
        source: "RENT",
        dealKind: "rent",
        lawd: requestLawd,
        yearMonth,
        requestLawd,
        canonicalGeography: requestLawd,
        metro,
        existingSyncState: present ? "present" : "absent",
        rowStatus: present ? "COMPLETE" : "READY",
        requiredAction: present ? "SKIP" : "FETCH",
        attempt: 0,
        priority: priorityFor({ source: "RENT", metro, yearMonth }),
      });
    }
  }

  const saleSorted = sortCells([...saleMap.values()]);
  const rentSorted = sortCells([...rentMap.values()]);

  mkdirSync(OUT, { recursive: true });
  const salePath = resolve(OUT, "manifest-sale.json");
  const rentPath = resolve(OUT, "manifest-rent.json");
  const summaryPath = resolve(OUT, "manifest-summary.json");

  writeFileSync(salePath, JSON.stringify(saleSorted));
  writeFileSync(rentPath, JSON.stringify(rentSorted));

  const salePre2023Missing = saleSorted.filter(
    (c) =>
      c.yearMonth < APTTRADE_REGISTRATION_BASELINE_FROM_YM &&
      c.requiredAction === "FETCH",
  ).length;

  const summary = {
    builtAt: new Date().toISOString(),
    sourceRange: {
      SALE: {
        earliest: APTTRADE_FULL_HISTORY_EARLIEST_YM,
        current: currentYm,
        months: saleMonths.length,
        pre2023Months: pre2023.length,
      },
      RENT: {
        earliest: APTRENT_FULL_HISTORY_EARLIEST_YM,
        current: currentYm,
        months: rentMonths.length,
      },
    },
    requestLawds: requestLawds.length,
    trueNodataLawds: [...trueNodata],
    SALE: {
      ...summarize(saleSorted),
      historicalPre2023Missing: salePre2023Missing,
      baseline2023Complete: saleSorted.filter(
        (c) =>
          c.yearMonth >= APTTRADE_REGISTRATION_BASELINE_FROM_YM &&
          c.rowStatus === "COMPLETE",
      ).length,
    },
    RENT: summarize(rentSorted),
    paths: { sale: salePath, rent: rentPath },
  };
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

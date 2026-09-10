/**
 * Historical warehouse gap repair (pagination + missing MOLIT lawds).
 *
 * Always classifies first. WRITE only with --execute=1.
 * discovery=0, skipDelete=1, max-writes kill switch before SQL.
 *
 *   npx tsx scripts/repair-warehouse-gaps.ts --target=rent --mode=dry-run
 *   npx tsx scripts/repair-warehouse-gaps.ts --target=trade-risk --mode=dry-run
 *   npx tsx scripts/repair-warehouse-gaps.ts --target=missing --mode=dry-run
 *   npx tsx scripts/repair-warehouse-gaps.ts --target=all --mode=execute --max-writes=5000000
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { writeFileSync } from "node:fs";
import {
  allCapitalLawdCodes,
  districtNameFromCode,
  LAWD_TO_REGION,
} from "../src/lib/constants/regions-registry";
import { getDb } from "../src/lib/db/client";
import { TRUSTED_DISCOVERY_COPY } from "../src/lib/db/discovery-axis";
import { replaceMonthTransactions } from "../src/lib/db/repository";
import {
  fetchMonthMeta,
  fetchOneRentForSync,
  fetchOneTradeForSync,
} from "../src/lib/molit/client";
import type { DealType } from "../src/types/transaction";

function argValue(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function yearMonthsBetween(fromYm: string, toYm: string): string[] {
  const out: string[] = [];
  let y = Number(fromYm.slice(0, 4));
  let m = Number(fromYm.slice(4, 6));
  const ty = Number(toYm.slice(0, 4));
  const tm = Number(toYm.slice(4, 6));
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
    if (out.length > 240) break;
  }
  return out;
}

type Job = { lawdCd: string; yearMonth: string; kind: DealType };

type CellReport = {
  key: string;
  lawdCd: string;
  name: string;
  yearMonth: string;
  kind: DealType;
  sourceTotalCount: number;
  sourcePages: number;
  sourceRows: number;
  warehouseRows: number;
  inserted: number;
  updated: number;
  unchanged: number;
  extras: number;
  truncatedLikely: boolean;
};

async function warehouseCount(
  db: NonNullable<ReturnType<typeof getDb>>,
  job: Job,
): Promise<number> {
  const r = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM transactions
          WHERE lawd_cd = ? AND year_month = ? AND deal_type = ?`,
    args: [job.lawdCd, job.yearMonth, job.kind],
  });
  return Number(r.rows[0]?.n) || 0;
}

async function discoverySnapshot(db: NonNullable<ReturnType<typeof getDb>>) {
  const r = await db.execute(`
    SELECT
      SUM(CASE WHEN discovery_at IS NOT NULL AND discovery_at != '' THEN 1 ELSE 0 END) AS nn,
      SUM(CASE WHEN discovery_at >= '${TRUSTED_DISCOVERY_COPY.fromInclusive}'
                AND discovery_at <  '${TRUSTED_DISCOVERY_COPY.toExclusive}' THEN 1 ELSE 0 END) AS trusted,
      SUM(CASE WHEN discovery_at >= '2026-09-08T15:00:00.000Z'
                AND discovery_at <  '2026-09-09T15:00:00.000Z' THEN 1 ELSE 0 END) AS kst_today_window
    FROM transactions
  `);
  return {
    nonNull: Number(r.rows[0]?.nn) || 0,
    trusted: Number(r.rows[0]?.trusted) || 0,
    kstTodayWindow: Number(r.rows[0]?.kst_today_window) || 0,
  };
}

async function mapPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  async function run() {
    while (true) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      await worker(items[i]!, i);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(items.length, 1)) }, () =>
      run(),
    ),
  );
}

async function main() {
  const target = argValue("target", "rent"); // rent | trade-risk | missing | all
  const mode = argValue("mode", "dry-run"); // dry-run | execute
  const execute = mode === "execute" || argValue("execute", "0") === "1";
  const maxWrites = Math.max(0, Number(argValue("max-writes", "5000000")) || 0);
  const concurrency = Math.min(4, Math.max(1, Number(argValue("concurrency", "2")) || 2));
  const discovery = false;
  const skipDelete = true;

  const db = getDb();
  if (!db) throw new Error("no db");

  const capital = allCapitalLawdCodes();
  const tradeYms = yearMonthsBetween("201610", "202609");
  const rentYms = yearMonthsBetween("202210", "202609");

  const warehouseLawds = await db.execute(
    `SELECT lawd_cd, SUM(CASE WHEN deal_type='trade' THEN 1 ELSE 0 END) AS trade_n,
            SUM(CASE WHEN deal_type='rent' THEN 1 ELSE 0 END) AS rent_n
     FROM transactions GROUP BY lawd_cd`,
  );
  const whLawd = new Map<string, { trade: number; rent: number }>();
  for (const row of warehouseLawds.rows) {
    whLawd.set(String(row.lawd_cd), {
      trade: Number(row.trade_n) || 0,
      rent: Number(row.rent_n) || 0,
    });
  }
  const missingLawds = capital.filter((c) => {
    const hit = whLawd.get(c);
    return !hit || hit.trade + hit.rent === 0;
  });

  const tradeRiskRows = await db.execute(`
    SELECT lawd_cd, year_month, COUNT(*) AS n
    FROM transactions
    WHERE deal_type='trade' AND year_month >= '201610' AND year_month <= '202609'
    GROUP BY lawd_cd, year_month
    HAVING n >= 850
  `);

  const jobs: Job[] = [];
  const wantRent = target === "rent" || target === "all";
  const wantTrade = target === "trade-risk" || target === "all";
  const wantMissing = target === "missing" || target === "all";

  if (wantRent) {
    for (const lawdCd of capital) {
      for (const yearMonth of rentYms) {
        jobs.push({ lawdCd, yearMonth, kind: "rent" });
      }
    }
  }
  if (wantTrade) {
    const seen = new Set<string>();
    for (const row of tradeRiskRows.rows) {
      const job: Job = {
        lawdCd: String(row.lawd_cd),
        yearMonth: String(row.year_month),
        kind: "trade",
      };
      const key = `${job.lawdCd}|${job.yearMonth}|trade`;
      if (seen.has(key)) continue;
      seen.add(key);
      jobs.push(job);
    }
    // 성남분당 202509 known even if warehouse drifted below 850
    const bundang: Job = { lawdCd: "41135", yearMonth: "202509", kind: "trade" };
    const bKey = "41135|202509|trade";
    if (!seen.has(bKey)) jobs.push(bundang);
  }
  if (wantMissing) {
    const seen = new Set(jobs.map((j) => `${j.lawdCd}|${j.yearMonth}|${j.kind}`));
    for (const lawdCd of missingLawds) {
      for (const yearMonth of tradeYms) {
        const key = `${lawdCd}|${yearMonth}|trade`;
        if (!seen.has(key)) {
          jobs.push({ lawdCd, yearMonth, kind: "trade" });
          seen.add(key);
        }
      }
      for (const yearMonth of rentYms) {
        const key = `${lawdCd}|${yearMonth}|rent`;
        if (!seen.has(key)) {
          jobs.push({ lawdCd, yearMonth, kind: "rent" });
          seen.add(key);
        }
      }
    }
  }

  const discBefore = await discoverySnapshot(db);
  console.log(
    JSON.stringify({
      phase: "start",
      target,
      execute,
      discovery: 0,
      skipDelete: 1,
      maxWrites,
      capitalLawds: capital.length,
      missingLawds: missingLawds.map((c) => ({
        code: c,
        name: districtNameFromCode(c),
        region: LAWD_TO_REGION[c]?.slug,
      })),
      jobs: jobs.length,
      discoveryBefore: discBefore,
    }),
  );

  const totals = {
    cells: 0,
    http: 0,
    sourceRows: 0,
    warehouseRows: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    extras: 0,
    failures: 0,
    writtenCells: 0,
  };
  const failed: string[] = [];
  const affected: CellReport[] = [];
  const startedAt = Date.now();
  let stop = false;

  await mapPool(jobs, concurrency, async (job, index) => {
    if (stop) return;
    const key = `${job.lawdCd}|${job.yearMonth}|${job.kind}`;
    try {
      const warehouseRows = await warehouseCount(db, job);
      const meta = await fetchMonthMeta(job.kind, job.lawdCd, job.yearMonth);
      totals.http += 1;
      const needFull =
        job.kind === "rent" ||
        meta.pagesNeeded > 1 ||
        meta.totalCount > warehouseRows ||
        (warehouseRows === 0 && meta.totalCount > 0) ||
        warehouseRows >= 850;
      const items = needFull
        ? job.kind === "rent"
          ? await fetchOneRentForSync(job.lawdCd, job.yearMonth)
          : await fetchOneTradeForSync(job.lawdCd, job.yearMonth)
        : [];
      if (needFull) {
        totals.http += Math.max(0, meta.pagesNeeded - 1);
      }
      const sourceRows = needFull ? items.length : meta.page1Count;
      const preview = needFull
        ? await replaceMonthTransactions({
            lawdCd: job.lawdCd,
            yearMonth: job.yearMonth,
            dealKind: job.kind,
            items,
            setFirstSeenOnInsert: discovery,
            dryRun: true,
            skipDelete,
          })
        : {
            inserted: 0,
            updated: 0,
            unchanged: warehouseRows,
            deleted: 0,
            wrote: false,
            rowCount: warehouseRows,
          };

      const cellWrites = preview.inserted + preview.updated;
      totals.cells += 1;
      totals.sourceRows += sourceRows;
      totals.warehouseRows += warehouseRows;
      totals.inserted += preview.inserted;
      totals.updated += preview.updated;
      totals.unchanged += preview.unchanged;
      totals.extras += preview.deleted;

      const truncatedLikely =
        warehouseRows <= 1000 &&
        meta.totalCount > 1000 &&
        preview.inserted > 0;

      if (preview.inserted + preview.updated + preview.deleted > 0 || truncatedLikely) {
        affected.push({
          key,
          lawdCd: job.lawdCd,
          name: districtNameFromCode(job.lawdCd),
          yearMonth: job.yearMonth,
          kind: job.kind,
          sourceTotalCount: meta.totalCount,
          sourcePages: meta.pagesNeeded,
          sourceRows,
          warehouseRows,
          inserted: preview.inserted,
          updated: preview.updated,
          unchanged: preview.unchanged,
          extras: preview.deleted,
          truncatedLikely,
        });
      }

      if (execute && cellWrites > 0) {
        if (maxWrites > 0 && totals.inserted + totals.updated > maxWrites) {
          stop = true;
          console.error(`[repair] WRITE KILL SWITCH before SQL at ${key}`);
          return;
        }
        const written = await replaceMonthTransactions({
          lawdCd: job.lawdCd,
          yearMonth: job.yearMonth,
          dealKind: job.kind,
          items,
          setFirstSeenOnInsert: discovery,
          dryRun: false,
          skipDelete,
        });
        if (written.wrote) totals.writtenCells += 1;
      }

      if ((index + 1) % 25 === 0 || index + 1 === jobs.length) {
        const elapsed = ((Date.now() - startedAt) / 60000).toFixed(1);
        console.log(
          `[repair] progress ${index + 1}/${jobs.length} cells=${totals.cells} http=${totals.http} ins=${totals.inserted} upd=${totals.updated} extra=${totals.extras} unchanged=${totals.unchanged} fail=${totals.failures} elapsed=${elapsed}m`,
        );
      }
    } catch (err) {
      totals.failures += 1;
      failed.push(key);
      console.warn(
        `[repair] fail ${key}`,
        err instanceof Error ? err.message : err,
      );
    }
  });

  const discAfter = await discoverySnapshot(db);
  const summary = {
    target,
    execute,
    discovery: 0,
    skipDelete: 1,
    maxWrites,
    capitalLawds: capital.length,
    missingLawds,
    cellsScanned: totals.cells,
    http: totals.http,
    sourceRows: totals.sourceRows,
    warehouseRows: totals.warehouseRows,
    expectedInsert: totals.inserted,
    expectedUpdate: totals.updated,
    extrasNotDeleted: totals.extras,
    unchanged: totals.unchanged,
    failures: totals.failures,
    failed: failed.slice(0, 40),
    writtenCells: totals.writtenCells,
    affectedCells: affected.length,
    affectedLawds: [...new Set(affected.map((a) => a.lawdCd))].length,
    affectedMonths: [...new Set(affected.map((a) => a.yearMonth))].length,
    truncatedCells: affected.filter((a) => a.truncatedLikely).length,
    discoveryBefore: discBefore,
    discoveryAfter: discAfter,
    pollution:
      discAfter.nonNull > discBefore.nonNull ||
      discAfter.trusted !== discBefore.trusted
        ? "FAIL"
        : "PASS",
    durationSec: Math.round((Date.now() - startedAt) / 1000),
  };

  const outPath = `/tmp/repair-${target}-${execute ? "exec" : "dry"}.json`;
  writeFileSync(
    outPath,
    JSON.stringify({ summary, affected: affected.slice(0, 2000) }, null, 2),
  );
  console.log(JSON.stringify({ summary, report: outPath }, null, 2));

  if (stop) process.exit(2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * MOLIT → Turso/SQLite 웨어하우스 적재
 *
 * 사용 예:
 *   # 미적재분만 (백필)
 *   npx tsx scripts/sync-molit.ts --scope=all --trade-months=120 --rent-months=48 --skip-existing=1
 *
 *   # 최근 개월 변경분만 DB 기록 (기본 운영)
 *   npx tsx scripts/sync-molit.ts --scope=all --trade-months=2 --rent-months=2 --skip-existing=0 --only-changed=1
 *
 * 신선도: Actions가 probe 후 이 스크립트를 only-changed 로 돌려
 * 국토부 응답이 DB와 같을 때는 write를 건너뛴다.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { resolve } from "node:path";
import {
  FEATURED_LAWD_CODES,
  ALL_REGIONS,
} from "../src/lib/constants/regions-registry";
import { ensureSchema, getDb } from "../src/lib/db/client";
import {
  replaceMonthTransactions,
  rebuildAptCatalog,
} from "../src/lib/db/repository";
import {
  fetchOneTradeForSync,
  fetchOneRentForSync,
} from "../src/lib/molit/client";
import { recentYearMonths } from "../src/lib/utils/format";
import type { DealType, Transaction } from "../src/types/transaction";

function argValue(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function expandFeatured(): string[] {
  const featured = new Set<string>(FEATURED_LAWD_CODES);
  const codes = new Set<string>();
  for (const region of ALL_REGIONS) {
    if (region.lawdCodes.some((c) => featured.has(c))) {
      for (const c of region.lawdCodes) codes.add(c);
    }
  }
  return [...codes];
}

function allLawdCodes(): string[] {
  return [...new Set(ALL_REGIONS.flatMap((r) => r.lawdCodes))];
}

function maxDealDate(items: Transaction[]): string {
  let max = "";
  for (const tx of items) {
    if (tx.dealDate > max) max = tx.dealDate;
  }
  return max;
}

type DbSnap = { rowCount: number; maxDealDate: string };

async function loadDbSnapshots(
  db: NonNullable<ReturnType<typeof getDb>>,
  yearMonths: string[],
): Promise<Map<string, DbSnap>> {
  const map = new Map<string, DbSnap>();
  if (!yearMonths.length) return map;

  const ymPlaceholders = yearMonths.map(() => "?").join(",");
  const sync = await db.execute({
    sql: `SELECT lawd_cd, year_month, deal_kind, row_count
          FROM sync_months
          WHERE year_month IN (${ymPlaceholders})`,
    args: [...yearMonths],
  });
  for (const row of sync.rows) {
    map.set(`${row.lawd_cd}|${row.year_month}|${row.deal_kind}`, {
      rowCount: Number(row.row_count) || 0,
      maxDealDate: "",
    });
  }

  const maxes = await db.execute({
    sql: `SELECT lawd_cd, year_month, deal_type AS deal_kind, MAX(deal_date) AS max_deal_date
          FROM transactions
          WHERE year_month IN (${ymPlaceholders})
          GROUP BY lawd_cd, year_month, deal_type`,
    args: [...yearMonths],
  });
  for (const row of maxes.rows) {
    const key = `${row.lawd_cd}|${row.year_month}|${row.deal_kind}`;
    const prev = map.get(key) ?? { rowCount: 0, maxDealDate: "" };
    prev.maxDealDate = String(row.max_deal_date ?? "");
    map.set(key, prev);
  }
  return map;
}

function isUnchanged(
  snap: DbSnap | undefined,
  items: Transaction[],
): boolean {
  if (!snap) return false;
  const apiMax = maxDealDate(items);
  return snap.rowCount === items.length && snap.maxDealDate === apiMax;
}

async function main() {
  const scope = argValue("scope", "featured"); // featured | all | anyang | codes
  const tradeMonths = Number(argValue("trade-months", "120"));
  const rentMonths = Number(argValue("rent-months", "48"));
  const concurrency = Number(argValue("concurrency", "4"));
  const codesArg = argValue("codes", "");
  const skipExisting = argValue("skip-existing", "1") !== "0";
  // 운영 기본: API는 조회하되 DB write는 변경된 월만
  const onlyChanged = argValue("only-changed", skipExisting ? "0" : "1") !== "0";
  const rebuildCatalog = argValue("rebuild-catalog", "1") !== "0";

  if (!process.env.TURSO_DATABASE_URL) {
    process.env.TURSO_DATABASE_URL = `file:${resolve("data/molit.db")}`;
  }
  process.env.MOLIT_SYNCING = "1";

  const db = getDb();
  if (!db) {
    console.error("DB client unavailable. Set TURSO_DATABASE_URL.");
    process.exit(1);
  }
  await ensureSchema(db);

  let lawdCodes: string[];
  if (codesArg) {
    lawdCodes = codesArg.split(",").map((s) => s.trim()).filter(Boolean);
  } else if (scope === "all") {
    lawdCodes = allLawdCodes();
  } else if (scope === "anyang") {
    lawdCodes = ["41171", "41173"];
  } else {
    lawdCodes = expandFeatured();
  }

  const tradeYms = recentYearMonths(Math.min(Math.max(tradeMonths, 1), 240));
  const rentYms = recentYearMonths(Math.min(Math.max(rentMonths, 0), 240));

  type Job = {
    lawdCd: string;
    yearMonth: string;
    kind: DealType;
  };
  let jobs: Job[] = [];
  for (const lawdCd of lawdCodes) {
    for (const yearMonth of tradeYms) {
      jobs.push({ lawdCd, yearMonth, kind: "trade" });
    }
    for (const yearMonth of rentYms) {
      jobs.push({ lawdCd, yearMonth, kind: "rent" });
    }
  }

  let skippedExisting = 0;
  if (skipExisting && jobs.length > 0) {
    const existing = await db.execute(
      `SELECT lawd_cd, year_month, deal_kind FROM sync_months`,
    );
    const have = new Set(
      existing.rows.map(
        (r) => `${r.lawd_cd}|${r.year_month}|${r.deal_kind}`,
      ),
    );
    const before = jobs.length;
    jobs = jobs.filter(
      (j) => !have.has(`${j.lawdCd}|${j.yearMonth}|${j.kind}`),
    );
    skippedExisting = before - jobs.length;
  }

  const snapshots = onlyChanged
    ? await loadDbSnapshots(db, [...new Set([...tradeYms, ...rentYms])])
    : null;

  console.log(
    `[sync] lawds=${lawdCodes.length} jobs=${jobs.length} skippedExisting=${skippedExisting} onlyChanged=${onlyChanged ? 1 : 0} tradeMonths=${tradeYms.length} rentMonths=${rentYms.length}`,
  );

  if (jobs.length === 0) {
    console.log("[sync] nothing to do");
    return;
  }

  let done = 0;
  let rows = 0;
  let written = 0;
  let unchanged = 0;
  let failures = 0;
  let next = 0;
  const startedAt = Date.now();

  async function worker() {
    while (next < jobs.length) {
      const index = next;
      next += 1;
      const job = jobs[index];
      const key = `${job.lawdCd}|${job.yearMonth}|${job.kind}`;
      try {
        const items =
          job.kind === "trade"
            ? await fetchOneTradeForSync(job.lawdCd, job.yearMonth)
            : await fetchOneRentForSync(job.lawdCd, job.yearMonth);

        if (onlyChanged && isUnchanged(snapshots?.get(key), items)) {
          unchanged += 1;
        } else {
          await replaceMonthTransactions({
            lawdCd: job.lawdCd,
            yearMonth: job.yearMonth,
            dealKind: job.kind,
            items,
          });
          written += 1;
          rows += items.length;
          if (snapshots) {
            snapshots.set(key, {
              rowCount: items.length,
              maxDealDate: maxDealDate(items),
            });
          }
        }
      } catch (err) {
        failures += 1;
        console.warn(
          `[sync] fail ${job.kind} ${job.lawdCd} ${job.yearMonth}:`,
          err instanceof Error ? err.message : err,
        );
      } finally {
        done += 1;
        if (done % 25 === 0 || done === jobs.length) {
          const elapsedMin = ((Date.now() - startedAt) / 60000).toFixed(1);
          const rate = done / Math.max((Date.now() - startedAt) / 1000, 1);
          const etaMin = (
            (jobs.length - done) /
            Math.max(rate, 0.01) /
            60
          ).toFixed(0);
          console.log(
            `[sync] progress ${done}/${jobs.length} written=${written} unchanged=${unchanged} rows=${rows} failures=${failures} elapsed=${elapsedMin}m eta~${etaMin}m`,
          );
        }
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker()),
  );

  console.log(
    `[sync] done jobs=${done} written=${written} unchanged=${unchanged} rows=${rows} failures=${failures} skippedExisting=${skippedExisting} db=${process.env.TURSO_DATABASE_URL}`,
  );

  if (rebuildCatalog && written > 0) {
    try {
      const catalogSize = await rebuildAptCatalog();
      console.log(`[sync] apt_catalog rebuilt entries=${catalogSize}`);
    } catch (err) {
      console.warn("[sync] apt_catalog rebuild failed:", err);
    }
  } else if (written === 0) {
    console.log("[sync] apt_catalog rebuild skipped (no writes)");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

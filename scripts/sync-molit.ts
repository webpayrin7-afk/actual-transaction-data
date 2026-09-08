/**
 * MOLIT → Turso/SQLite 웨어하우스 적재
 *
 * 사용 예:
 *   # 미적재분만 (서울·경기 백필) — scope=all 은 수도권만
 *   npx tsx scripts/sync-molit.ts --scope=all --trade-months=120 --rent-months=48 --skip-existing=1
 *
 *   # 최근 개월 변경분만 (기본 daily)
 *   npx tsx scripts/sync-molit.ts --scope=all --trade-months=2 --rent-months=2 --skip-existing=0 --only-changed=1
 *
 *   # 전국 plan (WRITE 0)
 *   npx tsx scripts/sync-molit.ts --scope=nationwide --trade-months=3 --plan=1
 *
 *   # 신규 지역 smoke (historical → discovery=0)
 *   npx tsx scripts/sync-molit.ts --codes=26350 --trade-months=1 --rent-months=0 \
 *     --skip-existing=0 --only-changed=0 --discovery=0 --concurrency=1
 *
 * 문서: docs/nationwide-sync.md
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { resolve } from "node:path";
import {
  FEATURED_LAWD_CODES,
  ALL_REGIONS,
  allCapitalLawdCodes,
  allNationwideLawdCodes,
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
  // featured는 서울·경기 중심 — CAPITAL + 동일 규칙
  for (const region of ALL_REGIONS) {
    if (region.lawdCodes.some((c) => featured.has(c))) {
      for (const c of region.lawdCodes) codes.add(c);
    }
  }
  return [...codes];
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

async function main() {
  const scope = argValue("scope", "featured"); // featured | all | nationwide | anyang | codes
  const tradeMonths = Number(argValue("trade-months", "120"));
  const rentMonths = Number(argValue("rent-months", "48"));
  const concurrency = Math.min(
    8,
    Math.max(1, Number(argValue("concurrency", "4"))),
  );
  const codesArg = argValue("codes", "");
  const skipExisting = argValue("skip-existing", "1") !== "0";
  // 운영 기본: API는 조회하되 DB write는 변경된 월만
  const onlyChanged = argValue("only-changed", skipExisting ? "0" : "1") !== "0";
  const rebuildCatalog = argValue("rebuild-catalog", "1") !== "0";
  const planOnly = argValue("plan", "0") === "1" || process.argv.includes("--plan");
  /** historical backfill: first_seen_at=NULL → 오늘의 시장 발견 feed 오염 방지 */
  const discovery = argValue("discovery", "1") !== "0";
  const maxRegions = Number(argValue("max-regions", "0"));
  const maxMonths = Number(argValue("max-months", "0"));
  const fromMonth = argValue("from-month", "");
  const toMonth = argValue("to-month", "");

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
  } else if (scope === "nationwide") {
    lawdCodes = allNationwideLawdCodes();
  } else if (scope === "all") {
    // 하위 호환: all = 서울·경기 (기존 Actions/스크립트)
    lawdCodes = allCapitalLawdCodes();
  } else if (scope === "anyang") {
    lawdCodes = ["41171", "41173"];
  } else {
    lawdCodes = expandFeatured();
  }

  if (maxRegions > 0) {
    lawdCodes = lawdCodes.slice(0, maxRegions);
  }

  let tradeYms: string[];
  let rentYms: string[];
  if (fromMonth && toMonth) {
    const span = yearMonthsBetween(fromMonth, toMonth);
    tradeYms = span;
    rentYms = rentMonths > 0 ? span : [];
  } else {
    tradeYms = recentYearMonths(Math.min(Math.max(tradeMonths, 1), 240));
    rentYms = recentYearMonths(Math.min(Math.max(rentMonths, 0), 240));
  }
  if (maxMonths > 0) {
    tradeYms = tradeYms.slice(0, maxMonths);
    rentYms = rentYms.slice(0, maxMonths);
  }

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
    `[sync] scope=${scope} lawds=${lawdCodes.length} jobs=${jobs.length} skippedExisting=${skippedExisting} onlyChanged=${onlyChanged ? 1 : 0} discovery=${discovery ? 1 : 0} plan=${planOnly ? 1 : 0} concurrency=${concurrency} tradeMonths=${tradeYms.length} rentMonths=${rentYms.length}`,
  );
  if (lawdCodes.length <= 20) {
    console.log(`[sync] lawds: ${lawdCodes.join(",")}`);
  } else {
    console.log(
      `[sync] lawds sample: ${lawdCodes.slice(0, 8).join(",")} … (+${lawdCodes.length - 8})`,
    );
  }

  if (planOnly) {
    console.log(
      `[sync:plan] NO WRITE. estimated API cells≈${jobs.length} (1+ pages each). Use without --plan=1 to execute.`,
    );
    console.log(
      `[sync:plan] tip: nationwide historical is dangerous for write quota — prefer --discovery=0 --trade-months=3 --skip-existing=1 --max-regions=N`,
    );
    return;
  }

  if (jobs.length === 0) {
    console.log("[sync] nothing to do");
    return;
  }

  let done = 0;
  let inserted = 0;
  let updated = 0;
  let deleted = 0;
  let written = 0;
  let unchanged = 0;
  let failures = 0;
  let next = 0;
  const failedKeys: string[] = [];
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
          const result = await replaceMonthTransactions({
            lawdCd: job.lawdCd,
            yearMonth: job.yearMonth,
            dealKind: job.kind,
            items,
            setFirstSeenOnInsert: discovery,
          });
          inserted += result.inserted;
          updated += result.updated;
          deleted += result.deleted;
          unchanged += result.unchanged;
          if (result.wrote) {
            written += 1;
          }
          if (snapshots) {
            snapshots.set(key, {
              rowCount: items.length,
              maxDealDate: maxDealDate(items),
            });
          }
        }
      } catch (err) {
        failures += 1;
        failedKeys.push(key);
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
            `[sync] progress ${done}/${jobs.length} writtenCells=${written} ins=${inserted} upd=${updated} del=${deleted} unchanged=${unchanged} failures=${failures} elapsed=${elapsedMin}m eta~${etaMin}m`,
          );
        }
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker()),
  );

  const durationSec = Math.round((Date.now() - startedAt) / 1000);
  console.log(
    `[sync] SUMMARY regions=${lawdCodes.length} jobs=${done} writtenCells=${written} inserted=${inserted} updated=${updated} deleted=${deleted} unchanged=${unchanged} failures=${failures} skippedExisting=${skippedExisting} durationSec=${durationSec} discovery=${discovery ? 1 : 0}`,
  );
  if (failedKeys.length) {
    console.log(
      `[sync] failed keys (${failedKeys.length}): ${failedKeys.slice(0, 30).join(", ")}${failedKeys.length > 30 ? " …" : ""}`,
    );
  }

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

  // 시장 홈 스냅샷 — 쓰기가 있거나 강제 플래그일 때 갱신
  const rebuildMarket =
    process.env.REBUILD_MARKET_HOME === "1" ||
    process.argv.includes("--rebuild-market=1") ||
    written > 0;
  if (rebuildMarket) {
    try {
      const { rebuildMarketHomeSnapshot } = await import(
        "../src/lib/market/home"
      );
      const snap = await rebuildMarketHomeSnapshot();
      console.log(
        `[sync] market_home snapshot asOf=${snap.asOfDate} singoga=${snap.kpis.singogaCount} drops=${snap.kpis.dropCount}`,
      );
    } catch (err) {
      console.warn("[sync] market_home snapshot rebuild failed:", err);
    }

    try {
      const { rebuildMarketStats } = await import("../src/lib/market/stats");
      const stats = await rebuildMarketStats();
      console.log(
        `[sync] market_stats rebuilt asOf=${stats.asOfDate} days=${stats.days} regions=${stats.regions} ms=${stats.ms}`,
      );
    } catch (err) {
      console.warn("[sync] market_stats rebuild failed:", err);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

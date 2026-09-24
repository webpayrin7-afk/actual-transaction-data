/**
 * MOLIT → Turso/SQLite 웨어하우스 적재
 *
 * 사용 예:
 *   # 미적재분만 (서울·경기 백필) — scope=all 은 수도권만
 *   npx tsx scripts/sync-molit.ts --scope=all --trade-months=120 --rent-months=48 --skip-existing=1
 *
 *   # 최근 개월 변경분만 (기본 daily: 매매 4개월 late-report, 전월세 2)
 *   npx tsx scripts/sync-molit.ts --scope=all --trade-months=4 --rent-months=2 --skip-existing=0 --only-changed=1 --discovery=1
 *   npx tsx scripts/sync-molit.ts --scope=all --trade-months=4 --rent-months=2 --plan=1 --as-of=2026-09-09
 *   npx tsx scripts/sync-molit.ts --scope=all --from-month=202001 --to-month=202001 --dry-run=1 --discovery=0
 *   npx tsx scripts/sync-molit.ts --scope=all --trade-months=4 --max-writes=50000
 *
 *   # 전국 plan (WRITE 0)
 *   npx tsx scripts/sync-molit.ts --scope=nationwide --trade-months=3 --plan=1
 *
 *   # 신규 지역 smoke (historical → discovery=0)
 *   npx tsx scripts/sync-molit.ts --codes=26350 --trade-months=1 --rent-months=0 \
 *     --skip-existing=0 --only-changed=0 --discovery=0 --concurrency=1
 *
 *   # sync_months 공백 CSV만 매매 백필 (discovery=0 권장)
 *   npx tsx scripts/sync-molit.ts --gaps-file=data/sync-gaps/trade-gaps.csv \
 *     --discovery=0 --skip-delete=1 --skip-existing=1 --dry-run=1
 *
 * 문서: docs/nationwide-sync.md
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { readFileSync } from "node:fs";
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
import {
  applySkipExisting,
  buildRollingSyncJobs,
  isCellUnchanged,
  jobKey,
  maxDealDateOf,
  type DbCellSnap,
  type RollingSyncJob,
} from "../src/lib/molit/sync-policy";

/** CSV from export-trade-sync-gaps.ts (lawd_cd,year_month[,deal_kind]) */
function loadGapsFile(path: string): RollingSyncJob[] {
  const text = readFileSync(resolve(path), "utf8");
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const header = lines[0]!.split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
  const lawdIdx = header.indexOf("lawd_cd");
  const ymIdx = header.indexOf("year_month");
  const kindIdx = header.indexOf("deal_kind");
  if (lawdIdx < 0 || ymIdx < 0) {
    throw new Error(
      `--gaps-file requires lawd_cd,year_month columns (got: ${header.join(",")})`,
    );
  }
  const jobs: RollingSyncJob[] = [];
  const seen = new Set<string>();
  for (const line of lines.slice(1)) {
    // naive CSV split that keeps quoted commas out of field breaks
    const cols: string[] = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i]!;
      if (ch === '"') {
        inQ = !inQ;
        continue;
      }
      if (ch === "," && !inQ) {
        cols.push(cur);
        cur = "";
        continue;
      }
      cur += ch;
    }
    cols.push(cur);
    const lawdCd = (cols[lawdIdx] ?? "").trim();
    const yearMonth = (cols[ymIdx] ?? "").trim();
    const kindRaw = kindIdx >= 0 ? (cols[kindIdx] ?? "trade").trim() : "trade";
    const kind = kindRaw === "rent" ? "rent" : "trade";
    if (!/^\d{5}$/.test(lawdCd) || !/^\d{6}$/.test(yearMonth)) continue;
    const key = `${lawdCd}|${yearMonth}|${kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    jobs.push({ lawdCd, yearMonth, kind });
  }
  return jobs;
}

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

async function loadDbSnapshots(
  db: NonNullable<ReturnType<typeof getDb>>,
  yearMonths: string[],
): Promise<Map<string, DbCellSnap>> {
  const map = new Map<string, DbCellSnap>();
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
  const dryRun =
    argValue("dry-run", "0") === "1" || process.argv.includes("--dry-run");
  const maxWrites = Math.max(0, Number(argValue("max-writes", "0")) || 0);
  /** historical backfill: first_seen_at=NULL → 오늘의 시장 발견 feed 오염 방지 */
  const discovery = argValue("discovery", "1") !== "0";
  const skipDelete = argValue("skip-delete", "0") === "1";
  const maxRegions = Number(argValue("max-regions", "0"));
  const maxMonths = Number(argValue("max-months", "0"));
  const fromMonth = argValue("from-month", "");
  const toMonth = argValue("to-month", "");
  const gapsFile = argValue("gaps-file", "");
  const asOfArg = argValue("as-of", "");
  const asOf = asOfArg
    ? new Date(`${asOfArg}T12:00:00+09:00`)
    : new Date();
  if (Number.isNaN(asOf.getTime())) {
    console.error(`Invalid --as-of=${asOfArg} (use YYYY-MM-DD)`);
    process.exit(1);
  }

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

  let lawdCodes: string[] = [];
  let tradeYms: string[] = [];
  let rentYms: string[] = [];
  let jobs: RollingSyncJob[] = [];

  if (gapsFile) {
    jobs = loadGapsFile(gapsFile);
    lawdCodes = [...new Set(jobs.map((j) => j.lawdCd))];
    tradeYms = [
      ...new Set(jobs.filter((j) => j.kind === "trade").map((j) => j.yearMonth)),
    ].sort();
    rentYms = [
      ...new Set(jobs.filter((j) => j.kind === "rent").map((j) => j.yearMonth)),
    ].sort();
    console.log(
      `[sync] gaps-file=${gapsFile} loadedJobs=${jobs.length} lawds=${lawdCodes.length}`,
    );
  } else if (codesArg) {
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

  if (!gapsFile) {
    if (maxRegions > 0) {
      lawdCodes = lawdCodes.slice(0, maxRegions);
    }

    if (fromMonth && toMonth) {
      const span = yearMonthsBetween(fromMonth, toMonth);
      tradeYms = span;
      rentYms = rentMonths > 0 ? span : [];
      jobs = [];
      for (const lawdCd of lawdCodes) {
        for (const yearMonth of tradeYms) {
          jobs.push({ lawdCd, yearMonth, kind: "trade" });
        }
        for (const yearMonth of rentYms) {
          jobs.push({ lawdCd, yearMonth, kind: "rent" });
        }
      }
    } else {
      const planned = buildRollingSyncJobs({
        lawdCodes,
        tradeMonths,
        rentMonths,
        asOf,
      });
      tradeYms = planned.tradeYms;
      rentYms = planned.rentYms;
      jobs = planned.jobs;
    }
  }
  if (maxMonths > 0) {
    tradeYms = tradeYms.slice(0, maxMonths);
    rentYms = rentYms.slice(0, maxMonths);
    const tradeKeep = new Set(tradeYms);
    const rentKeep = new Set(rentYms);
    jobs = jobs.filter((j) =>
      j.kind === "trade" ? tradeKeep.has(j.yearMonth) : rentKeep.has(j.yearMonth),
    );
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
    const filtered = applySkipExisting(jobs, have, true);
    jobs = filtered.jobs;
    skippedExisting = filtered.skipped;
  }

  const snapshots = onlyChanged
    ? await loadDbSnapshots(db, [...new Set([...tradeYms, ...rentYms])])
    : null;

  console.log(
    `[sync] scope=${scope} lawds=${lawdCodes.length} jobs=${jobs.length} skippedExisting=${skippedExisting} onlyChanged=${onlyChanged ? 1 : 0} discovery=${discovery ? 1 : 0} skipDelete=${skipDelete ? 1 : 0} plan=${planOnly ? 1 : 0} dryRun=${dryRun ? 1 : 0} maxWrites=${maxWrites} concurrency=${concurrency} tradeMonths=${tradeYms.length} rentMonths=${rentYms.length}`,
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
  let emptyMarked = 0;
  let next = 0;
  let stop = false;
  const failedKeys: string[] = [];
  const insertByYearMonth = new Map<string, number>();
  const insertByCell = new Map<string, number>();
  const startedAt = Date.now();

  async function touchSyncMonth(
    job: RollingSyncJob,
    rowCount: number,
  ): Promise<void> {
    if (dryRun) return;
    const client = getDb();
    if (!client) return;
    await client.execute({
      sql: `INSERT INTO sync_months (lawd_cd, year_month, deal_kind, synced_at, row_count)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(lawd_cd, year_month, deal_kind) DO UPDATE SET
              synced_at = excluded.synced_at,
              row_count = excluded.row_count`,
      args: [
        job.lawdCd,
        job.yearMonth,
        job.kind,
        new Date().toISOString(),
        rowCount,
      ],
    });
  }

  async function worker() {
    while (!stop) {
      const index = next;
      next += 1;
      if (index >= jobs.length) return;
      const job = jobs[index];
      const key = jobKey(job);
      try {
        const items =
          job.kind === "trade"
            ? await fetchOneTradeForSync(job.lawdCd, job.yearMonth)
            : await fetchOneRentForSync(job.lawdCd, job.yearMonth);

        if (onlyChanged && isCellUnchanged(snapshots?.get(key), items)) {
          unchanged += 1;
          // gaps-file: still stamp sync_months so resume skips this cell
          if (gapsFile) {
            await touchSyncMonth(job, items.length);
            emptyMarked += 1;
          }
        } else {
          const preview = await replaceMonthTransactions({
            lawdCd: job.lawdCd,
            yearMonth: job.yearMonth,
            dealKind: job.kind,
            items,
            setFirstSeenOnInsert: discovery,
            dryRun: true,
            skipDelete,
          });
          const previewWrites =
            preview.inserted + preview.updated + (skipDelete ? 0 : preview.deleted);
          const sqlWritesSoFar = inserted + updated + (skipDelete ? 0 : deleted);
          if (!dryRun && maxWrites > 0 && sqlWritesSoFar + previewWrites > maxWrites) {
            stop = true;
            console.error(
              `[sync] WRITE KILL SWITCH max-writes=${maxWrites} would exceed at ${key} pendingIns=${preview.inserted} pendingUpd=${preview.updated} pendingDel=${preview.deleted} soFarIns=${inserted} soFarUpd=${updated}`,
            );
            unchanged += preview.unchanged;
            continue;
          }
          const result = dryRun
            ? preview
            : await replaceMonthTransactions({
                lawdCd: job.lawdCd,
                yearMonth: job.yearMonth,
                dealKind: job.kind,
                items,
                setFirstSeenOnInsert: discovery,
                dryRun: false,
                skipDelete,
              });
          inserted += result.inserted;
          updated += result.updated;
          deleted += result.deleted;
          unchanged += result.unchanged;
          if (result.inserted > 0) {
            insertByYearMonth.set(
              job.yearMonth,
              (insertByYearMonth.get(job.yearMonth) ?? 0) + result.inserted,
            );
            insertByCell.set(key, result.inserted);
          }
          if (result.wrote) {
            written += 1;
          } else if (gapsFile) {
            // 0건 또는 warehouse와 완전 일치 — sync_months만 찍어 공백 재시도를 막음
            await touchSyncMonth(job, items.length);
            emptyMarked += 1;
          }
          if (snapshots) {
            snapshots.set(key, {
              rowCount: items.length,
              maxDealDate: maxDealDateOf(items),
            });
          }
        }
      } catch (err) {
        failures += 1;
        failedKeys.push(key);
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[sync] fail ${job.kind} ${job.lawdCd} ${job.yearMonth}:`,
          msg,
        );
        // 일일 한도/차단이면 이어받기 위해 즉시 중단 (skip-existing으로 다음날 재개)
        if (
          /LIMIT|한도|quota|429|403|SERVICE.?KEY|일일/i.test(msg) ||
          /초과|exceeded/i.test(msg)
        ) {
          stop = true;
          console.error(
            `[sync] API limit/block detected — stopping for resume. remaining≈${jobs.length - done - 1}`,
          );
        }
      } finally {
        done += 1;
        if (done % 25 === 0 || done === jobs.length || stop) {
          const elapsedMin = ((Date.now() - startedAt) / 60000).toFixed(1);
          const rate = done / Math.max((Date.now() - startedAt) / 1000, 1);
          const etaMin = (
            (jobs.length - done) /
            Math.max(rate, 0.01) /
            60
          ).toFixed(0);
          console.log(
            `[sync] progress ${done}/${jobs.length} writtenCells=${written} emptyMarked=${emptyMarked} ins=${inserted} upd=${updated} del=${deleted} unchanged=${unchanged} failures=${failures} elapsed=${elapsedMin}m eta~${etaMin}m${dryRun ? " DRY-RUN" : ""}`,
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
    `[sync] SUMMARY regions=${lawdCodes.length} jobs=${done} writtenCells=${written} emptyMarked=${emptyMarked} inserted=${inserted} updated=${updated} deleted=${deleted} unchanged=${unchanged} failures=${failures} skippedExisting=${skippedExisting} durationSec=${durationSec} discovery=${discovery ? 1 : 0} dryRun=${dryRun ? 1 : 0} sqlWrites=${inserted + updated + deleted}`,
  );
  if (insertByYearMonth.size > 0) {
    const insertYm = [...insertByYearMonth.entries()].sort((a, b) =>
      a[0].localeCompare(b[0]),
    );
    console.log(
      `[sync] INSERT yearMonth distribution: ${JSON.stringify(Object.fromEntries(insertYm))}`,
    );
  }
  if (insertByCell.size > 0 && insertByCell.size <= 200) {
    console.log(
      `[sync] INSERT by cell: ${JSON.stringify(Object.fromEntries([...insertByCell.entries()].sort()))}`,
    );
  } else if (insertByCell.size > 200) {
    const top = [...insertByCell.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 40);
    console.log(
      `[sync] INSERT by cell (top 40 of ${insertByCell.size}): ${JSON.stringify(Object.fromEntries(top))}`,
    );
  }
  if (failedKeys.length) {
    console.log(
      `[sync] failed keys (${failedKeys.length}): ${failedKeys.slice(0, 30).join(", ")}${failedKeys.length > 30 ? " …" : ""}`,
    );
  }

  if (rebuildCatalog && written > 0 && !dryRun) {
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
  // gaps-file / historical backfill는 기본 스킵 (--rebuild-market=1 로 강제)
  const rebuildMarketFlag = argValue("rebuild-market", gapsFile ? "0" : "");
  const rebuildMarket =
    !dryRun &&
    rebuildMarketFlag !== "0" &&
    (rebuildMarketFlag === "1" ||
      process.env.REBUILD_MARKET_HOME === "1" ||
      process.argv.includes("--rebuild-market=1") ||
      (!gapsFile && written > 0));
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

  if (stop) {
    process.exit(2);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

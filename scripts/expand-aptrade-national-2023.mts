/**
 * TRUE NATIONAL AptTrade 2023-01..2026-09 expansion + rgstDate ingest.
 *
 * Missing cells only. Preserves Seoul/Gyeonggi + existing Busan months.
 * Gwangju/Jeonnam = MAPPING_HOLD (see apttrade-lawd-mapping.ts).
 *
 * Reuses: fetchOneTradeForSync → resolveActiveTrades → replaceMonthTransactions
 *
 *   npx tsx scripts/expand-aptrade-national-2023.mts --plan=1
 *   npx tsx scripts/expand-aptrade-national-2023.mts --apply=1 --max-cells=2
 *   npx tsx scripts/expand-aptrade-national-2023.mts --apply=1 --discovery=0 --concurrency=2
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  NATIONWIDE_LAWD_CODES,
  metroFromLawdNationwide,
  type NationwideMetro,
} from "../src/lib/constants/nationwide-lawd";
import { ensureSchema, getDb } from "../src/lib/db/client";
import { replaceMonthTransactions } from "../src/lib/db/repository";
import {
  hasRgstDateColumn,
  resetRgstDateColumnCache,
} from "../src/lib/db/rgst-date-column";
import { fetchOneTradeForSync } from "../src/lib/molit/client";
import {
  aptTradeMappingStatus,
  isAptTradeMappingHoldLawd,
  runnableAptTradeLawds,
  toAptTradeRequestLawds,
} from "../src/lib/molit/aptrade-lawd-mapping";
import {
  gwangjuJeonnamAptTradeRequestLawds,
  incheonAptTradeBackfillLawds,
  incheonTrueNodataLawds,
} from "../src/lib/molit/temporal-lawd";
import { rgstDateFromTx } from "../src/lib/molit/rgst-date";

/** Launch-complete capital — never re-expand even if some months are sparse. */
const CAPITAL_COMPLETE: ReadonlySet<NationwideMetro> = new Set([
  "seoul",
  "gyeonggi",
]);

function isCapitalCompleteLawd(lawdCd: string): boolean {
  return CAPITAL_COMPLETE.has(metroFromLawdNationwide(lawdCd));
}

const CHECKPOINT_PATH = resolve(
  "data/poc/aptrade-national-expand-checkpoint.json",
);

type CellKey = string; // lawd|ym

type Checkpoint = {
  version: 1;
  startedAt: string;
  updatedAt: string;
  fromYm: string;
  toYm: string;
  mappingHolds: string[];
  completed: Record<
    CellKey,
    {
      at: string;
      rowsFetched: number;
      inserted: number;
      updated: number;
      unchanged: number;
      deleted: number;
      retryCount: number;
      populated: number;
      unresolved: number;
    }
  >;
  failed: Record<
    CellKey,
    {
      at: string;
      error: string;
      errorClass: string;
      attempts: number;
    }
  >;
  totals: {
    apiCalls: number;
    inserted: number;
    updated: number;
    unchanged: number;
    deleted: number;
    populated: number;
    unresolved: number;
    identityConflicts: number;
  };
};

function argValue(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function cellKey(lawd: string, ym: string): CellKey {
  return `${lawd}|${ym}`;
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

function classifyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/timeout|TimeoutError|AbortError/i.test(msg)) return "timeout";
  if (/HTTP 429|429/.test(msg)) return "429";
  if (/HTTP 5\d\d|503|502|500/.test(msg)) return "5xx";
  if (/NODATA|no data/i.test(msg)) return "nodata";
  return "other";
}

function loadCheckpoint(fromYm: string, toYm: string): Checkpoint {
  if (existsSync(CHECKPOINT_PATH)) {
    const raw = JSON.parse(readFileSync(CHECKPOINT_PATH, "utf8")) as Checkpoint;
    if (raw.version === 1 && raw.fromYm === fromYm && raw.toYm === toYm) {
      return raw;
    }
  }
  const mapping = aptTradeMappingStatus();
  return {
    version: 1,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    fromYm,
    toYm,
    mappingHolds: mapping.holdLawds,
    completed: {},
    failed: {},
    totals: {
      apiCalls: 0,
      inserted: 0,
      updated: 0,
      unchanged: 0,
      deleted: 0,
      populated: 0,
      unresolved: 0,
      identityConflicts: 0,
    },
  };
}

function saveCheckpoint(cp: Checkpoint) {
  cp.updatedAt = new Date().toISOString();
  mkdirSync(dirname(CHECKPOINT_PATH), { recursive: true });
  writeFileSync(CHECKPOINT_PATH, JSON.stringify(cp, null, 2));
}

async function sleep(ms: number) {
  if (ms > 0) await new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const apply = argValue("apply", "0") === "1";
  const planOnly = argValue("plan", "0") === "1";
  const discovery = argValue("discovery", "0") !== "0";
  const fromYm = argValue("from-month", "202301");
  const toYm = argValue("to-month", "202609");
  const sleepMs = Math.max(0, Number(argValue("sleep-ms", "250")) || 0);
  const concurrency = Math.min(
    3,
    Math.max(1, Number(argValue("concurrency", "2")) || 1),
  );
  const maxCells = Math.max(0, Number(argValue("max-cells", "0")) || 0);
  const resetCp = argValue("reset-checkpoint", "0") === "1";
  const retryFailed = argValue("retry-failed", "1") !== "0";
  // New geography: allow month replace deletes if API shrinks (normal sync).
  // Existing capital cells are never in the job list (skip-existing).
  const skipDelete = argValue("skip-delete", "0") === "1";

  const mapping = aptTradeMappingStatus();
  console.log(
    `[expand] mapping status gwangju=${mapping.gwangju} jeonnam=${mapping.jeonnam} hold=${mapping.holdLawds.length} reason=${mapping.reason}`,
  );

  process.env.MOLIT_SYNCING = "1";
  const db = getDb();
  if (!db) throw new Error("DB unavailable");
  await ensureSchema(db);
  resetRgstDateColumnCache();
  if (!(await hasRgstDateColumn(db))) {
    throw new Error("transactions.rgst_date column missing");
  }

  const months = yearMonthsBetween(fromYm, toYm);
  const runnable = runnableAptTradeLawds();

  const existing = await db.execute({
    sql: `SELECT lawd_cd, year_month FROM sync_months
          WHERE deal_kind = 'trade'
            AND year_month >= ? AND year_month <= ?`,
    args: [fromYm, toYm],
  });
  const have = new Set(
    existing.rows.map((r) => cellKey(String(r.lawd_cd), String(r.year_month))),
  );

  const seedLawds = [
    ...NATIONWIDE_LAWD_CODES,
    ...gwangjuJeonnamAptTradeRequestLawds(),
    ...incheonAptTradeBackfillLawds(),
  ];
  const trueNodata = new Set(incheonTrueNodataLawds());

  const allCatalogCells: Array<{ lawdCd: string; yearMonth: string }> = [];
  let heldCells = 0;
  let capitalExcludedCells = 0;
  let nodataExcluded = 0;
  const seenRequest = new Set<string>();
  for (const catalogLawd of seedLawds) {
    if (trueNodata.has(catalogLawd)) {
      nodataExcluded += months.length;
      continue;
    }
    if (isAptTradeMappingHoldLawd(catalogLawd)) {
      heldCells += 1;
      continue;
    }
    if (isCapitalCompleteLawd(catalogLawd)) {
      capitalExcludedCells += months.length;
      continue;
    }
    const requestLawds = toAptTradeRequestLawds(catalogLawd);
    for (const lawdCd of requestLawds) {
      if (trueNodata.has(lawdCd)) continue;
      if (isCapitalCompleteLawd(lawdCd)) continue;
      for (const yearMonth of months) {
        const rk = cellKey(lawdCd, yearMonth);
        if (seenRequest.has(rk)) continue;
        seenRequest.add(rk);
        allCatalogCells.push({ lawdCd, yearMonth });
      }
    }
  }

  const missing = allCatalogCells.filter(
    (c) => !have.has(cellKey(c.lawdCd, c.yearMonth)),
  );

  console.log(
    `[expand] catalog=${NATIONWIDE_LAWD_CODES.length} runnableLawds=${runnable.length} requestCells=${allCatalogCells.length} months=${months.length} existingCells=${have.size} missingCells=${missing.length} heldCells=${heldCells} capitalExcluded=${capitalExcludedCells} nodataExcluded=${nodataExcluded} apply=${apply ? 1 : 0} discovery=${discovery ? 1 : 0} concurrency=${concurrency}`,
  );

  if (planOnly) {
    const byPrefix = new Map<string, number>();
    for (const c of missing) {
      const p = c.lawdCd.slice(0, 2);
      byPrefix.set(p, (byPrefix.get(p) ?? 0) + 1);
    }
    console.log(
      JSON.stringify(
        {
          plan: true,
          writes: 0,
          api: 0,
          mapping,
          fromYm,
          toYm,
          missingCells: missing.length,
          heldCells,
          byPrefix: Object.fromEntries([...byPrefix.entries()].sort()),
          sample: missing.slice(0, 10),
        },
        null,
        2,
      ),
    );
    return;
  }

  let cp = loadCheckpoint(fromYm, toYm);
  if (resetCp) {
    cp = loadCheckpoint("__reset__", "__reset__");
    cp.fromYm = fromYm;
    cp.toYm = toYm;
    cp.mappingHolds = mapping.holdLawds;
    saveCheckpoint(cp);
  }

  let pending = missing.filter((c) => {
    const k = cellKey(c.lawdCd, c.yearMonth);
    if (cp.completed[k]) return false;
    if (!retryFailed && cp.failed[k]) return false;
    return true;
  });
  if (maxCells > 0) pending = pending.slice(0, maxCells);

  console.log(
    `[expand] pending=${pending.length} completed=${Object.keys(cp.completed).length} failed=${Object.keys(cp.failed).length}`,
  );

  if (pending.length === 0) {
    console.log("[expand] nothing to do");
    return;
  }

  let next = 0;
  const startedAt = Date.now();

  async function worker() {
    while (true) {
      const index = next;
      next += 1;
      if (index >= pending.length) return;
      const job = pending[index]!;
      const key = cellKey(job.lawdCd, job.yearMonth);
      const priorAttempts = cp.failed[key]?.attempts ?? 0;

      try {
        await sleep(sleepMs);
        const items = await fetchOneTradeForSync(job.lawdCd, job.yearMonth);
        cp.totals.apiCalls += 1;

        const result = await replaceMonthTransactions({
          lawdCd: job.lawdCd,
          yearMonth: job.yearMonth,
          dealKind: "trade",
          items,
          setFirstSeenOnInsert: discovery,
          dryRun: !apply,
          skipDelete,
        });

        let populated = 0;
        let unresolved = 0;
        for (const tx of items) {
          if (rgstDateFromTx(tx)) populated += 1;
          else unresolved += 1;
        }

        cp.completed[key] = {
          at: new Date().toISOString(),
          rowsFetched: items.length,
          inserted: result.inserted,
          updated: result.updated,
          unchanged: result.unchanged,
          deleted: result.deleted,
          retryCount: priorAttempts,
          populated,
          unresolved,
        };
        delete cp.failed[key];
        cp.totals.inserted += result.inserted;
        cp.totals.updated += result.updated;
        cp.totals.unchanged += result.unchanged;
        cp.totals.deleted += result.deleted;
        cp.totals.populated += populated;
        cp.totals.unresolved += unresolved;
        saveCheckpoint(cp);
      } catch (err) {
        const errorClass = classifyError(err);
        const attempts = priorAttempts + 1;
        cp.failed[key] = {
          at: new Date().toISOString(),
          error: err instanceof Error ? err.message : String(err),
          errorClass,
          attempts,
        };
        cp.totals.apiCalls += 1;
        saveCheckpoint(cp);
        console.warn(
          `[expand] FAIL ${key} class=${errorClass} attempt=${attempts}:`,
          err instanceof Error ? err.message : err,
        );
      } finally {
        const done = Object.keys(cp.completed).length;
        const fail = Object.keys(cp.failed).length;
        const processed = index + 1;
        if (processed % 25 === 0 || processed === pending.length) {
          const elapsedMin = ((Date.now() - startedAt) / 60000).toFixed(1);
          const rate = processed / Math.max((Date.now() - startedAt) / 1000, 1);
          const etaMin = (
            (pending.length - processed) /
            Math.max(rate, 0.01) /
            60
          ).toFixed(0);
          console.log(
            `[expand] progress ${processed}/${pending.length} doneTotal=${done} fail=${fail} ins=${cp.totals.inserted} upd=${cp.totals.updated} api=${cp.totals.apiCalls} elapsed=${elapsedMin}m eta~${etaMin}m apply=${apply ? 1 : 0}`,
          );
        }
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, pending.length) }, () =>
      worker(),
    ),
  );

  const summary = {
    apply,
    discovery,
    fromYm,
    toYm,
    mapping,
    pendingAttempted: pending.length,
    completed: Object.keys(cp.completed).length,
    failed: Object.keys(cp.failed).length,
    failedSample: Object.entries(cp.failed)
      .slice(0, 20)
      .map(([k, v]) => ({ key: k, ...v })),
    totals: cp.totals,
    durationSec: Math.round((Date.now() - startedAt) / 1000),
    checkpoint: CHECKPOINT_PATH,
  };
  console.log(JSON.stringify(summary, null, 2));

  mkdirSync(dirname(resolve("data/poc/aptrade-national-expand-summary.json")), {
    recursive: true,
  });
  writeFileSync(
    resolve("data/poc/aptrade-national-expand-summary.json"),
    JSON.stringify(summary, null, 2) + "\n",
  );

  if (Object.keys(cp.failed).length > 0) process.exit(3);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * National AptTrade rgst_date backfill for contracts from 2023-01 onward.
 *
 * Reuses: fetchOneTradeForSync → resolveActiveTrades → replaceMonthTransactions
 * Always re-evaluates cells (--only-changed=0 semantics). Checkpoint/resume.
 *
 *   # plan / sanity (no writes)
 *   npx tsx scripts/backfill-rgst-date-national.mts --plan=1
 *
 *   # dry-run first N cells
 *   npx tsx scripts/backfill-rgst-date-national.mts --max-cells=5
 *
 *   # apply with resume
 *   npx tsx scripts/backfill-rgst-date-national.mts --apply=1 --discovery=0
 *
 *   # reset checkpoint and restart (dangerous)
 *   npx tsx scripts/backfill-rgst-date-national.mts --apply=1 --reset-checkpoint=1
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ensureSchema, getDb } from "../src/lib/db/client";
import { replaceMonthTransactions } from "../src/lib/db/repository";
import {
  hasRgstDateColumn,
  resetRgstDateColumnCache,
} from "../src/lib/db/rgst-date-column";
import { fetchOneTradeForSync } from "../src/lib/molit/client";
import { rgstDateFromTx } from "../src/lib/molit/rgst-date";

const CHECKPOINT_PATH = resolve(
  "data/poc/rgst-national-backfill-checkpoint.json",
);

type CellKey = string; // lawd|ym

type Checkpoint = {
  version: 1;
  startedAt: string;
  updatedAt: string;
  fromYm: string;
  toYm: string;
  completed: Record<
    CellKey,
    {
      at: string;
      active: number;
      inserted: number;
      updated: number;
      unchanged: number;
      populated: number;
      unresolved: number;
    }
  >;
  failed: Record<CellKey, { at: string; error: string; attempts: number }>;
  totals: {
    apiCalls: number;
    inserted: number;
    updated: number;
    unchanged: number;
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

function loadCheckpoint(fromYm: string, toYm: string): Checkpoint {
  if (existsSync(CHECKPOINT_PATH)) {
    const raw = JSON.parse(readFileSync(CHECKPOINT_PATH, "utf8")) as Checkpoint;
    if (raw.version === 1 && raw.fromYm === fromYm && raw.toYm === toYm) {
      return raw;
    }
  }
  return {
    version: 1,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    fromYm,
    toYm,
    completed: {},
    failed: {},
    totals: {
      apiCalls: 0,
      inserted: 0,
      updated: 0,
      unchanged: 0,
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

  process.env.MOLIT_SYNCING = "1";
  const db = getDb();
  if (!db) throw new Error("DB unavailable");

  const scope = await db.execute({
    sql: `SELECT lawd_cd, year_month
          FROM sync_months
          WHERE deal_kind = 'trade'
            AND year_month >= ?
            AND year_month <= ?
          ORDER BY year_month ASC, lawd_cd ASC`,
    args: [fromYm, toYm],
  });
  const cells = scope.rows.map((r) => ({
    lawdCd: String(r.lawd_cd),
    yearMonth: String(r.year_month),
  }));
  const rowCount = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM transactions
          WHERE deal_type='trade' AND deal_date >= '2023-01-01'
            AND year_month >= ? AND year_month <= ?`,
    args: [fromYm, toYm],
  });
  const expectedRows = Number(rowCount.rows[0]?.n ?? 0);

  console.error(
    `[rgst-national] SANITY scope cells=${cells.length} lawds=${new Set(cells.map((c) => c.lawdCd)).size} ` +
      `from=${fromYm} to=${toYm} expectedTradeRows≈${expectedRows} ` +
      `apply=${apply ? 1 : 0} concurrency=${concurrency}`,
  );

  if (cells.length === 0) {
    console.error("[rgst-national] STOP: zero cells");
    process.exit(1);
  }
  if (cells.length > 3500 || expectedRows > 800_000) {
    console.error(
      `[rgst-national] STOP: scope too large cells=${cells.length} rows=${expectedRows}`,
    );
    process.exit(2);
  }

  if (planOnly) {
    console.log(
      JSON.stringify(
        {
          plan: true,
          cells: cells.length,
          expectedApiCalls: cells.length,
          expectedTradeRows: expectedRows,
          fromYm,
          toYm,
          write: 0,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (apply) {
    await ensureSchema(db);
    resetRgstDateColumnCache();
    if (!(await hasRgstDateColumn(db))) {
      throw new Error("rgst_date column missing after ensureSchema");
    }
  }

  if (resetCp && existsSync(CHECKPOINT_PATH)) {
    writeFileSync(CHECKPOINT_PATH, "");
  }
  const cp = resetCp
    ? loadCheckpoint(fromYm, toYm)
    : loadCheckpoint(fromYm, toYm);
  if (resetCp) {
    cp.completed = {};
    cp.failed = {};
    cp.totals = {
      apiCalls: 0,
      inserted: 0,
      updated: 0,
      unchanged: 0,
      populated: 0,
      unresolved: 0,
      identityConflicts: 0,
    };
    cp.startedAt = new Date().toISOString();
    saveCheckpoint(cp);
  }

  let pending = cells.filter((c) => {
    const k = cellKey(c.lawdCd, c.yearMonth);
    if (cp.completed[k]) return false;
    if (!retryFailed && cp.failed[k]) return false;
    return true;
  });
  if (maxCells > 0) pending = pending.slice(0, maxCells);

  console.error(
    `[rgst-national] pending=${pending.length} completed=${Object.keys(cp.completed).length} failed=${Object.keys(cp.failed).length}`,
  );

  let next = 0;
  let stop = false;

  async function worker() {
    while (!stop) {
      const i = next;
      next += 1;
      if (i >= pending.length) return;
      const cell = pending[i]!;
      const key = cellKey(cell.lawdCd, cell.yearMonth);
      try {
        if (sleepMs) await new Promise((r) => setTimeout(r, sleepMs));
        const items = await fetchOneTradeForSync(cell.lawdCd, cell.yearMonth);
        cp.totals.apiCalls += 1;
        let populated = 0;
        let unresolved = 0;
        for (const tx of items) {
          if (rgstDateFromTx(tx)) populated += 1;
          else if (tx.dealDate >= "2023-01-01") unresolved += 1;
        }
        const result = await replaceMonthTransactions({
          lawdCd: cell.lawdCd,
          yearMonth: cell.yearMonth,
          dealKind: "trade",
          items,
          setFirstSeenOnInsert: discovery,
          dryRun: !apply,
          skipDelete: true,
        });
        cp.totals.inserted += result.inserted;
        cp.totals.updated += result.updated;
        cp.totals.unchanged += result.unchanged;
        cp.totals.populated += populated;
        cp.totals.unresolved += unresolved;
        cp.completed[key] = {
          at: new Date().toISOString(),
          active: items.length,
          inserted: result.inserted,
          updated: result.updated,
          unchanged: result.unchanged,
          populated,
          unresolved,
        };
        delete cp.failed[key];
        saveCheckpoint(cp);
        console.error(
          `[rgst-national] OK ${key} active=${items.length} ins=${result.inserted} upd=${result.updated} same=${result.unchanged} ` +
            `done=${Object.keys(cp.completed).length}/${cells.length}`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const prev = cp.failed[key];
        cp.failed[key] = {
          at: new Date().toISOString(),
          error: msg.slice(0, 400),
          attempts: (prev?.attempts ?? 0) + 1,
        };
        saveCheckpoint(cp);
        console.error(`[rgst-national] FAIL ${key}: ${msg}`);
        // soft-continue; do not wipe checkpoint
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  stop = true;

  console.log(
    JSON.stringify(
      {
        apply,
        fromYm,
        toYm,
        cellsTotal: cells.length,
        cellsComplete: Object.keys(cp.completed).length,
        cellsFailed: Object.keys(cp.failed).length,
        pendingLeft: cells.length - Object.keys(cp.completed).length,
        totals: cp.totals,
        checkpoint: CHECKPOINT_PATH,
        failedSample: Object.entries(cp.failed)
          .slice(0, 10)
          .map(([k, v]) => ({ cell: k, ...v })),
      },
      null,
      2,
    ),
  );

  if (Object.keys(cp.failed).length > 0) process.exitCode = 3;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

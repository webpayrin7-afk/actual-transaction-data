/**
 * TRUE NATIONAL full-history SALE + RENT background runner.
 *
 * Missing-only. Preserves frozen 2023+ AptTrade/registration baseline.
 * Shared MOLIT API key → concurrency≤2, no sale∥rent blast.
 *
 *   npx tsx scripts/full-history/runner.mts --daemon --apply=1
 *   npx tsx scripts/full-history/runner.mts --verify-start=1
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });
config({ quiet: true });

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { ensureSchema, getDb } from "../../src/lib/db/client";
import { replaceMonthTransactions } from "../../src/lib/db/repository";
import {
  fetchOneRentForSync,
  fetchOneTradeForSync,
} from "../../src/lib/molit/client";
import {
  acquireLock,
  cellKey,
  releaseLock,
  type ManifestCell,
  FULL_HISTORY_OUT as OUT,
  FULL_HISTORY_LOCK as LOCK,
} from "../../src/lib/molit/full-history-shared";

const CHECKPOINT = resolve(OUT, "checkpoint.json");
const HEARTBEAT = resolve(OUT, "heartbeat.json");
const PROGRESS = resolve(OUT, "progress.json");
const START_GATE = resolve(OUT, "start-gate.json");
const FAILED_Q = resolve(OUT, "retry-queue.jsonl");
const LOG = resolve(OUT, "runner.log");
const SALE_MANIFEST = resolve(OUT, "manifest-sale.json");
const RENT_MANIFEST = resolve(OUT, "manifest-rent.json");

type Checkpoint = {
  version: 1;
  startedAt: string;
  updatedAt: string;
  pid: number;
  cursor: number;
  completed: Record<
    string,
    {
      at: string;
      source: "SALE" | "RENT";
      rowsFetched: number;
      inserted: number;
      updated: number;
      unchanged: number;
      deleted: number;
      empty: boolean;
    }
  >;
  failed: Record<
    string,
    { at: string; error: string; errorClass: string; attempts: number }
  >;
  totals: {
    apiCalls: number;
    inserted: number;
    updated: number;
    unchanged: number;
    deleted: number;
    emptyComplete: number;
    saleCells: number;
    rentCells: number;
    identityConflicts: number;
  };
  firstBatchApplied: boolean;
  completedRun: boolean;
  currentPriority: number | null;
  currentSource: string | null;
  currentRegion: string | null;
  currentMonthRange: string | null;
};

function argValue(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`) || argValue(name, "") === "1";
}

function log(line: string) {
  mkdirSync(OUT, { recursive: true });
  const row = `[${new Date().toISOString()}] ${line}`;
  appendFileSync(LOG, row + "\n");
  console.error(row);
}

function writeJson(path: string, value: unknown) {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function classifyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/timeout|TimeoutError|AbortError/i.test(msg)) return "timeout";
  if (/HTTP 429|429/.test(msg)) return "429";
  if (/HTTP 5\d\d|503|502|500/.test(msg)) return "5xx";
  if (/NODATA|no data/i.test(msg)) return "nodata";
  return "other";
}

function emptyCheckpoint(): Checkpoint {
  return {
    version: 1,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    pid: process.pid,
    cursor: 0,
    completed: {},
    failed: {},
    totals: {
      apiCalls: 0,
      inserted: 0,
      updated: 0,
      unchanged: 0,
      deleted: 0,
      emptyComplete: 0,
      saleCells: 0,
      rentCells: 0,
      identityConflicts: 0,
    },
    firstBatchApplied: false,
    completedRun: false,
    currentPriority: null,
    currentSource: null,
    currentRegion: null,
    currentMonthRange: null,
  };
}

function loadCheckpoint(): Checkpoint {
  const raw = readJson<Checkpoint | null>(CHECKPOINT, null);
  if (raw && raw.version === 1) {
    raw.pid = process.pid;
    return raw;
  }
  return emptyCheckpoint();
}

function saveCheckpoint(cp: Checkpoint) {
  cp.updatedAt = new Date().toISOString();
  cp.pid = process.pid;
  writeJson(CHECKPOINT, cp);
  writeJson(PROGRESS, {
    ...cp.totals,
    cursor: cp.cursor,
    firstBatchApplied: cp.firstBatchApplied,
    completedRun: cp.completedRun,
    currentPriority: cp.currentPriority,
    currentSource: cp.currentSource,
    currentRegion: cp.currentRegion,
    currentMonthRange: cp.currentMonthRange,
    updatedAt: cp.updatedAt,
    completedCount: Object.keys(cp.completed).length,
    failedCount: Object.keys(cp.failed).length,
  });
}

function loadQueue(): ManifestCell[] {
  if (!existsSync(SALE_MANIFEST) || !existsSync(RENT_MANIFEST)) {
    throw new Error("manifests missing — run build-manifests.mts first");
  }
  const sale = JSON.parse(readFileSync(SALE_MANIFEST, "utf8")) as ManifestCell[];
  const rent = JSON.parse(readFileSync(RENT_MANIFEST, "utf8")) as ManifestCell[];
  return [...sale, ...rent]
    .filter((c) => c.requiredAction === "FETCH")
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      if (a.source !== b.source) return a.source === "RENT" ? -1 : 1;
      if (a.metro !== b.metro) return a.metro.localeCompare(b.metro);
      if (a.yearMonth !== b.yearMonth) return a.yearMonth.localeCompare(b.yearMonth);
      return a.requestLawd.localeCompare(b.requestLawd);
    });
}

async function ensureEmptySync(
  db: NonNullable<ReturnType<typeof getDb>>,
  dealKind: "trade" | "rent",
  lawdCd: string,
  yearMonth: string,
) {
  await db.execute({
    sql: `INSERT INTO sync_months (lawd_cd, year_month, deal_kind, synced_at, row_count)
          VALUES (?, ?, ?, ?, 0)
          ON CONFLICT(lawd_cd, year_month, deal_kind) DO NOTHING`,
    args: [lawdCd, yearMonth, dealKind, new Date().toISOString()],
  });
}

/**
 * Fetch succeeded but every row already existed (insert-only → no tx write,
 * so replaceMonthTransactions did not record sync_months). Record the cell
 * as synced so re-runs skip it. Never overwrites an existing sync row.
 */
async function ensureSyncNoWrite(
  db: NonNullable<ReturnType<typeof getDb>>,
  dealKind: "trade" | "rent",
  lawdCd: string,
  yearMonth: string,
  rowCount: number,
) {
  await db.execute({
    sql: `INSERT INTO sync_months (lawd_cd, year_month, deal_kind, synced_at, row_count)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(lawd_cd, year_month, deal_kind) DO NOTHING`,
    args: [lawdCd, yearMonth, dealKind, new Date().toISOString(), rowCount],
  });
}

async function verifyStart(): Promise<number> {
  const lock = readJson<{ pid?: number } | null>(LOCK, null);
  const hb = readJson<{ at?: string; pid?: number } | null>(HEARTBEAT, null);
  const cp = readJson<Checkpoint | null>(CHECKPOINT, null);
  const alive = !!(lock?.pid && existsSync(`/proc/${lock.pid}`));
  const gate = {
    processAlive: alive,
    lockExists: existsSync(LOCK),
    checkpointExists: existsSync(CHECKPOINT),
    heartbeatExists: existsSync(HEARTBEAT),
    firstBatchApplied: !!cp?.firstBatchApplied,
    heartbeatRecent:
      !!hb?.at && Date.now() - Date.parse(hb.at) < 5 * 60 * 1000,
    pid: lock?.pid ?? null,
    totals: cp?.totals ?? null,
    current: {
      priority: cp?.currentPriority ?? null,
      source: cp?.currentSource ?? null,
      region: cp?.currentRegion ?? null,
      monthRange: cp?.currentMonthRange ?? null,
    },
  };
  const ok =
    gate.processAlive &&
    gate.lockExists &&
    gate.checkpointExists &&
    gate.heartbeatExists &&
    gate.firstBatchApplied;
  writeJson(START_GATE, {
    ...gate,
    BACKGROUND_RUNNING: ok,
    checkedAt: new Date().toISOString(),
  });
  console.log(JSON.stringify({ ...gate, BACKGROUND_RUNNING: ok }, null, 2));
  return ok ? 0 : 2;
}

async function runDaemon() {
  const apply = argValue("apply", "0") === "1" || hasFlag("apply");
  const concurrency = Math.min(
    2,
    Math.max(1, Number(argValue("concurrency", "2")) || 1),
  );
  let sleepMs = Math.max(0, Number(argValue("sleep-ms", "250")) || 0);
  const firstBatchSize = Math.max(
    1,
    Number(argValue("first-batch", "8")) || 8,
  );
  const maxCells = Math.max(0, Number(argValue("max-cells", "0")) || 0);
  const discovery = argValue("discovery", "0") !== "0";

  if (!acquireLock(process.argv.slice(2), log)) {
    process.exit(2);
  }

  process.env.MOLIT_SYNCING = "1";
  const dbClient = getDb();
  if (!dbClient) {
    releaseLock();
    throw new Error("DB unavailable");
  }
  const db = dbClient;
  await ensureSchema(db);

  let cp = loadCheckpoint();
  if (!cp.startedAt) cp = emptyCheckpoint();
  cp.pid = process.pid;
  saveCheckpoint(cp);
  heartbeat({ phase: "boot", apply });

  // 2023-01+ SALE is a frozen baseline — never re-fetch (owner rule).
  const queue = loadQueue().filter(
    (c) =>
      !cp.completed[cellKey(c)] &&
      !(c.source === "SALE" && c.yearMonth >= "202301"),
  );
  const pending = maxCells > 0 ? queue.slice(0, maxCells) : queue;
  log(
    `boot apply=${apply ? 1 : 0} concurrency=${concurrency} sleepMs=${sleepMs} pending=${pending.length} completed=${Object.keys(cp.completed).length} failed=${Object.keys(cp.failed).length}`,
  );

  let next = 0;
  let consecutiveSoftErrors = 0;
  let consecutiveFails = 0;
  let haltReason: string | null = null;
  const startedAt = Date.now();

  async function processOne(job: ManifestCell) {
    const key = cellKey(job);
    const priorAttempts = cp.failed[key]?.attempts ?? 0;
    cp.currentPriority = job.priority;
    cp.currentSource = job.source;
    cp.currentRegion = job.metro;
    cp.currentMonthRange = job.yearMonth;

    try {
      if (sleepMs) await new Promise((r) => setTimeout(r, sleepMs));
      const items =
        job.dealKind === "trade"
          ? await fetchOneTradeForSync(job.requestLawd, job.yearMonth)
          : await fetchOneRentForSync(job.requestLawd, job.yearMonth);
      cp.totals.apiCalls += 1;

      const result = await replaceMonthTransactions({
        lawdCd: job.requestLawd,
        yearMonth: job.yearMonth,
        dealKind: job.dealKind,
        items,
        setFirstSeenOnInsert: discovery,
        dryRun: !apply,
        skipDelete: true,
        // Owner rule: missing-only — never overwrite existing rows.
        skipUpdate: true,
      });
      if (result.updated !== 0 || result.deleted !== 0) {
        throw new Error(
          `SAFETY: unexpected write updated=${result.updated} deleted=${result.deleted} ${key}`,
        );
      }

      if (apply && items.length > 0 && !result.wrote) {
        await ensureSyncNoWrite(
          db,
          job.dealKind,
          job.requestLawd,
          job.yearMonth,
          result.rowCount,
        );
      }

      if (apply && items.length === 0) {
        await ensureEmptySync(db, job.dealKind, job.requestLawd, job.yearMonth);
        cp.totals.emptyComplete += 1;
      }

      cp.completed[key] = {
        at: new Date().toISOString(),
        source: job.source,
        rowsFetched: items.length,
        inserted: result.inserted,
        updated: result.updated,
        unchanged: result.unchanged,
        deleted: result.deleted,
        empty: items.length === 0,
      };
      delete cp.failed[key];
      cp.totals.inserted += result.inserted;
      cp.totals.updated += result.updated;
      cp.totals.unchanged += result.unchanged;
      (cp.totals as Record<string, number>).updateSkipped =
        ((cp.totals as Record<string, number>).updateSkipped ?? 0) +
        (result.updateSkipped ?? 0);
      cp.totals.deleted += result.deleted;
      if (job.source === "SALE") cp.totals.saleCells += 1;
      else cp.totals.rentCells += 1;
      consecutiveSoftErrors = 0;
      consecutiveFails = 0;
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
      appendFileSync(
        FAILED_Q,
        JSON.stringify({ key, ...cp.failed[key], job }) + "\n",
      );
      if (
        errorClass === "429" ||
        errorClass === "5xx" ||
        errorClass === "timeout"
      ) {
        consecutiveSoftErrors += 1;
        sleepMs = Math.min(5000, sleepMs + 250 * consecutiveSoftErrors);
        log(`backoff sleepMs=${sleepMs} class=${errorClass} key=${key}`);
      }
      log(`FAIL ${key} class=${errorClass}: ${cp.failed[key].error}`);
      consecutiveFails += 1;
      const msg = cp.failed[key].error;
      if (/LIMITED_NUMBER|EXCEEDS|quota|SERVICE_KEY|SERVICE ERROR|UNREGISTERED|DEADLINE/i.test(msg)) {
        haltReason = `QUOTA_OR_KEY_ERROR at ${key}: ${msg.slice(0, 160)}`;
      } else if (/^SAFETY:/.test(msg)) {
        haltReason = msg;
      } else if (consecutiveFails >= 12) {
        haltReason = `ERROR_SPIKE ${consecutiveFails} consecutive failures (last ${key})`;
      }
    }
  }

  async function worker() {
    while (true) {
      if (haltReason) return;
      const i = next;
      next += 1;
      if (i >= pending.length) return;
      const job = pending[i]!;
      await processOne(job);
      cp.cursor = i + 1;
      if (!cp.firstBatchApplied && cp.cursor >= Math.min(firstBatchSize, pending.length || 1)) {
        cp.firstBatchApplied = true;
        log(`firstBatchApplied at cursor=${cp.cursor}`);
      }
      saveCheckpoint(cp);
      heartbeat({
        phase: "cell",
        cursor: cp.cursor,
        pending: pending.length,
        done: Object.keys(cp.completed).length,
        apiCalls: cp.totals.apiCalls,
        inserted: cp.totals.inserted,
        sleepMs,
        priority: cp.currentPriority,
        source: cp.currentSource,
        region: cp.currentRegion,
      });
      if ((i + 1) % 25 === 0 || i + 1 === pending.length) {
        const elapsed = ((Date.now() - startedAt) / 60000).toFixed(1);
        log(
          `progress ${i + 1}/${pending.length} sale=${cp.totals.saleCells} rent=${cp.totals.rentCells} ins=${cp.totals.inserted} fail=${Object.keys(cp.failed).length} elapsed=${elapsed}m`,
        );
      }
    }
  }

  const onSignal = () => {
    log("signal — saving checkpoint and releasing lock");
    saveCheckpoint(cp);
    releaseLock();
    process.exit(0);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, Math.max(pending.length, 1)) },
      () => worker(),
    ),
  );

  if (haltReason) {
    saveCheckpoint(cp);
    heartbeat({ phase: "halted", haltReason });
    log(`HALT ${haltReason} api=${cp.totals.apiCalls} ins=${cp.totals.inserted}`);
    releaseLock();
    process.exitCode = 4;
    return;
  }
  cp.completedRun = true;
  if (!cp.firstBatchApplied && Object.keys(cp.completed).length > 0) {
    cp.firstBatchApplied = true;
  }
  saveCheckpoint(cp);
  heartbeat({ phase: "done", completedRun: cp.completedRun });
  log(
    `done completedRun=1 api=${cp.totals.apiCalls} ins=${cp.totals.inserted} sale=${cp.totals.saleCells} rent=${cp.totals.rentCells}`,
  );
  releaseLock();
}

function heartbeat(extra: Record<string, unknown> = {}) {
  writeJson(HEARTBEAT, {
    pid: process.pid,
    at: new Date().toISOString(),
    ...extra,
  });
}

async function main() {
  if (hasFlag("verify-start")) {
    process.exitCode = await verifyStart();
    return;
  }
  if (!hasFlag("daemon") && argValue("apply", "") === "" && !hasFlag("apply")) {
    console.error("use --daemon --apply=1 (or --verify-start=1)");
    process.exit(1);
  }
  await runDaemon();
}

main().catch((e) => {
  console.error(e);
  try {
    releaseLock();
  } catch {
    /* ignore */
  }
  process.exit(1);
});

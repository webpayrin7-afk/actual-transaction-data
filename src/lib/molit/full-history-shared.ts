/**
 * Shared types + lock helpers for full-history manifests/runner.
 * Safe to import from tests (no side effects).
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import type { NationwideMetro } from "@/lib/constants/nationwide-lawd";

export const FULL_HISTORY_OUT = resolve("data/poc/full-history");
export const FULL_HISTORY_LOCK = resolve(FULL_HISTORY_OUT, "run.lock");

export type CellStatus =
  | "COMPLETE"
  | "READY"
  | "NODATA_CONFIRMED"
  | "FAILED_RETRYABLE"
  | "HOLD_MAPPING";

export type ManifestCell = {
  source: "SALE" | "RENT";
  dealKind: "trade" | "rent";
  lawd: string;
  yearMonth: string;
  requestLawd: string;
  canonicalGeography: string;
  metro: NationwideMetro;
  existingSyncState: "present" | "absent";
  rowStatus: CellStatus;
  requiredAction: "SKIP" | "FETCH" | "HOLD";
  attempt: number;
  priority: 0 | 1 | 2 | 3;
};

export function cellKey(c: Pick<ManifestCell, "dealKind" | "requestLawd" | "yearMonth">): string {
  return `${c.dealKind}|${c.requestLawd}|${c.yearMonth}`;
}

function pidAlive(pid: number): boolean {
  if (existsSync(`/proc/${pid}`)) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireLock(
  argv: string[],
  log: (line: string) => void = console.error,
): boolean {
  mkdirSync(FULL_HISTORY_OUT, { recursive: true });
  if (existsSync(FULL_HISTORY_LOCK)) {
    try {
      const prev = JSON.parse(readFileSync(FULL_HISTORY_LOCK, "utf8")) as {
        pid?: number;
      };
      if (prev.pid && pidAlive(prev.pid)) {
        log(`lock held by pid=${prev.pid}`);
        return false;
      }
      log(`stale lock pid=${prev.pid ?? "?"} — reclaiming`);
    } catch {
      log("corrupt lock — reclaiming");
    }
  }
  const fd = openSync(FULL_HISTORY_LOCK, "w");
  try {
    writeFileSync(
      FULL_HISTORY_LOCK,
      JSON.stringify(
        {
          pid: process.pid,
          startedAt: new Date().toISOString(),
          argv,
        },
        null,
        2,
      ),
    );
  } finally {
    closeSync(fd);
  }
  return true;
}

export function releaseLock() {
  try {
    if (existsSync(FULL_HISTORY_LOCK)) {
      const prev = JSON.parse(readFileSync(FULL_HISTORY_LOCK, "utf8")) as {
        pid?: number;
      };
      if (prev.pid === process.pid) unlinkSync(FULL_HISTORY_LOCK);
    }
  } catch {
    /* ignore */
  }
}

import type { Client } from "@libsql/client";
import type { Transaction } from "@/types/transaction";

/**
 * Date-axis freeze (do not mix):
 *
 * deal_date      = actual contract date (stats / Section1 / apt history / KPI)
 * first_seen_at  = warehouse first obtained the identity (internal audit)
 * discovery_at   = product "newly confirmed deal" timestamp (Home / Section2–3)
 *
 * Production ALTER of discovery_at is opt-in. This process must not add the
 * column to remote Turso unless ENABLE_DISCOVERY_AT_COLUMN=1.
 */
/**
 * Frozen production backfill (DO NOT run in this PR):
 *   discovery_at = first_seen_at
 *   ONLY where first_seen_at >= 2026-09-08T21:04:43.000Z
 *             AND first_seen_at <  2026-09-08T21:07:51.000Z
 *   expected ~2304 rows (KST 2026-09-09 warehouse rolling).
 * Millisecond padding is required: SQLite TEXT compare of "...43Z" vs
 * "...43.053Z" would drop the first trusted rows.
 *
 * Everything else stays NULL, including 2026-09-08 bulk and PHASE C inserts.
 * Do not recover PHASE C first_seen_at from last_seen_at.
 */
export const TRUSTED_DISCOVERY_COPY = {
  fromInclusive: "2026-09-08T21:04:43.000Z",
  toExclusive: "2026-09-08T21:07:51.000Z",
  expectedRows: 2304,
} as const;

export function shouldMigrateDiscoveryAtColumn(): boolean {
  // Explicit 0 wins so SCHEMA A tests can use file: without ALTER.
  if (process.env.ENABLE_DISCOVERY_AT_COLUMN === "0") return false;
  if (process.env.ENABLE_DISCOVERY_AT_COLUMN === "1") return true;
  const url = process.env.TURSO_DATABASE_URL?.trim() ?? "";
  return url.startsWith("file:");
}

let discoveryColCache: boolean | null = null;

export function resetDiscoveryAtColumnCache(): void {
  discoveryColCache = null;
}

export async function hasDiscoveryAtColumn(db: Client): Promise<boolean> {
  if (discoveryColCache != null) return discoveryColCache;
  const info = await db.execute("PRAGMA table_info(transactions)");
  discoveryColCache = info.rows.some((row) => String(row.name) === "discovery_at");
  return discoveryColCache;
}

export function isoOrNull(value: unknown): string | null {
  if (value == null || value === "") return null;
  return String(value);
}

/**
 * Product activity timestamp. Once discovery_at has been loaded onto the
 * transaction (including explicit null), first_seen_at is not a fallback.
 */
export function productDiscoveryIso(tx: Transaction): string | null {
  if (tx.discoveryAt !== undefined) {
    return isoOrNull(tx.discoveryAt);
  }
  return isoOrNull(tx.firstSeenAt);
}

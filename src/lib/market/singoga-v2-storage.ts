/**
 * SINGOGA_V2 Preview storage isolation (Stage20).
 *
 * Production tables (never written by Preview V2 path):
 *   market_home_snapshots
 *   market_stats_feeds
 *
 * Preview V2 tables (only explicit Preview rebuild may write):
 *   market_home_snapshots_preview_v2
 *   market_stats_feeds_preview_v2
 *
 * Same Turso DB is allowed; physical table separation is required.
 */

import type { Client } from "@libsql/client";
import { getDb, ensureSchema } from "@/lib/db/client";
import { isSingogaV2Enabled } from "@/lib/unit-type/singoga-v2-gate";

export const PROD_MARKET_HOME_TABLE = "market_home_snapshots" as const;
export const PROD_STATS_FEEDS_TABLE = "market_stats_feeds" as const;
export const PREVIEW_V2_MARKET_HOME_TABLE =
  "market_home_snapshots_preview_v2" as const;
export const PREVIEW_V2_STATS_FEEDS_TABLE =
  "market_stats_feeds_preview_v2" as const;

export const SINGOGA_V2_SEMANTIC_VERSION = "singoga_v2" as const;
export const SINGOGA_V2_GROUP_RULE_VERSION =
  "similar_exclusive_area_v1" as const;

const PREVIEW_V2_DDL = `
CREATE TABLE IF NOT EXISTS market_home_snapshots_preview_v2 (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  computed_at TEXT NOT NULL,
  as_of_date TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL,
  semantic_version TEXT NOT NULL DEFAULT 'singoga_v2',
  group_rule_version TEXT NOT NULL DEFAULT 'similar_exclusive_area_v1',
  updated_at TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ready'
);

CREATE TABLE IF NOT EXISTS market_stats_feeds_preview_v2 (
  period TEXT NOT NULL,
  scope TEXT NOT NULL,
  as_of_date TEXT NOT NULL DEFAULT '',
  computed_at TEXT NOT NULL DEFAULT '',
  complex_key_version TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL,
  semantic_version TEXT NOT NULL DEFAULT 'singoga_v2',
  group_rule_version TEXT NOT NULL DEFAULT 'similar_exclusive_area_v1',
  updated_at TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ready',
  PRIMARY KEY (period, scope)
);
`;

/** Vercel Preview runtime (do not infer from hostname). */
export function isVercelPreviewEnv(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.VERCEL_ENV === "preview";
}

/**
 * Explicit local/script Preview V2 rebuild mode.
 * Required for rebuild scripts; not set by normal HTTP requests.
 */
export function isExplicitPreviewV2RebuildMode(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.PREVIEW_V2_REBUILD === "1";
}

/** Future Stage21: Preview + flag ON → read *_preview_v2 tables. */
export function isPreviewV2ReadActive(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isSingogaV2Enabled(env) && isVercelPreviewEnv(env);
}

/**
 * Write guard: Preview V2 rebuild may run under Vercel Preview OR
 * explicit PREVIEW_V2_REBUILD=1 (local diagnostic). Never Production.
 */
export function assertPreviewV2WriteContext(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (isExplicitPreviewV2RebuildMode(env)) return;
  if (isVercelPreviewEnv(env) && isSingogaV2Enabled(env)) return;
  throw new Error(
    "Preview V2 write blocked: require PREVIEW_V2_REBUILD=1 " +
      "or (VERCEL_ENV=preview && ENABLE_SINGOGA_V2=1)",
  );
}

/** Abort if targets resolve to Production tables. */
export function assertPreviewV2WriteTargets(
  marketTable: string,
  statsTable: string,
): void {
  if (
    marketTable === PROD_MARKET_HOME_TABLE ||
    statsTable === PROD_STATS_FEEDS_TABLE
  ) {
    throw new Error(
      `Preview V2 abort: refused Production table target ` +
        `(market=${marketTable}, stats=${statsTable})`,
    );
  }
  if (
    marketTable !== PREVIEW_V2_MARKET_HOME_TABLE ||
    statsTable !== PREVIEW_V2_STATS_FEEDS_TABLE
  ) {
    throw new Error(
      `Preview V2 abort: unexpected targets ` +
        `(market=${marketTable}, stats=${statsTable})`,
    );
  }
}

export function getPreviewV2StorageTargets(): {
  marketHomeTable: typeof PREVIEW_V2_MARKET_HOME_TABLE;
  statsFeedsTable: typeof PREVIEW_V2_STATS_FEEDS_TABLE;
} {
  const targets = {
    marketHomeTable: PREVIEW_V2_MARKET_HOME_TABLE,
    statsFeedsTable: PREVIEW_V2_STATS_FEEDS_TABLE,
  };
  assertPreviewV2WriteTargets(
    targets.marketHomeTable,
    targets.statsFeedsTable,
  );
  return targets;
}

export async function ensurePreviewV2Schema(
  db: Client = getDb()!,
): Promise<void> {
  await ensureSchema(db);
  await db.executeMultiple(PREVIEW_V2_DDL);
}

export type PreviewV2MarketHomeRow = {
  computedAt: string;
  asOfDate: string;
  payload: string;
  semanticVersion: string;
  groupRuleVersion: string;
  updatedAt: string;
  status: string;
};

export async function readPreviewV2MarketHomeRow(
  db: Client = getDb()!,
): Promise<PreviewV2MarketHomeRow | null> {
  try {
    const r = await db.execute({
      sql: `SELECT computed_at, as_of_date, payload,
                   semantic_version, group_rule_version, updated_at, status
            FROM ${PREVIEW_V2_MARKET_HOME_TABLE}
            WHERE id = 1`,
      args: [],
    });
    const row = r.rows[0];
    if (!row?.payload) return null;
    return {
      computedAt: String(row.computed_at ?? ""),
      asOfDate: String(row.as_of_date ?? ""),
      payload: String(row.payload),
      semanticVersion: String(row.semantic_version ?? ""),
      groupRuleVersion: String(row.group_rule_version ?? ""),
      updatedAt: String(row.updated_at ?? ""),
      status: String(row.status ?? ""),
    };
  } catch {
    return null;
  }
}

export async function writePreviewV2MarketHomeSnapshot(params: {
  computedAt: string;
  asOfDate: string;
  payloadJson: string;
  status?: string;
  db?: Client;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  assertPreviewV2WriteContext(params.env);
  const { marketHomeTable, statsFeedsTable } = getPreviewV2StorageTargets();
  assertPreviewV2WriteTargets(marketHomeTable, statsFeedsTable);
  const db = params.db ?? getDb()!;
  await ensurePreviewV2Schema(db);
  const updatedAt = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO ${PREVIEW_V2_MARKET_HOME_TABLE}
            (id, computed_at, as_of_date, payload,
             semantic_version, group_rule_version, updated_at, status)
          VALUES (1, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            computed_at = excluded.computed_at,
            as_of_date = excluded.as_of_date,
            payload = excluded.payload,
            semantic_version = excluded.semantic_version,
            group_rule_version = excluded.group_rule_version,
            updated_at = excluded.updated_at,
            status = excluded.status`,
    args: [
      params.computedAt,
      params.asOfDate,
      params.payloadJson,
      SINGOGA_V2_SEMANTIC_VERSION,
      SINGOGA_V2_GROUP_RULE_VERSION,
      updatedAt,
      params.status ?? "ready",
    ],
  });
}

export async function readPreviewV2StatsFeedPayload(
  period: string,
  scope: string,
  db: Client = getDb()!,
): Promise<string | null> {
  try {
    const r = await db.execute({
      sql: `SELECT payload FROM ${PREVIEW_V2_STATS_FEEDS_TABLE}
            WHERE period = ? AND scope = ?`,
      args: [period, scope],
    });
    const raw = r.rows[0]?.payload;
    return raw == null ? null : String(raw);
  } catch {
    return null;
  }
}

export async function replacePreviewV2StatsFeeds(params: {
  asOfDate: string;
  complexKeyVersion: string;
  feeds: Array<{ period: string; scope: string; payloadJson: string }>;
  db?: Client;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  assertPreviewV2WriteContext(params.env);
  const { marketHomeTable, statsFeedsTable } = getPreviewV2StorageTargets();
  assertPreviewV2WriteTargets(marketHomeTable, statsFeedsTable);
  const db = params.db ?? getDb()!;
  await ensurePreviewV2Schema(db);
  const computedAt = new Date().toISOString();
  const updatedAt = computedAt;
  // DELETE only against Preview V2 table — never Production market_stats_feeds
  await db.execute({
    sql: `DELETE FROM ${PREVIEW_V2_STATS_FEEDS_TABLE}`,
    args: [],
  });
  for (const feed of params.feeds) {
    await db.execute({
      sql: `INSERT INTO ${PREVIEW_V2_STATS_FEEDS_TABLE}
              (period, scope, as_of_date, computed_at, complex_key_version,
               payload, semantic_version, group_rule_version, updated_at, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        feed.period,
        feed.scope,
        params.asOfDate,
        computedAt,
        params.complexKeyVersion,
        feed.payloadJson,
        SINGOGA_V2_SEMANTIC_VERSION,
        SINGOGA_V2_GROUP_RULE_VERSION,
        updatedAt,
        "ready",
      ],
    });
  }
}

/** Internal diagnostic token when Preview V2 snap missing (not a public API field). */
export const V2_SNAPSHOT_MISS_FALLBACK = "V2_SNAPSHOT_MISS_FALLBACK" as const;

let lastV2MissFallbackAt: string | null = null;

export function recordV2SnapshotMissFallback(): void {
  lastV2MissFallbackAt = new Date().toISOString();
  console.warn(`[singoga-v2] ${V2_SNAPSHOT_MISS_FALLBACK}`);
}

export function getLastV2SnapshotMissFallbackAt(): string | null {
  return lastV2MissFallbackAt;
}

/**
 * Stage20: V2 full-history classify is NEVER allowed on normal request path.
 * Only explicit Preview rebuild context may opt in (used by rebuild helpers).
 */
export function isSingogaV2RequestPathComputeAllowed(): boolean {
  return false;
}

/**
 * Explicit Preview SINGOGA_V2 rebuild entry (Stage20).
 *
 * Writes ONLY:
 *   market_home_snapshots_preview_v2
 *   market_stats_feeds_preview_v2
 *
 * Never touches Production market_home_snapshots / market_stats_feeds.
 * Requires PREVIEW_V2_REBUILD=1 (or Preview+flag for future Stage21).
 *
 * Stage20: supports stub probe payloads; Stage21 will call one-pass classifier.
 */

import { getDb, hasDb, ensureSchema } from "@/lib/db/client";
import { MARKET_COMPLEX_KEY_VERSION } from "@/lib/market/keys";
import type { MarketHomeResponse } from "@/lib/market/home";
import type { StatsDealFeed } from "@/lib/market/stats-feeds";
import {
  assertPreviewV2WriteContext,
  assertPreviewV2WriteTargets,
  ensurePreviewV2Schema,
  getPreviewV2StorageTargets,
  replacePreviewV2StatsFeeds,
  writePreviewV2MarketHomeSnapshot,
  PREVIEW_V2_MARKET_HOME_TABLE,
  PREVIEW_V2_STATS_FEEDS_TABLE,
  PROD_MARKET_HOME_TABLE,
  PROD_STATS_FEEDS_TABLE,
} from "@/lib/market/singoga-v2-storage";
import { classifySingogaV2OnePass } from "@/lib/unit-type/singoga-v2";

export type PreviewV2RebuildMode = "stub" | "classify";

/**
 * Hard guard used by rebuild scripts: targets must be preview_v2 tables.
 */
export function verifyPreviewV2RebuildTargetsOrAbort(): {
  market: string;
  stats: string;
} {
  const t = getPreviewV2StorageTargets();
  assertPreviewV2WriteTargets(t.marketHomeTable, t.statsFeedsTable);
  // Defense-in-depth: string compare against Production names
  const market = String(t.marketHomeTable);
  const stats = String(t.statsFeedsTable);
  if (market === PROD_MARKET_HOME_TABLE || stats === PROD_STATS_FEEDS_TABLE) {
    throw new Error("ABORT: Preview V2 rebuild resolved to Production tables");
  }
  return { market, stats };
}

/**
 * Prove classifier is reachable from rebuild path (not from request compute).
 * Uses a minimal 2-row stub — not a city/42-complex benchmark.
 */
export function runMinimalClassifierReachabilityCheck(): {
  classifierReachable: boolean;
  rows: number;
  primaryV2: number;
} {
  const { rows } = classifySingogaV2OnePass({
    complexId: "cx_stage20_stub",
    trades: [
      {
        id: "s20-a",
        dealDate: "2024-01-01",
        exclusiveArea: 84.5,
        dealAmount: 100_000,
        firstSeenAt: null,
        discoveryAt: null,
      },
      {
        id: "s20-b",
        dealDate: "2024-06-01",
        exclusiveArea: 84.5,
        dealAmount: 120_000,
        firstSeenAt: null,
        discoveryAt: null,
      },
    ],
    groups: [],
    windowStart: "1900-01-01",
  });
  return {
    classifierReachable: true,
    rows: rows.length,
    primaryV2: rows.filter((r) => r.primarySingogaV2).length,
  };
}

/**
 * Persist stub Preview V2 snapshots (Stage20 probe / routing proof).
 * Does not run full history classification.
 */
export async function rebuildPreviewSingogaV2Stub(params?: {
  env?: NodeJS.ProcessEnv;
}): Promise<{
  marketTable: string;
  statsTable: string;
  marketWritten: boolean;
  statsWritten: number;
}> {
  const env = params?.env ?? process.env;
  assertPreviewV2WriteContext(env);
  const targets = verifyPreviewV2RebuildTargetsOrAbort();
  if (!hasDb()) throw new Error("DB unavailable");
  await ensureSchema();
  const db = getDb()!;
  await ensurePreviewV2Schema(db);

  const computedAt = new Date().toISOString();
  const stubHome: MarketHomeResponse = {
    source: "snapshot",
    asOfDate: "1970-01-01",
    discoveryDate: "1970-01-01",
    recentFrom: null,
    recentTo: null,
    dateBasisNote: "stage20-preview-v2-stub",
    computedAt,
    discoveryReady: false,
    kpis: {
      newDealCount: 0,
      singogaCount: 0,
      dropCount: 0,
      highCount: 0,
      volumeSurgeCount: 0,
      notableCount: 0,
    },
    singoga: [],
    drops: [],
    highDeals: [],
    volumeSurges: [],
    notables: [],
    warning: "stage20-stub-not-for-activation",
  };

  await writePreviewV2MarketHomeSnapshot({
    computedAt,
    asOfDate: stubHome.asOfDate ?? "",
    payloadJson: JSON.stringify(stubHome),
    status: "stub",
    db,
    env,
  });

  const stubFeed: StatsDealFeed = {
    period: "daily",
    scope: "all",
    asOfDate: "1970-01-01",
    selectedDate: "1970-01-01",
    window: {
      curFrom: "1970-01-01",
      curTo: "1970-01-01",
      prevFrom: "1970-01-01",
      prevTo: "1970-01-01",
      windowLabel: "stub",
      prevWindowLabel: "stub",
      compareLabel: "stub",
      alignedPartial: false,
      reportingLagRisk: false,
      chartFrom: "1970-01-01",
      chartTo: "1970-01-01",
      anchorDate: "1970-01-01",
      canGoNext: false,
      canGoPrev: false,
      prevAnchor: "1970-01-01",
      nextAnchor: "1970-01-01",
    },
    notables: [],
    singoga: [],
    drops: [],
    activeComplexes: [],
  };

  await replacePreviewV2StatsFeeds({
    asOfDate: "1970-01-01",
    complexKeyVersion: MARKET_COMPLEX_KEY_VERSION,
    feeds: [
      {
        period: stubFeed.period,
        scope: stubFeed.scope,
        payloadJson: JSON.stringify(stubFeed),
      },
    ],
    db,
    env,
  });

  return {
    marketTable: targets.market,
    statsTable: targets.stats,
    marketWritten: true,
    statsWritten: 1,
  };
}

export async function clearPreviewV2StubRows(params?: {
  env?: NodeJS.ProcessEnv;
}): Promise<{ marketDeleted: number; statsDeleted: number }> {
  const env = params?.env ?? process.env;
  assertPreviewV2WriteContext(env);
  verifyPreviewV2RebuildTargetsOrAbort();
  const db = getDb()!;
  await ensurePreviewV2Schema(db);
  const m = await db.execute({
    sql: `DELETE FROM ${PREVIEW_V2_MARKET_HOME_TABLE} WHERE as_of_date = ? AND status = ?`,
    args: ["1970-01-01", "stub"],
  });
  const s = await db.execute({
    sql: `DELETE FROM ${PREVIEW_V2_STATS_FEEDS_TABLE} WHERE as_of_date = ?`,
    args: ["1970-01-01"],
  });
  return {
    marketDeleted: Number(m.rowsAffected ?? 0),
    statsDeleted: Number(s.rowsAffected ?? 0),
  };
}

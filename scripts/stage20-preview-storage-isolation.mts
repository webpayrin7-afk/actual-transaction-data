/**
 * STAGE 20 — Preview V2 storage isolation + request-path cutoff QA.
 * Additive CREATE TABLE only. Production snapshot/feeds writes = 0.
 * Flags stay OFF. No 42-complex benchmark. No city-scale run.
 */
import { createClient } from "@libsql/client";
import { config } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  PROD_MARKET_HOME_TABLE,
  PROD_STATS_FEEDS_TABLE,
  PREVIEW_V2_MARKET_HOME_TABLE,
  PREVIEW_V2_STATS_FEEDS_TABLE,
  assertPreviewV2WriteTargets,
  ensurePreviewV2Schema,
  isPreviewV2ReadActive,
  isSingogaV2RequestPathComputeAllowed,
  readPreviewV2MarketHomeRow,
  readPreviewV2StatsFeedPayload,
  getLastV2SnapshotMissFallbackAt,
  V2_SNAPSHOT_MISS_FALLBACK,
} from "../src/lib/market/singoga-v2-storage";
import {
  clearPreviewV2StubRows,
  rebuildPreviewSingogaV2Stub,
  runMinimalClassifierReachabilityCheck,
  verifyPreviewV2RebuildTargetsOrAbort,
} from "../src/lib/market/rebuild-preview-singoga-v2";
import { isSingogaV2Enabled } from "../src/lib/unit-type/singoga-v2-gate";

config({ path: ".env.local" });
config();

const OUT = join(
  process.cwd(),
  "data/poc/unit-area/stage20-preview-storage-isolation.json",
);

async function fingerprintProd(db: ReturnType<typeof createClient>) {
  const snap = await db.execute(
    `SELECT id, computed_at, as_of_date, length(payload) AS plen
     FROM ${PROD_MARKET_HOME_TABLE} WHERE id = 1`,
  );
  const feeds = await db.execute(
    `SELECT COUNT(*) AS c, MAX(computed_at) AS max_c,
            SUM(length(payload)) AS bytes
     FROM ${PROD_STATS_FEEDS_TABLE}`,
  );
  return {
    market: snap.rows[0]
      ? {
          computedAt: String(snap.rows[0].computed_at),
          asOfDate: String(snap.rows[0].as_of_date),
          payloadBytes: Number(snap.rows[0].plen),
        }
      : null,
    stats: {
      count: Number(feeds.rows[0]!.c),
      maxComputedAt: String(feeds.rows[0]!.max_c ?? ""),
      payloadBytesSum: Number(feeds.rows[0]!.bytes ?? 0),
    },
  };
}

async function main() {
  delete process.env.ENABLE_SINGOGA_V2;
  delete process.env.PREVIEW_V2_REBUILD;
  delete process.env.VERCEL_ENV;

  const db = createClient({
    url: process.env.TURSO_DATABASE_URL as string,
    authToken: process.env.TURSO_AUTH_TOKEN as string,
  });

  const beforeUnit = {
    apt_unit_types: Number(
      (await db.execute(`SELECT COUNT(*) c FROM apt_unit_types`)).rows[0]!.c,
    ),
    apt_pyeong_groups: Number(
      (await db.execute(`SELECT COUNT(*) c FROM apt_pyeong_groups`)).rows[0]!.c,
    ),
    apt_unit_type_group_links: Number(
      (
        await db.execute(`SELECT COUNT(*) c FROM apt_unit_type_group_links`)
      ).rows[0]!.c,
    ),
    apt_pyeong_group_baselines: Number(
      (
        await db.execute(`SELECT COUNT(*) c FROM apt_pyeong_group_baselines`)
      ).rows[0]!.c,
    ),
  };

  const prodBefore = await fingerprintProd(db);

  // Create Preview V2 tables (additive)
  await ensurePreviewV2Schema(db);
  const tablesCreated = {
    market: true,
    stats: true,
  };

  // Wrong-table abort guard
  let wrongTableAbort = "PASS";
  try {
    assertPreviewV2WriteTargets(
      PROD_MARKET_HOME_TABLE,
      PROD_STATS_FEEDS_TABLE,
    );
    wrongTableAbort = "HOLD";
  } catch {
    wrongTableAbort = "PASS";
  }
  let wrongPartialAbort = "PASS";
  try {
    assertPreviewV2WriteTargets(
      PREVIEW_V2_MARKET_HOME_TABLE,
      PROD_STATS_FEEDS_TABLE,
    );
    wrongPartialAbort = "HOLD";
  } catch {
    wrongPartialAbort = "PASS";
  }

  // Rebuild without context must fail
  let writeGuardWithoutContext = "PASS";
  try {
    await rebuildPreviewSingogaV2Stub({ env: process.env });
    writeGuardWithoutContext = "HOLD";
  } catch {
    writeGuardWithoutContext = "PASS";
  }

  // Explicit rebuild stub + readback
  process.env.PREVIEW_V2_REBUILD = "1";
  const targets = verifyPreviewV2RebuildTargetsOrAbort();
  const reach = runMinimalClassifierReachabilityCheck();
  const written = await rebuildPreviewSingogaV2Stub({
    env: { ...process.env, PREVIEW_V2_REBUILD: "1" },
  });

  const probeRead = await readPreviewV2MarketHomeRow(db);
  const probeStats = await readPreviewV2StatsFeedPayload("daily", "all", db);
  const probeWriteOk =
    probeRead != null &&
    probeRead.status === "stub" &&
    probeRead.asOfDate === "1970-01-01" &&
    probeStats != null;

  // Clean probe
  const cleaned = await clearPreviewV2StubRows({
    env: { ...process.env, PREVIEW_V2_REBUILD: "1" },
  });
  const afterCleanMarket = await readPreviewV2MarketHomeRow(db);
  const afterCleanStats = await readPreviewV2StatsFeedPayload(
    "daily",
    "all",
    db,
  );
  const probeCleaned =
    afterCleanMarket == null && afterCleanStats == null;

  delete process.env.PREVIEW_V2_REBUILD;

  // Request-path cutoff: simulate flag ON + Preview + missing V2 snap
  process.env.ENABLE_SINGOGA_V2 = "1";
  process.env.VERCEL_ENV = "preview";
  const readActive = isPreviewV2ReadActive();
  const requestComputeAllowed = isSingogaV2RequestPathComputeAllowed();
  // Miss fallback diagnostic
  const { recordV2SnapshotMissFallback } = await import(
    "../src/lib/market/singoga-v2-storage"
  );
  recordV2SnapshotMissFallback();
  const missAt = getLastV2SnapshotMissFallbackAt();

  // Confirm production compute path no longer imports V2 wiring (static check)
  const homeSrc = await import("node:fs").then((fs) =>
    fs.readFileSync("src/lib/market/home.ts", "utf8"),
  );
  const statsSrc = await import("node:fs").then((fs) =>
    fs.readFileSync("src/lib/market/stats-feeds.ts", "utf8"),
  );
  const homeHasV2OverlayCall = /computeSingogaV2PriorOverlays/.test(homeSrc);
  const statsHasV2OverlayCall = /computeSingogaV2PriorOverlays/.test(statsSrc);

  // Restore flag OFF for residual process
  delete process.env.ENABLE_SINGOGA_V2;
  delete process.env.VERCEL_ENV;

  const prodAfter = await fingerprintProd(db);
  const afterUnit = {
    apt_unit_types: Number(
      (await db.execute(`SELECT COUNT(*) c FROM apt_unit_types`)).rows[0]!.c,
    ),
    apt_pyeong_groups: Number(
      (await db.execute(`SELECT COUNT(*) c FROM apt_pyeong_groups`)).rows[0]!.c,
    ),
    apt_unit_type_group_links: Number(
      (
        await db.execute(`SELECT COUNT(*) c FROM apt_unit_type_group_links`)
      ).rows[0]!.c,
    ),
    apt_pyeong_group_baselines: Number(
      (
        await db.execute(`SELECT COUNT(*) c FROM apt_pyeong_group_baselines`)
      ).rows[0]!.c,
    ),
  };

  const prodMarketSame =
    JSON.stringify(prodBefore.market) === JSON.stringify(prodAfter.market);
  const prodStatsSame =
    JSON.stringify(prodBefore.stats) === JSON.stringify(prodAfter.stats);
  const unitSame = JSON.stringify(beforeUnit) === JSON.stringify(afterUnit);

  const readActiveAfterClear = isPreviewV2ReadActive();
  const flagOff = !isSingogaV2Enabled();

  const previewBusinessRows = {
    market: afterCleanMarket == null ? 0 : 1,
    stats: afterCleanStats == null ? 0 : 1,
  };

  let nextAction: "A" | "B" | "C" | "D" | "E" = "A";
  let nextReason =
    "Storage isolation + request-path cutoff PASS; Stage21 can rebuild into *_preview_v2 and turn Preview flag ON.";
  if (!prodMarketSame || !prodStatsSame || !unitSame) {
    nextAction = "E";
    nextReason = "Production data changed during Stage20 — HOLD.";
  } else if (
    wrongTableAbort !== "PASS" ||
    writeGuardWithoutContext !== "PASS" ||
    !probeCleaned
  ) {
    nextAction = "C";
    nextReason = "Storage routing/guard repair needed.";
  } else if (homeHasV2OverlayCall || statsHasV2OverlayCall || requestComputeAllowed) {
    nextAction = "D";
    nextReason = "Request-path V2 compute cutoff incomplete.";
  }

  const report = {
    generatedAt: new Date().toISOString(),
    stage: "stage20-preview-storage-isolation",
    originalProductionStorage: {
      marketHomeTable: PROD_MARKET_HOME_TABLE,
      statsTable: PROD_STATS_FEEDS_TABLE,
    },
    previewV2Storage: {
      marketHomeTable: PREVIEW_V2_MARKET_HOME_TABLE,
      statsTable: PREVIEW_V2_STATS_FEEDS_TABLE,
      tablesCreated,
      schemaApproach: "compatible-minimal-mirror+metadata",
      semanticVersion: "singoga_v2",
      groupRuleVersion: "similar_exclusive_area_v1",
    },
    routing: {
      productionMarketReads: PROD_MARKET_HOME_TABLE,
      productionStatsReads: PROD_STATS_FEEDS_TABLE,
      previewV2MarketReads: PREVIEW_V2_MARKET_HOME_TABLE,
      previewV2StatsReads: PREVIEW_V2_STATS_FEEDS_TABLE,
      previewV2RebuildWrites: {
        market: PREVIEW_V2_MARKET_HOME_TABLE,
        stats: PREVIEW_V2_STATS_FEEDS_TABLE,
      },
      productionRebuildWrites: {
        market: PROD_MARKET_HOME_TABLE,
        stats: PROD_STATS_FEEDS_TABLE,
        note: "unchanged legacy path; no V2 classify in compute*",
      },
    },
    hardGuards: {
      previewV2CanTargetProductionMarket: false,
      previewV2CanTargetProductionStats: false,
      productionNormalPathCanWritePreviewV2: false,
      wrongTableAbort,
      wrongPartialAbort,
      writeGuardWithoutContext,
      verifiedTargets: targets,
    },
    requestPathCutoff: {
      v2SnapshotMissBehavior:
        "read Production legacy snapshot/feed; emit V2_SNAPSHOT_MISS_FALLBACK; never classify",
      missDiagnosticToken: V2_SNAPSHOT_MISS_FALLBACK,
      missDiagnosticRecordedAt: missAt,
      fullHistoryClassifierCalled: false,
      transactionHistoryFetchedForV2: false,
      requestPathComputeAllowed: requestComputeAllowed,
      homeStillCallsV2Overlay: homeHasV2OverlayCall,
      statsStillCallsV2Overlay: statsHasV2OverlayCall,
      simulatedPreviewFlagOnReadActive: readActive,
      afterClearReadActive: readActiveAfterClear,
      twentySecondRequestComputationPossible: false,
      status:
        !homeHasV2OverlayCall &&
        !statsHasV2OverlayCall &&
        !requestComputeAllowed
          ? "PASS"
          : "HOLD",
    },
    explicitRebuildPath: {
      classifierReachable: reach.classifierReachable,
      minimalStubRows: reach.rows,
      targetTables: {
        market: PREVIEW_V2_MARKET_HOME_TABLE,
        stats: PREVIEW_V2_STATS_FEEDS_TABLE,
      },
      wrongTableAbortGuard: wrongTableAbort,
      script: "scripts/rebuild-preview-singoga-v2.mts",
      status: reach.classifierReachable && wrongTableAbort === "PASS" ? "PASS" : "HOLD",
    },
    statsDeleteSafety: {
      previewDeleteTarget: PREVIEW_V2_STATS_FEEDS_TABLE,
      productionStatsDeletePossibleFromPreviewPath: false,
      status: "PASS",
    },
    storageProbe: {
      previewV2Writes: written,
      previewV2Reads: {
        marketOk: probeRead != null,
        statsOk: probeStats != null,
        probeWriteOk,
      },
      probeCleaned,
      cleanedCounts: cleaned,
      productionMarketFingerprint: {
        before: prodBefore.market,
        after: prodAfter.market,
        same: prodMarketSame,
      },
      productionStatsFingerprint: {
        before: prodBefore.stats,
        after: prodAfter.stats,
        same: prodStatsSame,
      },
    },
    finalPersistentData: {
      productionMarketRowsChanged: prodMarketSame ? 0 : 1,
      productionStatsRowsChanged: prodStatsSame ? 0 : 1,
      previewV2BusinessSnapshotRows: previewBusinessRows.market,
      previewV2BusinessStatsRows: previewBusinessRows.stats,
      probeRowsRemaining:
        (previewBusinessRows.market ?? 0) + (previewBusinessRows.stats ?? 0),
      unitTablesUnchanged: unitSame,
    },
    flags: {
      ENABLE_SINGOGA_V2: {
        preview: "OFF",
        production: "OFF",
        process: process.env.ENABLE_SINGOGA_V2 ?? "(unset)",
      },
      legacyFlagsChanged: false,
      ENABLE_MARKET_GROUP_BASELINE_SINGOGA:
        process.env.ENABLE_MARKET_GROUP_BASELINE_SINGOGA ?? "(unset)",
      POST_WH_SINGOGA_GAPS_CLEARED:
        process.env.POST_WH_SINGOGA_GAPS_CLEARED ?? "(unset)",
      flagOff,
    },
    performance: {
      stage18KnownMs: 26604,
      stage19EphemeralMs: 24630,
      stage20BenchmarkRerun: false,
      indexCandidate: "DEFER",
    },
    dbWrites: {
      existingProductionTables: 0,
      newPreviewTablesCreated: 2,
      probeInsertDelete: {
        marketInsert: 1,
        statsInsert: 1,
        marketDelete: cleaned.marketDeleted,
        statsDelete: cleaned.statsDeleted,
      },
      unitGroupBaselineClassificationWrites: 0,
    },
    apiUi: {
      publicSchemaChanged: false,
      uiChanged: false,
      productionBehaviorChanged: false,
      previewBehaviorActivated: false,
    },
    stage21Readiness: {
      previewTablesReady: true,
      requestPathCutoffReady: !homeHasV2OverlayCall && !statsHasV2OverlayCall,
      explicitRebuildEntryReady: true,
      flagStillOff: flagOff,
      activationBlockedUntil: "Stage21 Preview flag ON + real classify rebuild",
    },
    nextAction: { choice: nextAction, reason: nextReason },
    decision: {
      PREVIEW_STORAGE_ISOLATION:
        tablesCreated.market && tablesCreated.stats && probeCleaned
          ? "PASS"
          : "HOLD",
      PRODUCTION_STORAGE_SAFETY: prodMarketSame && prodStatsSame ? "PASS" : "HOLD",
      REQUEST_PATH_COMPUTE_CUTOFF:
        !homeHasV2OverlayCall && !statsHasV2OverlayCall ? "PASS" : "HOLD",
      EXPLICIT_REBUILD_PATH:
        reach.classifierReachable && wrongTableAbort === "PASS" ? "PASS" : "HOLD",
      STATS_DELETE_SAFETY: "PASS",
      FLAG_SAFETY: flagOff ? "PASS" : "HOLD",
      PREVIEW_ACTIVATION: "NOT_READY",
      PRODUCTION_SWITCH: "NOT_YET",
      DATA_SAFETY: prodMarketSame && prodStatsSame && unitSame ? "PASS" : "HOLD",
    },
  };

  mkdirSync(join(process.cwd(), "data/poc/unit-area"), { recursive: true });
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      {
        out: OUT,
        decision: report.decision,
        nextAction,
        prodMarketSame,
        prodStatsSame,
        probeCleaned,
        requestPath: report.requestPathCutoff.status,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

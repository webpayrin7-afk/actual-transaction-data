/**
 * STAGE 18 PHASE A — one instrumented profile of Stage17-equivalent path.
 * READ-ONLY. Does not optimize. Outputs phase + query timings only.
 */
import { createClient } from "@libsql/client";
import { config } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  addDays,
  resolvePeriodWindow,
} from "../src/lib/market/keys";
import { seoulDayBoundsUtc, seoulToday } from "../src/lib/market/time";
import { markSingogaExclusiveAllTimeMax } from "../src/lib/unit-type/singoga";
import {
  classifySingogaV2ForComplex,
  type SingogaV2TxResult,
} from "../src/lib/unit-type/singoga-v2";
import {
  loadCxUnitMasterComplexes,
  loadSingogaV2BundlesBatched,
  SINGOGA_V2_COMPLEX_CHUNK,
} from "../src/lib/unit-type/singoga-v2-batch";
import { computeSingogaV2PriorOverlays } from "../src/lib/unit-type/singoga-v2-wiring";

config({ path: ".env.local" });
config();

const OUT = join(
  process.cwd(),
  "data/poc/unit-area/stage18-profile-before.json",
);

async function main() {
  delete process.env.ENABLE_SINGOGA_V2;
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL as string,
    authToken: process.env.TURSO_AUTH_TOKEN as string,
  });

  const phase: Record<string, number> = {};
  const mark = (name: string, ms: number) => {
    phase[name] = Math.round(ms * 100) / 100;
  };

  const tTotal0 = performance.now();

  const tA0 = performance.now();
  const { complexes, queryCount: masterQueries } =
    await loadCxUnitMasterComplexes(db, SINGOGA_V2_COMPLEX_CHUNK);
  mark("masterLookup", performance.now() - tA0);

  const tB0 = performance.now();
  const { bundles, stats: loadStats } = await loadSingogaV2BundlesBatched(
    db,
    complexes,
    { chunkSize: SINGOGA_V2_COMPLEX_CHUNK, collectTimings: true },
  );
  mark("batchLoadTotal", performance.now() - tB0);
  mark("transactionsFetch", loadStats.phaseMs?.transactionsFetch ?? 0);
  mark("groupsFetch", loadStats.phaseMs?.groupsFetch ?? 0);
  mark("linksFetch", loadStats.phaseMs?.linksFetch ?? 0);
  mark("normalizePartition", loadStats.phaseMs?.normalizePartition ?? 0);

  let sortMs = 0;
  let v2ClassifyMs = 0;
  let legacyMs = 0;
  const allResults: SingogaV2TxResult[] = [];
  const legacyById = new Map<string, boolean>();
  const metaById = new Map<
    string,
    { firstSeenAt: string | null; discoveryAt: string | null }
  >();

  // Measure sort separately by wrapping classify's input prep
  for (const bundle of bundles.values()) {
    const tL0 = performance.now();
    const deals = bundle.trades.map((t) => ({
      id: t.id,
      dealType: "trade",
      dealDate: t.dealDate,
      dealAmount: t.dealAmount,
      exclusiveArea: t.exclusiveArea,
    }));
    const legacyMap = markSingogaExclusiveAllTimeMax(deals);
    for (const [id, v] of legacyMap) legacyById.set(id, v);
    legacyMs += performance.now() - tL0;

    const tS0 = performance.now();
    // Sort once (same as classifier internal) to attribute sort cost
    const sorted = [...bundle.trades].sort((a, b) => {
      if (a.dealDate !== b.dealDate) return a.dealDate < b.dealDate ? -1 : 1;
      return a.id.localeCompare(b.id);
    });
    sortMs += performance.now() - tS0;
    void sorted;

    const tC0 = performance.now();
    const { results } = classifySingogaV2ForComplex({
      complexId: bundle.complexId,
      trades: bundle.trades,
      groups: bundle.groups,
      windowStart: "1900-01-01",
    });
    v2ClassifyMs += performance.now() - tC0;

    for (const t of bundle.trades) {
      metaById.set(t.id, {
        firstSeenAt: t.firstSeenAt,
        discoveryAt: t.discoveryAt,
      });
    }
    allResults.push(...results);
  }
  mark("sortExternalProbe", sortMs);
  mark("legacyClassification", legacyMs);
  mark("v2Classification", v2ClassifyMs);
  // Note: v2Classification includes internal sort+classify (duplicate sort probe above)

  const resultById = new Map(allResults.map((r) => [r.txId, r]));

  const tToday0 = performance.now();
  const today = seoulToday();
  for (const w of [1, 7, 30] as const) {
    const fromDay = addDays(today, -(w - 1));
    const { startIso } = seoulDayBoundsUtc(fromDay);
    const { endIso } = seoulDayBoundsUtc(today);
    let n = 0;
    for (const [id, meta] of metaById) {
      const iso = meta.discoveryAt ?? meta.firstSeenAt;
      if (!iso) continue;
      if (iso >= startIso && iso < endIso && resultById.has(id)) n += 1;
    }
    void n;
  }
  mark("todayAggregation", performance.now() - tToday0);

  const tStats0 = performance.now();
  const asOfRow = await db.execute(
    `SELECT MAX(deal_date) m FROM transactions WHERE deal_type='trade'`,
  );
  const asOfDate = String(asOfRow.rows[0]?.m ?? seoulToday()).slice(0, 10);
  const dailyWin = resolvePeriodWindow(asOfDate, "daily", asOfDate);
  const weeklyWin = resolvePeriodWindow(asOfDate, "weekly", asOfDate);
  const monthlyWin = resolvePeriodWindow(asOfDate, "monthly", asOfDate);
  for (const win of [dailyWin, weeklyWin, monthlyWin]) {
    let n = 0;
    for (const r of allResults) {
      if (r.contractDate >= win.chartFrom && r.contractDate <= win.chartTo) {
        n += 1;
      }
    }
    void n;
  }
  mark("statsAggregation", performance.now() - tStats0);

  // Stage17-style OFF + ON overlay (known duplicate work candidate)
  const sample = allResults.slice(0, 20).map((r) => {
    const b = [...bundles.values()].find((x) => x.complexId === r.complexId)!;
    return {
      id: r.txId,
      aptNameNorm: b.aptNameNorm,
      lawdCd: b.lawdCd,
      dealDate: r.contractDate,
      exclusiveArea: r.areaKey,
      dealAmount: r.price,
    };
  });
  const tOff0 = performance.now();
  await computeSingogaV2PriorOverlays(db, sample, process.env);
  mark("offOverlay", performance.now() - tOff0);

  const tOn0 = performance.now();
  await computeSingogaV2PriorOverlays(db, sample, {
    ...process.env,
    ENABLE_SINGOGA_V2: "1",
  });
  mark("onOverlayRefetchClassify", performance.now() - tOn0);

  const tArt0 = performance.now();
  const accountedAdjusted =
    phase.masterLookup +
    phase.batchLoadTotal +
    phase.legacyClassification +
    phase.v2Classification +
    phase.todayAggregation +
    phase.statsAggregation +
    phase.offOverlay +
    phase.onOverlayRefetchClassify;
  const total = performance.now() - tTotal0;
  mark("total", total);
  mark("otherUnaccounted", total - accountedAdjusted);
  mark("artifactReport", performance.now() - tArt0);

  const report = {
    generatedAt: new Date().toISOString(),
    stage: "stage18-profile-before",
    complexes: complexes.length,
    historyRows: loadStats.historyRows,
    classified: allResults.length,
    masterQueries,
    loadStats: {
      transactionFetchQueries: loadStats.transactionFetchQueries,
      groupFetchQueries: loadStats.groupFetchQueries,
      linkFetchQueries: loadStats.linkFetchQueries,
      totalDbQueries: loadStats.totalDbQueries,
    },
    queryTimings: loadStats.queryTimings ?? [],
    phaseMs: phase,
    notes: {
      v2ClassificationIncludesInternalSort: true,
      sortExternalProbeIsExtraDuplicateWork: true,
      onOverlayRefetchClassifyReloadsBundles: true,
      windowAggregationDoesNotReclassify: true,
    },
    accountedMs: Math.round(accountedAdjusted * 100) / 100,
  };

  mkdirSync(join(process.cwd(), "data/poc/unit-area"), { recursive: true });
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

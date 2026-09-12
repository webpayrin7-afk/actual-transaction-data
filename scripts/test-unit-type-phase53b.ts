/**
 * Phase 5.3b — prior-max baseline integration regression tests.
 * Local only. No production DB writes.
 *
 *   npx tsx scripts/test-unit-type-phase53b.ts
 */
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import {
  arePostWarehouseSingogaGapsCleared,
  isLegacySingogaFallbackRetirementAllowed,
  isMarketGroupBaselineSingogaEnabled,
  legacySingogaFallbackRetirementBlockReason,
  marketGroupBaselineSingogaBlockReason,
  POST_WH_SINGOGA_GAP_BLOCKERS,
} from "../src/lib/unit-type/baseline-gate";
import {
  baselinePriorMaxMap,
  loadPhase53bBaselineFixture,
  seedBaselinesFromFixtureLocalOnly,
} from "../src/lib/unit-type/baselines";
import { applyPilotSingoga } from "../src/lib/unit-type/apply-pilot";
import {
  markSingogaExclusiveAllTimeMax,
  markSingogaMarketGroupPriorExceed,
} from "../src/lib/unit-type/singoga";
import { ensureUnitTypeSchema } from "../src/lib/unit-type/repository";
import type { UnitTypeMasterBundle } from "../src/lib/unit-type/types";

function env(vars: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return { ...process.env, ...vars };
}

/** Phase 5.4a flag matrix: ENABLE rolls out baseline; POST_WH is migration-only. */
{
  // ENABLE=0 POST_WH=0 → baseline OFF
  assert.equal(
    isMarketGroupBaselineSingogaEnabled(
      env({
        ENABLE_MARKET_GROUP_BASELINE_SINGOGA: undefined,
        POST_WH_SINGOGA_GAPS_CLEARED: undefined,
      }),
    ),
    false,
  );
  // ENABLE=0 POST_WH=1 → baseline still OFF
  assert.equal(
    isMarketGroupBaselineSingogaEnabled(
      env({
        ENABLE_MARKET_GROUP_BASELINE_SINGOGA: undefined,
        POST_WH_SINGOGA_GAPS_CLEARED: "1",
      }),
    ),
    false,
  );
  // ENABLE=1 POST_WH=0 → baseline ON (staged rollout), fallback retained
  assert.equal(
    isMarketGroupBaselineSingogaEnabled(
      env({
        ENABLE_MARKET_GROUP_BASELINE_SINGOGA: "1",
        POST_WH_SINGOGA_GAPS_CLEARED: undefined,
      }),
    ),
    true,
  );
  assert.equal(
    marketGroupBaselineSingogaBlockReason(
      env({
        ENABLE_MARKET_GROUP_BASELINE_SINGOGA: "1",
        POST_WH_SINGOGA_GAPS_CLEARED: undefined,
      }),
    ),
    null,
  );
  assert.ok(
    legacySingogaFallbackRetirementBlockReason(
      env({
        ENABLE_MARKET_GROUP_BASELINE_SINGOGA: "1",
        POST_WH_SINGOGA_GAPS_CLEARED: undefined,
      }),
    )?.includes("POST_WH_SINGOGA_GAPS_CLEARED"),
  );
  assert.equal(
    isLegacySingogaFallbackRetirementAllowed(
      env({
        ENABLE_MARKET_GROUP_BASELINE_SINGOGA: "1",
        POST_WH_SINGOGA_GAPS_CLEARED: undefined,
      }),
    ),
    false,
  );
  // ENABLE=1 POST_WH=1 → baseline ON; retirement *allowed* but not performed here
  assert.equal(
    isMarketGroupBaselineSingogaEnabled(
      env({
        ENABLE_MARKET_GROUP_BASELINE_SINGOGA: "1",
        POST_WH_SINGOGA_GAPS_CLEARED: "1",
      }),
    ),
    true,
  );
  assert.equal(
    isLegacySingogaFallbackRetirementAllowed(
      env({
        ENABLE_MARKET_GROUP_BASELINE_SINGOGA: "1",
        POST_WH_SINGOGA_GAPS_CLEARED: "1",
      }),
    ),
    true,
  );
  assert.equal(arePostWarehouseSingogaGapsCleared(env({})), false);
  assert.equal(POST_WH_SINGOGA_GAP_BLOCKERS.length, 5);
  assert.equal(
    POST_WH_SINGOGA_GAP_BLOCKERS.filter((g) => g.complexKey === "banpo-xi")
      .length,
    4,
  );
  assert.equal(
    POST_WH_SINGOGA_GAP_BLOCKERS.filter((g) => g.complexKey === "jamsil-els")
      .length,
    1,
  );
}

{
  const rows = loadPhase53bBaselineFixture();
  assert.equal(rows.length, 19);
  const hangang = rows.filter((r) => r.complexKey === "hangang-daewoo");
  assert.equal(hangang.length, 4);
  const g49 = hangang.find((r) => r.groupKey.includes(":G3:"));
  const g50 = hangang.find((r) => r.groupKey.includes(":G4:"));
  assert.ok(g49);
  assert.ok(g50);
  assert.equal(g49!.priorMaxAmount, 135_000);
  assert.equal(g50!.priorMaxAmount, 128_000);
  assert.notEqual(g49!.groupKey, g50!.groupKey);
  assert.equal(rows.filter((r) => r.complexKey === "parkrio").length, 5);
  assert.equal(rows.filter((r) => r.complexKey === "banpo-xi").length, 7);
  assert.equal(rows.filter((r) => r.complexKey === "jamsil-els").length, 3);
}

{
  const groups = [
    {
      groupKey: "demo:G1:ex84.90-85.00",
      exclusiveAreaMin: 84.9,
      exclusiveAreaMax: 85.0,
      groupConfidenceHigh: true,
    },
  ];
  const full = [
    {
      id: "pre",
      dealType: "trade",
      dealDate: "2010-05-01",
      dealAmount: 200_000,
      exclusiveArea: 84.95,
    },
    {
      id: "w1",
      dealType: "trade",
      dealDate: "2017-01-10",
      dealAmount: 150_000,
      exclusiveArea: 84.95,
    },
    {
      id: "w2",
      dealType: "trade",
      dealDate: "2018-06-01",
      dealAmount: 210_000,
      exclusiveArea: 84.95,
    },
  ];
  const warehouse = full.filter((t) => t.dealDate >= "2016-10-01");
  const fullFlags = markSingogaMarketGroupPriorExceed(full, groups);
  const baselineFlags = markSingogaMarketGroupPriorExceed(
    warehouse,
    groups,
    new Map([["demo:G1:ex84.90-85.00", 200_000]]),
  );
  assert.equal(fullFlags.get("w1"), false);
  assert.equal(fullFlags.get("w2"), true);
  assert.equal(baselineFlags.get("w1"), fullFlags.get("w1"));
  assert.equal(baselineFlags.get("w2"), fullFlags.get("w2"));

  const trap = [
    {
      id: "a",
      dealType: "trade",
      dealDate: "2017-01-01",
      dealAmount: 180_000,
      exclusiveArea: 84.95,
    },
    {
      id: "b",
      dealType: "trade",
      dealDate: "2018-01-01",
      dealAmount: 190_000,
      exclusiveArea: 84.95,
    },
  ];
  assert.equal(markSingogaMarketGroupPriorExceed(trap, groups).get("b"), true);
  assert.equal(
    markSingogaMarketGroupPriorExceed(
      trap,
      groups,
      new Map([["demo:G1:ex84.90-85.00", 200_000]]),
    ).get("b"),
    false,
  );
}

{
  const groups = [
    {
      groupKey: "hangang-daewoo:G3:ex134.13-134.13",
      exclusiveAreaMin: 134.13,
      exclusiveAreaMax: 134.13,
      groupConfidenceHigh: true,
    },
    {
      groupKey: "hangang-daewoo:G4:ex135.27-135.87",
      exclusiveAreaMin: 135.27,
      exclusiveAreaMax: 135.87,
      groupConfidenceHigh: true,
    },
  ];
  const baselines = baselinePriorMaxMap(
    loadPhase53bBaselineFixture(),
    "hangang-daewoo",
  );
  assert.equal(baselines.get("hangang-daewoo:G3:ex134.13-134.13"), 135_000);
  assert.equal(baselines.get("hangang-daewoo:G4:ex135.27-135.87"), 128_000);

  const trades = [
    {
      id: "49a",
      dealType: "trade",
      dealDate: "2017-01-01",
      dealAmount: 130_000,
      exclusiveArea: 134.13,
    },
    {
      id: "50a",
      dealType: "trade",
      dealDate: "2017-01-01",
      dealAmount: 130_000,
      exclusiveArea: 135.5,
    },
  ];
  const flags = markSingogaMarketGroupPriorExceed(trades, groups, baselines);
  assert.equal(flags.get("49a"), false);
  assert.equal(flags.get("50a"), true);
}

{
  const abBundle: UnitTypeMasterBundle = {
    classification: {
      complexKey: "hangang-daewoo",
      aptNameNorm: "한강(대우)",
      lawdCd: "11170",
      gu: "용산구",
      classification: "auto-safe",
      singogaMode: "market_group",
      labelConfidence: 1,
      groupConfidenceHigh: true,
      sourcePhase: "phase5",
      provenanceJson: "{}",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    unitTypes: [],
    groups: [
      {
        groupKey: "hangang-daewoo:G2:ex84.94-84.98",
        complexKey: "hangang-daewoo",
        marketLabel: 33,
        displayMode: "label+range",
        supplyAreaMin: 110,
        supplyAreaMax: 110,
        exclusiveAreaMin: 84.94,
        exclusiveAreaMax: 84.98,
        householdCount: 1,
        confidence: "high",
        groupConfidenceHigh: true,
        labelNullReason: null,
        sortOrder: 1,
        source: "phase4",
      },
    ],
    links: [],
  };
  const deals = [
    {
      id: "t1",
      dealType: "trade",
      dealDate: "2017-01-01",
      dealAmount: 90_000,
      exclusiveArea: 84.96,
    },
    {
      id: "t2",
      dealType: "trade",
      dealDate: "2018-01-01",
      dealAmount: 100_000,
      exclusiveArea: 84.96,
    },
    {
      id: "t3",
      dealType: "trade",
      dealDate: "2019-01-01",
      dealAmount: 100_000,
      exclusiveArea: 84.96,
    },
  ];
  const baselines = new Map([["hangang-daewoo:G2:ex84.94-84.98", 99_500]]);

  // ENABLE=0 → baseline path OFF (legacy prior-from-warehouse only)
  const enableOff = applyPilotSingoga({
    bundle: abBundle,
    deals,
    baselinePriorMax: baselines,
    env: env({
      ENABLE_MARKET_GROUP_BASELINE_SINGOGA: undefined,
      POST_WH_SINGOGA_GAPS_CLEARED: "1",
    }),
  });
  assert.equal(enableOff.get("t1"), false); // first obs, prior=0
  assert.equal(enableOff.get("t2"), true); // 100000 > 90000
  assert.equal(enableOff.get("t3"), false); // tie

  // ENABLE=1 POST_WH=0 → baseline ON, fallback retained
  const enableOnPostOff = applyPilotSingoga({
    bundle: abBundle,
    deals,
    baselinePriorMax: baselines,
    env: env({
      ENABLE_MARKET_GROUP_BASELINE_SINGOGA: "1",
      POST_WH_SINGOGA_GAPS_CLEARED: undefined,
    }),
  });
  assert.equal(enableOnPostOff.get("t1"), false); // 90000 <= baseline 99500
  assert.equal(enableOnPostOff.get("t2"), true); // 100000 > 99500
  assert.equal(enableOnPostOff.get("t3"), false);

  // ENABLE=1 POST_WH=1 → baseline ON (fallback still not deleted in code)
  const enableOnPostOn = applyPilotSingoga({
    bundle: abBundle,
    deals,
    baselinePriorMax: baselines,
    env: env({
      ENABLE_MARKET_GROUP_BASELINE_SINGOGA: "1",
      POST_WH_SINGOGA_GAPS_CLEARED: "1",
    }),
  });
  assert.equal(enableOnPostOn.get("t1"), false);
  assert.equal(enableOnPostOn.get("t2"), true);
  assert.equal(enableOnPostOn.get("t3"), false);

  const cdBundle: UnitTypeMasterBundle = {
    ...abBundle,
    classification: {
      ...abBundle.classification,
      complexKey: "eunma",
      aptNameNorm: "은마",
      classification: "registry-abnormal",
      singogaMode: "exclusive_area_fallback",
      groupConfidenceHigh: false,
    },
  };
  const cdDeals = [
    {
      id: "c1",
      dealType: "trade",
      dealDate: "2017-01-01",
      dealAmount: 50_000,
      exclusiveArea: 76.66,
    },
    {
      id: "c2",
      dealType: "trade",
      dealDate: "2018-01-01",
      dealAmount: 60_000,
      exclusiveArea: 76.66,
    },
    {
      id: "c3",
      dealType: "trade",
      dealDate: "2019-01-01",
      dealAmount: 60_000,
      exclusiveArea: 76.66,
    },
  ];
  const cdFlags = applyPilotSingoga({
    bundle: cdBundle,
    deals: cdDeals,
    baselinePriorMax: baselines,
    env: env({
      ENABLE_MARKET_GROUP_BASELINE_SINGOGA: "1",
      POST_WH_SINGOGA_GAPS_CLEARED: "1",
    }),
  });
  const exclusive = markSingogaExclusiveAllTimeMax(cdDeals);
  assert.equal(cdFlags.get("c1"), exclusive.get("c1"));
  assert.equal(cdFlags.get("c2"), exclusive.get("c2"));
  assert.equal(cdFlags.get("c3"), exclusive.get("c3"));
  assert.equal(cdFlags.get("c2"), true);
  assert.equal(cdFlags.get("c3"), true);
}

async function testLocalSeed(): Promise<void> {
  const db = createClient({ url: "file::memory:" });
  await ensureUnitTypeSchema(db as never);
  await assert.rejects(
    () =>
      seedBaselinesFromFixtureLocalOnly({
        db: db as never,
        dbUrl: "libsql://prod.example",
      }),
    /refused|forbidden/i,
  );
  const n = await seedBaselinesFromFixtureLocalOnly({
    db: db as never,
    dbUrl: "file::memory:",
  });
  assert.equal(n, 19);
  const res = await db.execute(
    `SELECT COUNT(*) AS n FROM apt_pyeong_group_baselines`,
  );
  assert.equal(Number((res.rows[0] as unknown as { n: number }).n), 19);
}

async function main() {
  await testLocalSeed();
  console.log("test-unit-type-phase53b: ok");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

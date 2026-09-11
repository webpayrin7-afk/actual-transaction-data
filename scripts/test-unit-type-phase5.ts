/**
 * Phase 5 unit tests.
 *   npx tsx scripts/test-unit-type-phase5.ts
 */
import assert from "node:assert/strict";
import {
  markSingogaExclusiveAllTimeMax,
  markSingogaMarketGroupPriorExceed,
} from "../src/lib/unit-type/singoga";
import {
  formatMarketGroupLabel,
  resolveGroupDisplayMode,
} from "../src/lib/unit-type/labels";
import { dryRunPilotRowCounts } from "../src/lib/unit-type/from-phase4";

{
  const trades = [
    {
      id: "a",
      dealType: "trade",
      dealDate: "2020-01-01",
      dealAmount: 100_000,
      exclusiveArea: 84.98,
    },
    {
      id: "b",
      dealType: "trade",
      dealDate: "2021-01-01",
      dealAmount: 100_000,
      exclusiveArea: 84.98,
    },
    {
      id: "c",
      dealType: "trade",
      dealDate: "2022-01-01",
      dealAmount: 110_000,
      exclusiveArea: 84.98,
    },
  ];
  const groups = [
    {
      groupKey: "g1",
      exclusiveAreaMin: 84.94,
      exclusiveAreaMax: 84.98,
      groupConfidenceHigh: true,
    },
  ];
  const marked = markSingogaMarketGroupPriorExceed(trades, groups);
  assert.equal(marked.get("a"), false);
  assert.equal(marked.get("b"), false);
  assert.equal(marked.get("c"), true);
}

{
  const trades = [
    {
      id: "t1",
      dealType: "trade",
      dealDate: "2020-01-01",
      dealAmount: 90_000,
      exclusiveArea: 84.98,
    },
    {
      id: "t2",
      dealType: "trade",
      dealDate: "2021-01-01",
      dealAmount: 100_000,
      exclusiveArea: 84.98,
    },
    {
      id: "t3",
      dealType: "trade",
      dealDate: "2022-01-01",
      dealAmount: 100_000,
      exclusiveArea: 84.98,
    },
  ];
  const legacy = markSingogaExclusiveAllTimeMax(trades);
  assert.equal(legacy.get("t2"), true);
  assert.equal(legacy.get("t3"), true);
}

{
  assert.equal(resolveGroupDisplayMode("auto-safe", 33), "label+range");
  assert.equal(
    resolveGroupDisplayMode("group-safe-label-unknown", null),
    "range_only",
  );
  assert.equal(resolveGroupDisplayMode("ambiguous", 20), "exclusive_only");
  assert.equal(
    formatMarketGroupLabel({
      marketLabel: 49,
      displayMode: "label+range",
      supplyAreaMin: 163,
      supplyAreaMax: 163,
      exclusiveAreaMin: 134.13,
      exclusiveAreaMax: 134.13,
    }),
    "49평형",
  );
}

{
  const counts = dryRunPilotRowCounts();
  assert.equal(counts.classifications, 6);
  assert.ok(counts.unitTypes > 0);
  assert.equal(counts.links, counts.unitTypes);
  assert.equal(
    counts.byComplex.find((c) => c.complexKey === "banpo-xi")?.classification,
    "auto-safe",
  );
  assert.equal(
    counts.byComplex.find((c) => c.complexKey === "jamsil-els")?.classification,
    "group-safe-label-unknown",
  );
  assert.equal(
    counts.byComplex.find((c) => c.complexKey === "eunma")?.classification,
    "registry-abnormal",
  );
}

console.log("test-unit-type-phase5: ok");

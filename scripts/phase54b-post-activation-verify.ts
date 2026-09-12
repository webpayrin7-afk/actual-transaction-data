/**
 * Phase 5.4b post-activation verify — READ-ONLY.
 * Live production apt-detail vs Turso ENABLE=1 path.
 *
 *   npx tsx scripts/phase54b-post-activation-verify.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { normalizeAptName } from "../src/lib/db/repository";
import {
  arePostWarehouseSingogaGapsCleared,
  isMarketGroupBaselineSingogaEnabled,
  legacySingogaFallbackRetirementBlockReason,
  marketGroupBaselineSingogaBlockReason,
} from "../src/lib/unit-type/baseline-gate";
import { loadBaselinePriorMaxByComplex } from "../src/lib/unit-type/baselines";
import { applyPilotSingoga } from "../src/lib/unit-type/apply-pilot";
import { loadUnitTypeMasterByAptName } from "../src/lib/unit-type/repository";
import { markSingogaMarketGroupPriorExceed } from "../src/lib/unit-type/singoga";

const PROD = "https://actual-transaction-data.vercel.app";

const PILOTS = [
  {
    complexKey: "hangang-daewoo",
    aptName: "한강(대우)",
    region: "seoul-yongsan",
    gu: "용산구",
  },
  {
    complexKey: "parkrio",
    aptName: "파크리오",
    region: "seoul-songpa",
    gu: "송파구",
  },
  {
    complexKey: "banpo-xi",
    aptName: "반포자이",
    region: "seoul-seocho",
    gu: "서초구",
  },
  {
    complexKey: "jamsil-els",
    aptName: "잠실엘스",
    region: "seoul-songpa",
    gu: "송파구",
  },
] as const;

const BANPO_FLIPS = [
  { dealDate: "2025-02-18", dealAmount: 415000 },
  { dealDate: "2025-07-10", dealAmount: 475000 },
  { dealDate: "2026-06-20", dealAmount: 615000 },
  { dealDate: "2026-07-20", dealAmount: 373000 },
] as const;

function dealKey(d: {
  dealDate: string;
  dealAmount: number;
  exclusiveArea: number;
}) {
  return `${d.dealDate}|${d.dealAmount}|${Number(d.exclusiveArea).toFixed(3)}`;
}

async function fetchProd(p: (typeof PILOTS)[number]) {
  const qs = new URLSearchParams({
    aptName: p.aptName,
    region: p.region,
    gu: p.gu,
    months: "120",
    _ts: String(Date.now()),
  });
  const t0 = Date.now();
  const res = await fetch(`${PROD}/api/apt-detail?${qs}`, {
    headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
  });
  const latencySec = (Date.now() - t0) / 1000;
  const http = res.status;
  const data = (await res.json()) as {
    items?: Array<{
      id?: string;
      dealDate: string;
      dealAmount: number;
      exclusiveArea: number;
      isSingoga?: boolean;
    }>;
    areas?: Array<{ key?: string }>;
    error?: string;
    unitTypePilot?: unknown;
  };
  return { latencySec, http, data };
}

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) throw new Error("TURSO credentials missing");
  const db = createClient({ url, authToken });

  const baselineCountsBefore: Record<string, number> = {};
  for (const p of PILOTS) {
    const r = await db.execute({
      sql: `SELECT COUNT(*) as c FROM apt_pyeong_group_baselines WHERE complex_key = ?`,
      args: [p.complexKey],
    });
    baselineCountsBefore[p.complexKey] = Number(
      (r.rows[0] as Record<string, unknown>).c,
    );
  }

  const enableEnv = {
    ENABLE_MARKET_GROUP_BASELINE_SINGOGA: "1",
  } as NodeJS.ProcessEnv;

  let beforeSnap: {
    pilots?: Record<string, { singogaCount?: number; latencySec?: number }>;
  } = {};
  try {
    beforeSnap = JSON.parse(
      readFileSync("data/poc/phase54b/production-before-enable.json", "utf8"),
    );
  } catch {
    /* optional */
  }

  // Normalize before snap shape (pilots vs pilots)
  const beforePilots =
    (beforeSnap as { pilots?: Record<string, { singogaCount?: number; latencySec?: number }> })
      .pilots ?? {};

  const gate = {
    enable1Sim: {
      isEnabled: isMarketGroupBaselineSingogaEnabled(enableEnv),
      postWh: arePostWarehouseSingogaGapsCleared(enableEnv),
      blockReason: marketGroupBaselineSingogaBlockReason(enableEnv),
      fallbackRetirementBlock:
        legacySingogaFallbackRetirementBlockReason(enableEnv),
    },
    note: "Production ENABLE inferred from live singoga counts; POST_WH not touched",
  };

  const pilots: Record<string, unknown>[] = [];
  let unexplainedTotal = 0;
  let baselineMissingTotal = 0;
  let apiErrors = 0;
  let prodVsOnDiffTotal = 0;

  for (const p of PILOTS) {
    const { latencySec, http, data } = await fetchProd(p);
    if (http !== 200 || data.error) apiErrors += 1;

    const prodItems = (data.items ?? []).map((x) => ({
      id: x.id,
      dealDate: String(x.dealDate),
      dealAmount: Number(x.dealAmount),
      exclusiveArea: Number(x.exclusiveArea),
      isSingoga: Boolean(x.isSingoga),
    }));

    const priorMap = await loadBaselinePriorMaxByComplex(db, p.complexKey);
    const bundle = await loadUnitTypeMasterByAptName(
      p.aptName.replace(/\s+/g, ""),
      db,
    );
    if (!bundle) {
      pilots.push({ ...p, error: "master missing" });
      continue;
    }

    const groupKeys = bundle.groups
      .filter((g) => g.groupConfidenceHigh)
      .map((g) => g.groupKey);
    const missing = groupKeys.filter((k) => !priorMap.has(k));
    baselineMissingTotal += missing.length;

    const aptNorm = normalizeAptName(p.aptName);
    const trades = await db.execute({
      sql: `SELECT id, deal_date as dealDate, deal_amount as dealAmount,
                   exclusive_area as exclusiveArea
            FROM transactions
            WHERE apt_name_norm = ? AND deal_type = 'trade'
            ORDER BY deal_date ASC, deal_amount ASC
            LIMIT 50000`,
      args: [aptNorm],
    });
    const deals = trades.rows.map((r) => {
      const row = r as Record<string, unknown>;
      return {
        id: String(row.id),
        dealType: "trade" as const,
        dealDate: String(row.dealDate),
        dealAmount: Number(row.dealAmount),
        exclusiveArea: Number(row.exclusiveArea),
      };
    });

    const onFlags = applyPilotSingoga({
      bundle,
      deals,
      baselinePriorMax: priorMap,
      env: enableEnv,
    });

    const groups = bundle.groups
      .filter((g) => g.groupConfidenceHigh)
      .map((g) => ({
        groupKey: g.groupKey,
        exclusiveAreaMin: g.exclusiveAreaMin,
        exclusiveAreaMax: g.exclusiveAreaMax,
        groupConfidenceHigh: true as const,
      }));
    const fullFlags = markSingogaMarketGroupPriorExceed(
      deals,
      groups,
      undefined,
    );

    const byKey = new Map<string, typeof deals>();
    for (const d of deals) {
      const k = dealKey(d);
      const arr = byKey.get(k) ?? [];
      arr.push(d);
      byKey.set(k, arr);
    }

    let prodVsOn = 0;
    let unexplained = 0;
    let unmatchedProd = 0;
    const sampleDiffs: Record<string, unknown>[] = [];
    const consumed = new Set<string>();

    for (const pi of prodItems) {
      const k = dealKey(pi);
      const cands = (byKey.get(k) ?? []).filter((d) => !consumed.has(d.id));
      if (cands.length === 0) {
        unmatchedProd += 1;
        continue;
      }
      const d = cands[0]!;
      consumed.add(d.id);
      const on = onFlags.get(d.id) ?? false;
      const full = fullFlags.get(d.id) ?? false;
      if (pi.isSingoga !== on) {
        prodVsOn += 1;
        if (sampleDiffs.length < 12) {
          sampleDiffs.push({
            kind: "prod_vs_enable1",
            dealDate: pi.dealDate,
            dealAmount: pi.dealAmount,
            exclusiveArea: pi.exclusiveArea,
            prod: pi.isSingoga,
            enable1: on,
            fullHistory: full,
          });
        }
      }
      if (on !== full) {
        unexplained += 1;
        if (sampleDiffs.length < 12) {
          sampleDiffs.push({
            kind: "enable1_vs_full",
            dealDate: pi.dealDate,
            dealAmount: pi.dealAmount,
            exclusiveArea: pi.exclusiveArea,
            prod: pi.isSingoga,
            enable1: on,
            fullHistory: full,
          });
        }
      }
    }

    const banpoFlipCheck =
      p.complexKey === "banpo-xi"
        ? BANPO_FLIPS.map((f) => {
            const prod = prodItems.find(
              (x) =>
                x.dealDate === f.dealDate && x.dealAmount === f.dealAmount,
            );
            const d = deals.find(
              (x) =>
                x.dealDate === f.dealDate && x.dealAmount === f.dealAmount,
            );
            return {
              ...f,
              prodFound: Boolean(prod),
              prodIsSingoga: prod?.isSingoga ?? null,
              enable1: d ? (onFlags.get(d.id) ?? false) : null,
              fullHistory: d ? (fullFlags.get(d.id) ?? false) : null,
            };
          })
        : null;

    const beforePilot = beforePilots[p.complexKey];
    const areaKeys = (data.areas ?? []).map((a) => a.key);

    const special: Record<string, unknown> = {};
    if (p.complexKey === "hangang-daewoo") {
      special.areaKeysHas134 = areaKeys.some((k) => (k ?? "").includes("134.13"));
      special.areaKeysHas135 = areaKeys.some((k) => (k ?? "").includes("135.27"));
    }
    if (p.complexKey === "parkrio") {
      special.areaKeysHas84 = areaKeys.some((k) => (k ?? "").includes("84.79"));
    }
    if (p.complexKey === "jamsil-els") {
      special.areaKeysHas84 = areaKeys.some((k) => (k ?? "").includes("84.80"));
    }

    pilots.push({
      complexKey: p.complexKey,
      aptName: p.aptName,
      http,
      latencySec,
      latencyBefore: beforePilot?.latencySec ?? null,
      itemCount: prodItems.length,
      singogaProd: prodItems.filter((x) => x.isSingoga).length,
      singogaEnable1: [...onFlags.values()].filter(Boolean).length,
      singogaFullHistory: [...fullFlags.values()].filter(Boolean).length,
      singogaBefore: beforePilot?.singogaCount ?? null,
      areaKeys,
      special,
      baselineMissingGroups: missing,
      priorMapSize: priorMap.size,
      prodVsEnable1Diff: prodVsOn,
      unexplainedInProdWindow: unexplained,
      unmatchedProd,
      sampleDiffs,
      banpoFlipCheck,
      apiError: data.error ?? null,
      unitTypePilot: data.unitTypePilot ?? null,
    });

    prodVsOnDiffTotal += prodVsOn;
    unexplainedTotal += unexplained;
  }

  const baselineCountsAfter: Record<string, number> = {};
  let writesDetected = 0;
  for (const p of PILOTS) {
    const r = await db.execute({
      sql: `SELECT COUNT(*) as c FROM apt_pyeong_group_baselines WHERE complex_key = ?`,
      args: [p.complexKey],
    });
    baselineCountsAfter[p.complexKey] = Number(
      (r.rows[0] as Record<string, unknown>).c,
    );
    if (
      baselineCountsAfter[p.complexKey] !== baselineCountsBefore[p.complexKey]
    ) {
      writesDetected += 1;
    }
  }

  const allCountsMatchEnable1 = pilots.every(
    (p) => p.singogaProd === p.singogaEnable1,
  );
  const pathActive = pilots.every(
    (p) =>
      typeof p.singogaBefore === "number" &&
      p.singogaProd !== p.singogaBefore &&
      p.singogaProd === p.singogaEnable1,
  );

  const decision =
    apiErrors === 0 &&
    baselineMissingTotal === 0 &&
    prodVsOnDiffTotal === 0 &&
    unexplainedTotal === 0 &&
    writesDetected === 0 &&
    allCountsMatchEnable1 &&
    pathActive
      ? "PASS"
      : "ROLLBACK";

  const out = {
    capturedAt: new Date().toISOString(),
    phase: "5.4b-post-activation",
    decision,
    productionSha: "d51716197d6233be5c1a971519ba4225264802eb",
    gate,
    productionPath: {
      baselineCodePresent: true,
      baselinePathActive: pathActive,
      fallbackRetained: Boolean(gate.enable1Sim.fallbackRetirementBlock),
      postWhUntouched: true,
    },
    runtime: {
      unexplainedDiff: unexplainedTotal,
      prodVsEnable1Diff: prodVsOnDiffTotal,
      baselineMissing: baselineMissingTotal,
      apiErrors,
      writesDetected,
      baselineCountsBefore,
      baselineCountsAfter,
    },
    pilots,
  };

  const dir = join("data/poc/phase54b");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "post-activation-verify.json"),
    JSON.stringify(out, null, 2),
  );
  console.log(
    JSON.stringify(
      {
        decision: out.decision,
        runtime: out.runtime,
        productionPath: out.productionPath,
        gate: out.gate,
        pilots: pilots.map((p) => ({
          complexKey: p.complexKey,
          singogaProd: p.singogaProd,
          singogaEnable1: p.singogaEnable1,
          singogaBefore: p.singogaBefore,
          unexplainedInProdWindow: p.unexplainedInProdWindow,
          prodVsEnable1Diff: p.prodVsEnable1Diff,
          unmatchedProd: p.unmatchedProd,
          baselineMissing: p.baselineMissingGroups,
          latencySec: p.latencySec,
          latencyBefore: p.latencyBefore,
          special: p.special,
          banpoFlipCheck: p.banpoFlipCheck,
          sampleDiffs: (p.sampleDiffs as unknown[])?.slice?.(0, 5),
        })),
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

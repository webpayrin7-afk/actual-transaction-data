/**
 * Phase 5.4b preflight — read-only Turso + gate check.
 * Does NOT mutate production flags or write DB.
 *
 *   npx tsx scripts/phase54b-preflight-turso.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
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

const PILOTS = [
  {
    complexKey: "hangang-daewoo",
    aptName: "한강(대우)",
    special: "G3 ex134.13 vs G4 ex135.27-135.87",
  },
  {
    complexKey: "parkrio",
    aptName: "파크리오",
    special: "G3 ex84.79-84.97",
  },
  {
    complexKey: "banpo-xi",
    aptName: "반포자이",
    special: "prior repair / Banpo flips",
  },
  {
    complexKey: "jamsil-els",
    aptName: "잠실엘스",
    special: "G2 ex84.80-84.97",
  },
] as const;

const BANPO_FLIPS = [
  { dealDate: "2025-02-18", dealAmount: 415000 },
  { dealDate: "2025-07-10", dealAmount: 475000 },
  { dealDate: "2026-06-20", dealAmount: 615000 },
  { dealDate: "2026-07-20", dealAmount: 373000 },
] as const;

async function loadBaselineRows(db: Client, complexKey: string) {
  const res = await db.execute({
    sql: `SELECT group_key, prior_max_amount, prior_max_deal_date, baseline_until, completeness, confidence
          FROM apt_pyeong_group_baselines WHERE complex_key = ?`,
    args: [complexKey],
  });
  return res.rows.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      groupKey: String(r.group_key),
      priorMaxAmount: Number(r.prior_max_amount ?? 0),
      priorMaxDealDate:
        r.prior_max_deal_date == null ? null : String(r.prior_max_deal_date),
      baselineUntil: String(r.baseline_until ?? ""),
      completeness: String(r.completeness ?? ""),
      confidence: String(r.confidence ?? ""),
    };
  });
}

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) throw new Error("TURSO credentials missing");

  const db = createClient({ url, authToken });

  const gateUnset = {
    ENABLE: process.env.ENABLE_MARKET_GROUP_BASELINE_SINGOGA ?? "(unset)",
    POST_WH: process.env.POST_WH_SINGOGA_GAPS_CLEARED ?? "(unset)",
    isEnabled: isMarketGroupBaselineSingogaEnabled(),
    postWh: arePostWarehouseSingogaGapsCleared(),
    blockReason: marketGroupBaselineSingogaBlockReason(),
    fallbackRetirementBlock: legacySingogaFallbackRetirementBlockReason(),
  };

  const enableEnv = {
    ENABLE_MARKET_GROUP_BASELINE_SINGOGA: "1",
  } as NodeJS.ProcessEnv;
  const gateEnableOnly = {
    isEnabled: isMarketGroupBaselineSingogaEnabled(enableEnv),
    postWh: arePostWarehouseSingogaGapsCleared(enableEnv),
    blockReason: marketGroupBaselineSingogaBlockReason(enableEnv),
    fallbackRetirementBlock:
      legacySingogaFallbackRetirementBlockReason(enableEnv),
  };

  const pilots: Record<string, unknown>[] = [];
  for (const p of PILOTS) {
    const baselines = await loadBaselineRows(db, p.complexKey);
    const priorMap = await loadBaselinePriorMaxByComplex(db, p.complexKey);
    const bundle = await loadUnitTypeMasterByAptName(
      p.aptName.replace(/\s+/g, ""),
      db,
    );
    if (!bundle) {
      pilots.push({ ...p, error: "master missing" });
      continue;
    }

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

    const off = applyPilotSingoga({
      bundle,
      deals,
      baselinePriorMax: undefined,
      env: { ENABLE_MARKET_GROUP_BASELINE_SINGOGA: "0" } as NodeJS.ProcessEnv,
    });
    const on = applyPilotSingoga({
      bundle,
      deals,
      baselinePriorMax: priorMap,
      env: enableEnv,
    });

    let flipDiff = 0;
    let onOnly = 0;
    let offOnly = 0;
    for (const d of deals) {
      const a = off.get(d.id) ?? false;
      const b = on.get(d.id) ?? false;
      if (a !== b) flipDiff++;
      if (b && !a) onOnly++;
      if (a && !b) offOnly++;
    }

    const groupKeys = bundle.groups
      .filter((g) => g.groupConfidenceHigh)
      .map((g) => g.groupKey);
    const missingBaselines = groupKeys.filter((k) => !priorMap.has(k));

    const banpoFlipCheck =
      p.complexKey === "banpo-xi"
        ? BANPO_FLIPS.map((f) => {
            const row = deals.find(
              (d) =>
                d.dealDate === f.dealDate && d.dealAmount === f.dealAmount,
            );
            if (!row) return { ...f, found: false };
            return {
              ...f,
              found: true,
              exclusiveArea: row.exclusiveArea,
              off: off.get(row.id) ?? false,
              on: on.get(row.id) ?? false,
            };
          })
        : null;

    const specialGroups = groupKeys.filter((k) => {
      if (p.complexKey === "hangang-daewoo")
        return k.includes("134.13") || k.includes("135.27");
      if (p.complexKey === "parkrio") return k.includes("84.79");
      if (p.complexKey === "jamsil-els") return k.includes("84.80");
      if (p.complexKey === "banpo-xi")
        return k.includes("84.94") || k.includes("59.97");
      return false;
    });

    pilots.push({
      ...p,
      tradeCount: deals.length,
      groupCount: groupKeys.length,
      baselineRowCount: baselines.length,
      priorMapSize: priorMap.size,
      baselineMissingGroups: missingBaselines,
      singogaOff: [...off.values()].filter(Boolean).length,
      singogaOn: [...on.values()].filter(Boolean).length,
      flipDiff,
      onOnly,
      offOnly,
      specialGroups,
      banpoFlipCheck,
      sampleBaselines: baselines.slice(0, 8),
    });
  }

  const out = {
    capturedAt: new Date().toISOString(),
    mode: "turso-readonly-preflight",
    writes: 0,
    gateUnset,
    gateEnableOnlyExpected: {
      ...gateEnableOnly,
      note: "ENABLE=1 alone turns baseline path ON; POST_WH stays false; fallback retirement still blocked",
    },
    expectations: {
      baselineReadPathOnWhenEnable1: true,
      legacyFallbackRetained: true,
      dbWrite: 0,
      postWhMustRemainUnset: true,
    },
    pilots,
    summary: {
      baselineMissingTotal: pilots.reduce(
        (s, p) =>
          s +
          ((p.baselineMissingGroups as string[] | undefined)?.length ?? 0),
        0,
      ),
      anyMasterError: pilots.some((p) => Boolean(p.error)),
      totalFlipDiffOffVsOn: pilots.reduce(
        (s, p) => s + Number(p.flipDiff ?? 0),
        0,
      ),
    },
  };

  const dir = join("data/poc/phase54b");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "preflight-turso.json"), JSON.stringify(out, null, 2));
  console.log(
    JSON.stringify(
      {
        summary: out.summary,
        gateUnset,
        gateEnableOnly,
        pilots: pilots.map((p) => ({
          complexKey: p.complexKey,
          baselineMissing: p.baselineMissingGroups,
          flipDiff: p.flipDiff,
          singogaOff: p.singogaOff,
          singogaOn: p.singogaOn,
          specialGroups: p.specialGroups,
          banpoFlipCheck: p.banpoFlipCheck,
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

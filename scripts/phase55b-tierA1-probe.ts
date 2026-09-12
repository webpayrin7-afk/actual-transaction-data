/**
 * Phase 5.5b Tier A-1 — production apt-detail probe (read-only).
 *   npx tsx scripts/phase55b-tierA1-probe.ts
 */
import { createClient } from "@libsql/client";
import { mkdirSync, writeFileSync } from "node:fs";
import { loadBaselinePriorMaxByComplex } from "../src/lib/unit-type/baselines";
import { loadUnitTypeMasterByAptName } from "../src/lib/unit-type/repository";

const PROD = "https://actual-transaction-data.vercel.app";

const COMPLEXES = [
  {
    complexKey: "daechi-palace",
    aptName: "래미안대치팰리스",
    region: "seoul-gangnam",
    gu: "강남구",
  },
  {
    complexKey: "mapo-raemian-prugio",
    aptName: "마포래미안푸르지오4단지",
    region: "seoul-mapo",
    gu: "마포구",
  },
  {
    complexKey: "acro-riverpark",
    aptName: "아크로리버파크",
    region: "seoul-seocho",
    gu: "서초구",
  },
] as const;

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) throw new Error("missing turso");
  const db = createClient({ url, authToken });

  const results: Record<string, unknown> = {};
  let errors = 0;
  let baselineMissing = 0;
  const latencies: number[] = [];

  for (const c of COMPLEXES) {
    const master = await loadUnitTypeMasterByAptName(c.aptName.replace(/\s+/g, ""), db);
    const baselines = master
      ? await loadBaselinePriorMaxByComplex(db, master.classification.complexKey)
      : new Map();
    const highGroups = (master?.groups ?? []).filter((g) => g.groupConfidenceHigh);
    const missingHigh = highGroups.filter((g) => !baselines.has(g.groupKey)).length;
    baselineMissing += missingHigh;

    const qs = new URLSearchParams({
      aptName: c.aptName,
      region: c.region,
      gu: c.gu,
      months: "120",
      _ts: String(Date.now()),
    });
    const t0 = Date.now();
    const res = await fetch(`${PROD}/api/apt-detail?${qs}`, {
      headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
    });
    const latencySec = (Date.now() - t0) / 1000;
    latencies.push(latencySec);
    const data = (await res.json()) as {
      items?: Array<{ isSingoga?: boolean }>;
      areas?: Array<{ key?: string }>;
      error?: string;
      unitTypePilot?: {
        complexKey?: string;
        classification?: string;
        singogaMode?: string;
        selectorMode?: string;
      };
    };
    if (res.status !== 200 || data.error) errors += 1;
    const singogaCount = (data.items ?? []).filter((i) => i.isSingoga).length;
    const areaKeys = (data.areas ?? []).map((a) => a.key).filter(Boolean);
    const pilot = data.unitTypePilot;
    const masterLoads =
      !!master &&
      master.classification.singogaMode === "market_group" &&
      (master.groups?.length ?? 0) > 0;
    const baselinePathActive =
      pilot?.selectorMode === "market_group" &&
      pilot?.singogaMode === "market_group";

    results[c.complexKey] = {
      http: res.status,
      latencySec: Number(latencySec.toFixed(3)),
      itemCount: data.items?.length ?? 0,
      singogaCount,
      areaKeyCount: areaKeys.length,
      unitTypePilot: pilot ?? null,
      masterLoads,
      baselinePathActive,
      baselineMissingHigh: missingHigh,
      highGroupCount: highGroups.length,
      baselineRowCount: baselines.size,
      error: data.error ?? null,
    };
  }

  const report = {
    phase: "5.5b-tierA1-probe",
    capturedAt: new Date().toISOString(),
    prod: PROD,
    results,
    baselineMissing,
    errors,
    latencyMaxSec: Math.max(...latencies),
    latencyOk: Math.max(...latencies) < 30,
    pass:
      errors === 0 &&
      baselineMissing === 0 &&
      COMPLEXES.every((c) => {
        const r = results[c.complexKey] as {
          http: number;
          masterLoads: boolean;
          baselinePathActive: boolean;
        };
        return r.http === 200 && r.masterLoads && r.baselinePathActive;
      }),
  };
  mkdirSync("data/poc/phase55b", { recursive: true });
  writeFileSync(
    "data/poc/phase55b/tierA1-probe.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
  if (!report.pass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * Phase 5.1 external cross-check pack (read-only).
 * Compares market-group prior-exceed vs exclusive-area prior-exceed
 * (아파트미 "타입 신고가" 관행 근사) and spot-checks public news cases.
 */
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { PHASE5_PILOT_COMPLEXES } from "../src/lib/unit-type/pilot";
import {
  markSingogaMarketGroupPriorExceed,
  matchMarketGroup,
  type MarketGroupLike,
  type SingogaTradeLike,
} from "../src/lib/unit-type/singoga";
import { typeRecordHigh } from "../src/lib/region/market-insight";
import { formatMarketGroupLabel } from "../src/lib/unit-type/labels";

const TARGETS = [
  "hangang-daewoo",
  "parkrio",
  "banpo-xi",
  "jamsil-els",
] as const;

/** Public spot-checks from news / third-party listings (not authoritative). */
const PUBLIC_SPOT_CHECKS = [
  {
    aptNameNorm: "한강(대우)",
    dealDate: "2025-07-12",
    exclusiveArea: 84.98,
    amount: 288000,
    source: "디아파트/내집나침반 실거래 목록 — 84.98㎡ 28.8억 신고가 서술",
    expectedExternalSingoga: true,
  },
  {
    aptNameNorm: "한강(대우)",
    dealDate: "2025-07-08",
    exclusiveArea: 84.98,
    amount: 271000,
    source: "warehouse same-day pair; public lists emphasize 7/12 peak",
    expectedExternalSingoga: true, // type prior exceed vs earlier 25억
  },
  {
    aptNameNorm: "반포자이",
    dealDate: "2025-07-10",
    exclusiveArea: 84.943,
    amount: 500000,
    source: "audit same-day multi; silgga/news track 84㎡ peaks around 50억대",
    expectedExternalSingoga: true,
  },
  {
    aptNameNorm: "반포자이",
    dealDate: "2025-07-10",
    exclusiveArea: 84.943,
    amount: 475000,
    source: "same-day second exceed; external may still mark as 신고가 or only day-high",
    expectedExternalSingoga: true,
  },
] as const;

function markExclusivePriorExceed(trades: SingogaTradeLike[]): Map<string, boolean> {
  const out = new Map<string, boolean>();
  const sorted = [...trades].sort((a, b) => {
    if (a.dealDate !== b.dealDate) return a.dealDate < b.dealDate ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
  const areaKey = (sqm: number) => String(Math.round(sqm * 100) / 100);
  const priorMax = new Map<string, number>();
  let i = 0;
  while (i < sorted.length) {
    const day = sorted[i]!.dealDate;
    const batch: SingogaTradeLike[] = [];
    while (i < sorted.length && sorted[i]!.dealDate === day) {
      batch.push(sorted[i]!);
      i += 1;
    }
    const dayPeak = new Map<string, number>();
    for (const tx of batch) {
      const key = areaKey(tx.exclusiveArea);
      const prior = priorMax.get(key) ?? 0;
      out.set(tx.id, typeRecordHigh(tx.dealAmount, prior).isSingoga);
      dayPeak.set(key, Math.max(dayPeak.get(key) ?? 0, tx.dealAmount));
    }
    for (const [k, peak] of dayPeak) {
      priorMax.set(k, Math.max(priorMax.get(k) ?? 0, peak));
    }
  }
  return out;
}

async function main() {
  const url = process.env.TURSO_DATABASE_URL?.trim();
  const token = process.env.TURSO_AUTH_TOKEN?.trim();
  if (!url || !token) throw new Error("missing Turso env");
  const db = createClient({ url, authToken: token });

  const byComplex: unknown[] = [];
  const spotResults: unknown[] = [];

  for (const complexKey of TARGETS) {
    const pilot = PHASE5_PILOT_COMPLEXES.find((p) => p.complexKey === complexKey)!;
    const groupsRes = await db.execute({
      sql: `SELECT * FROM apt_pyeong_groups WHERE complex_key = ? ORDER BY sort_order`,
      args: [complexKey],
    });
    const groupRows = groupsRes.rows as unknown as Array<Record<string, unknown>>;
    const txRes = await db.execute({
      sql: `SELECT id, deal_date, deal_amount, exclusive_area
            FROM transactions
            WHERE apt_name_norm = ? AND deal_type = 'trade'
            ORDER BY deal_date ASC, id ASC`,
      args: [pilot.aptNameNorm],
    });
    const trades: SingogaTradeLike[] = (
      txRes.rows as unknown as Array<Record<string, unknown>>
    ).map((t) => ({
      id: String(t.id),
      dealType: "trade",
      dealDate: String(t.deal_date),
      dealAmount: Number(t.deal_amount),
      exclusiveArea: Number(t.exclusive_area),
    }));

    const marketGroups: MarketGroupLike[] = groupRows
      .filter((g) => Number(g.group_confidence_high) === 1)
      .map((g) => ({
        groupKey: String(g.group_key),
        exclusiveAreaMin: Number(g.exclusive_area_min),
        exclusiveAreaMax: Number(g.exclusive_area_max),
        groupConfidenceHigh: true,
      }));

    const ours = markSingogaMarketGroupPriorExceed(trades, marketGroups);
    const typeProxy = markExclusivePriorExceed(trades);

    // Build labeled sample >=10: recent RH + FT candidates + some FF
    const recent = trades.filter((t) => t.dealDate >= "2020-01-01");
    const rh = recent.filter((t) => ours.get(t.id));
    const ft = recent.filter((t) => !ours.get(t.id) && typeProxy.get(t.id));
    const tf = recent.filter((t) => ours.get(t.id) && !typeProxy.get(t.id));
    const ff = recent.filter((t) => !ours.get(t.id) && !typeProxy.get(t.id));

    const pick = <T,>(arr: T[], n: number) => arr.slice(Math.max(0, arr.length - n));
    const chosen = [
      ...pick(rh.filter((t) => typeProxy.get(t.id)), 6),
      ...pick(tf, 3),
      ...pick(ft, 4),
      ...pick(ff, 2),
    ];
    const seen = new Set<string>();
    const samples: unknown[] = [];
    for (const t of chosen) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      const o = !!ours.get(t.id);
      const e = !!typeProxy.get(t.id);
      const cell = o && e ? "TT" : o && !e ? "TF" : !o && e ? "FT" : "FF";
      const g = matchMarketGroup(t.exclusiveArea, marketGroups);
      let cause: string | null = null;
      if (cell === "TF") cause = "grouping_diff_market_group_true_exact_false";
      if (cell === "FT") cause = "grouping_diff_exact_true_market_group_false";
      if (cell === "TT") cause = "agree_prior_exceed";
      samples.push({
        dealDate: t.dealDate,
        amount: t.dealAmount,
        exclusiveArea: t.exclusiveArea,
        groupKey: g?.groupKey ?? null,
        ourMarketGroup: o,
        externalTypeProxy: e,
        cell,
        cause,
      });
    }

    let TT = 0,
      TF = 0,
      FT = 0,
      FF = 0;
    for (const t of recent) {
      const o = !!ours.get(t.id);
      const e = !!typeProxy.get(t.id);
      if (o && e) TT += 1;
      else if (o && !e) TF += 1;
      else if (!o && e) FT += 1;
      else FF += 1;
    }

    byComplex.push({
      aptNameNorm: pilot.aptNameNorm,
      complexKey,
      window: "deal_date >= 2020-01-01",
      confusionVsExclusiveTypeProxy: { TT, TF, FT, FF },
      matchRateAll: (TT + FF) / Math.max(1, TT + TF + FT + FF),
      matchRateAmongEitherTrue: TT / Math.max(1, TT + TF + FT),
      sampleCount: samples.length,
      samples,
      note: "externalTypeProxy = exclusive-area prior-exceed approximating 아파트미 타입 신고가. Live UI scrape unavailable (apt2.me Tomcat errors). MOLIT warehouse remains authoritative.",
    });

    for (const spot of PUBLIC_SPOT_CHECKS.filter((s) => s.aptNameNorm === pilot.aptNameNorm)) {
      const hit = trades.find(
        (t) =>
          t.dealDate === spot.dealDate &&
          Math.abs(t.exclusiveArea - spot.exclusiveArea) < 0.01 &&
          t.dealAmount === spot.amount,
      );
      if (!hit) {
        spotResults.push({ ...spot, foundInWarehouse: false });
        continue;
      }
      const o = !!ours.get(hit.id);
      const e = !!typeProxy.get(hit.id);
      spotResults.push({
        ...spot,
        foundInWarehouse: true,
        ourMarketGroup: o,
        exclusiveTypeProxy: e,
        cell:
          o && spot.expectedExternalSingoga
            ? "TT"
            : o && !spot.expectedExternalSingoga
              ? "TF"
              : !o && spot.expectedExternalSingoga
                ? "FT"
                : "FF",
      });
    }
  }

  // Enrich with group labels from audit json if present
  let auditSummary = null;
  try {
    auditSummary = JSON.parse(
      readFileSync(join(process.cwd(), "data/poc/phase51/singoga-audit.json"), "utf8"),
    ).decision;
  } catch {
    /* ignore */
  }

  const out = {
    generatedAt: new Date().toISOString(),
    methodology: {
      externalProxy:
        "exclusive-area prior-exceed (typeRecordHigh) ≈ 아파트미 타입 신고가 / 호갱노노 평형 신고가",
      authoritative: "MOLIT warehouse transactions",
      liveUiScrape: false,
      firstTradePractice:
        "Public UIs describe 신고가 as beating prior max → first trade excluded. Recommend exclude.",
    },
    publicSpotChecks: spotResults,
    complexes: byComplex,
    priorAuditDecision: auditSummary,
  };

  const dir = join(process.cwd(), "data/poc/phase51");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "external-crosscheck.json");
  writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        wrote: path,
        spotChecks: spotResults,
        summary: (byComplex as Array<Record<string, unknown>>).map((c) => ({
          apt: c.aptNameNorm,
          confusion: c.confusionVsExclusiveTypeProxy,
          matchAmongEitherTrue: c.matchRateAmongEitherTrue,
          samples: c.sampleCount,
        })),
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

/**
 * Phase 5.1 — market-group 신고가 정합성 감사 (read-only).
 *
 * Usage: npx tsx scripts/phase51-singoga-audit.ts
 *
 * Safety: no writes to Turso / no pilot master mutation.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { config as loadEnv } from "dotenv";
import { PHASE5_PILOT_COMPLEXES } from "../src/lib/unit-type/pilot";
import {
  markSingogaExclusiveAllTimeMax,
  markSingogaMarketGroupPriorExceed,
  matchMarketGroup,
  type MarketGroupLike,
  type SingogaTradeLike,
} from "../src/lib/unit-type/singoga";
import { formatMarketGroupLabel } from "../src/lib/unit-type/labels";
import { typeRecordHigh } from "../src/lib/region/market-insight";

loadEnv({ path: ".env.local" });
loadEnv();

type TxRow = {
  id: string;
  deal_date: string;
  deal_amount: number;
  exclusive_area: number;
};

type GroupRow = {
  group_key: string;
  market_label: number | null;
  display_mode: string;
  supply_area_min: number | null;
  supply_area_max: number | null;
  exclusive_area_min: number;
  exclusive_area_max: number;
  group_confidence_high: number;
  sort_order: number;
};

type TradeAudit = {
  id: string;
  dealDate: string;
  amount: number;
  exclusiveArea: number;
  priorMax: number;
  isRecordHighFirstExclude: boolean;
  isRecordHighFirstInclude: boolean;
  isFirstTradeInGroup: boolean;
  previousRecordHighAmount: number | null;
  previousRecordHighDate: string | null;
};

type SameDayCase = {
  groupKey: string;
  groupLabel: string;
  dealDate: string;
  priorMax: number;
  exceedCount: number;
  trades: Array<{ id: string; amount: number; exclusiveArea: number }>;
};

const AUDIT_TARGETS = [
  {
    complexKey: "hangang-daewoo",
    displayName: "한강(대우)",
    occupancyYear: 2000,
    phase5MarketGroupFirstExclude: 81,
  },
  {
    complexKey: "parkrio",
    displayName: "파크리오",
    occupancyYear: 2008,
    phase5MarketGroupFirstExclude: 227,
  },
  {
    complexKey: "banpo-xi",
    displayName: "반포자이",
    occupancyYear: 2009,
    phase5MarketGroupFirstExclude: 191,
  },
  {
    complexKey: "jamsil-els",
    displayName: "잠실엘스",
    occupancyYear: 2008,
    phase5MarketGroupFirstExclude: 162,
  },
] as const;

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function requireTurso() {
  const url = process.env.TURSO_DATABASE_URL?.trim();
  const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
  if (!url || !authToken) throw new Error("Missing TURSO_DATABASE_URL / TURSO_AUTH_TOKEN");
  return createClient({ url, authToken });
}

/** Exclusive-area prior-exceed (same rule as market-group, but keyed by exact area). */
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

function auditOneGroup(
  trades: SingogaTradeLike[],
  groupKey: string,
): {
  trades: TradeAudit[];
  firstInclude: number;
  firstExclude: number;
  sameDayCases: SameDayCase[];
} {
  const sorted = [...trades].sort((a, b) => {
    if (a.dealDate !== b.dealDate) return a.dealDate < b.dealDate ? -1 : 1;
    return a.id.localeCompare(b.id);
  });

  const audited: TradeAudit[] = [];
  const sameDayCases: SameDayCase[] = [];
  let firstInclude = 0;
  let firstExclude = 0;
  let previousRhAmount: number | null = null;
  let previousRhDate: string | null = null;
  let runningMax = 0;

  let i = 0;
  while (i < sorted.length) {
    const day = sorted[i]!.dealDate;
    const batch: SingogaTradeLike[] = [];
    while (i < sorted.length && sorted[i]!.dealDate === day) {
      batch.push(sorted[i]!);
      i += 1;
    }

    const prior = runningMax;
    const isFirstDay = prior === 0;
    const exceeders = batch.filter((tx) => typeRecordHigh(tx.dealAmount, prior).isSingoga);

    if (exceeders.length >= 2) {
      sameDayCases.push({
        groupKey,
        groupLabel: groupKey,
        dealDate: day,
        priorMax: prior,
        exceedCount: exceeders.length,
        trades: exceeders.map((tx) => ({
          id: tx.id,
          amount: tx.dealAmount,
          exclusiveArea: tx.exclusiveArea,
        })),
      });
    }

    for (const tx of batch) {
      const exceed = typeRecordHigh(tx.dealAmount, prior).isSingoga;
      const includeFlag = isFirstDay || exceed;
      const excludeFlag = exceed; // prior===0 => false
      if (includeFlag) firstInclude += 1;
      if (excludeFlag) firstExclude += 1;
      audited.push({
        id: tx.id,
        dealDate: tx.dealDate,
        amount: tx.dealAmount,
        exclusiveArea: tx.exclusiveArea,
        priorMax: prior,
        isRecordHighFirstExclude: excludeFlag,
        isRecordHighFirstInclude: includeFlag,
        isFirstTradeInGroup: isFirstDay,
        previousRecordHighAmount: previousRhAmount,
        previousRecordHighDate: previousRhDate,
      });
    }

    const dayPeak = Math.max(...batch.map((tx) => tx.dealAmount));
    if (isFirstDay) {
      // Under first-exclude these are not RH, but track baseline for "previous RH" display.
      previousRhAmount = dayPeak;
      previousRhDate = day;
    } else if (exceeders.length > 0) {
      previousRhAmount = Math.max(...exceeders.map((tx) => tx.dealAmount));
      previousRhDate = day;
    }
    runningMax = Math.max(runningMax, dayPeak);
  }

  return { trades: audited, firstInclude, firstExclude, sameDayCases };
}

async function main() {
  const db = requireTurso();
  const results: unknown[] = [];
  const externalSamples: unknown[] = [];

  for (const target of AUDIT_TARGETS) {
    const pilot = PHASE5_PILOT_COMPLEXES.find((p) => p.complexKey === target.complexKey);
    if (!pilot) throw new Error(`Unknown pilot ${target.complexKey}`);

    const classRes = await db.execute({
      sql: `SELECT * FROM apt_complex_classifications WHERE complex_key = ?`,
      args: [target.complexKey],
    });
    const classification = classRes.rows[0] as Record<string, unknown> | undefined;
    if (!classification) throw new Error(`Missing classification ${target.complexKey}`);

    const groupsRes = await db.execute({
      sql: `SELECT * FROM apt_pyeong_groups WHERE complex_key = ? ORDER BY sort_order`,
      args: [target.complexKey],
    });
    const groupRows = groupsRes.rows as unknown as GroupRow[];

    const txRes = await db.execute({
      sql: `SELECT id, deal_date, deal_amount, exclusive_area
            FROM transactions
            WHERE apt_name_norm = ? AND deal_type = 'trade'
            ORDER BY deal_date ASC, id ASC`,
      args: [pilot.aptNameNorm],
    });
    const txRows = txRes.rows as unknown as TxRow[];
    const tradeLikes: SingogaTradeLike[] = txRows.map((t) => ({
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

    const productionFlags = markSingogaMarketGroupPriorExceed(tradeLikes, marketGroups);
    const exclusiveAllTime = markSingogaExclusiveAllTimeMax(tradeLikes);
    const exclusivePrior = markExclusivePriorExceed(tradeLikes);

    const productionCount = [...productionFlags.values()].filter(Boolean).length;
    const exclusiveAllTimeCount = [...exclusiveAllTime.values()].filter(Boolean).length;
    const exclusivePriorCount = [...exclusivePrior.values()].filter(Boolean).length;

    const groupAudits: unknown[] = [];
    let firstIncludeTotal = 0;
    let firstExcludeTotal = 0;
    const allSameDay: SameDayCase[] = [];
    const earlyWindowRh: Array<{
      groupLabel: string;
      dealDate: string;
      amount: number;
      priorMax: number;
    }> = [];

    for (const g of groupRows) {
      const mg: MarketGroupLike = {
        groupKey: String(g.group_key),
        exclusiveAreaMin: Number(g.exclusive_area_min),
        exclusiveAreaMax: Number(g.exclusive_area_max),
        groupConfidenceHigh: Number(g.group_confidence_high) === 1,
      };
      if (!mg.groupConfidenceHigh) continue;

      const label = formatMarketGroupLabel({
        marketLabel: g.market_label == null ? null : Number(g.market_label),
        displayMode: String(g.display_mode) as
          | "label+range"
          | "range_only"
          | "exclusive_only",
        supplyAreaMin: g.supply_area_min == null ? null : Number(g.supply_area_min),
        supplyAreaMax: g.supply_area_max == null ? null : Number(g.supply_area_max),
        exclusiveAreaMin: Number(g.exclusive_area_min),
        exclusiveAreaMax: Number(g.exclusive_area_max),
      });

      const inGroup = tradeLikes.filter((tx) => matchMarketGroup(tx.exclusiveArea, [mg]));
      const audited = auditOneGroup(inGroup, mg.groupKey);
      firstIncludeTotal += audited.firstInclude;
      firstExcludeTotal += audited.firstExclude;

      for (const c of audited.sameDayCases) {
        allSameDay.push({ ...c, groupLabel: label });
      }

      // Distinct exclusive areas in this group (inflation driver)
      const exclusiveAreas = [
        ...new Set(inGroup.map((tx) => Math.round(tx.exclusiveArea * 100) / 100)),
      ].sort((a, b) => a - b);
      const exclusivePriorInGroup = inGroup.filter((tx) => exclusivePrior.get(tx.id)).length;
      const exclusiveAllTimeInGroup = inGroup.filter((tx) => exclusiveAllTime.get(tx.id)).length;

      const firstDealDate = inGroup[0]?.dealDate ?? null;
      if (firstDealDate) {
        const firstMonth = firstDealDate.slice(0, 7);
        for (const t of audited.trades) {
          if (t.isRecordHighFirstExclude && t.dealDate.slice(0, 7) === firstMonth) {
            earlyWindowRh.push({
              groupLabel: label,
              dealDate: t.dealDate,
              amount: t.amount,
              priorMax: t.priorMax,
            });
          }
        }
      }

      const recentRh = audited.trades
        .filter((t) => t.isRecordHighFirstExclude)
        .slice(-5)
        .map((t) => ({
          dealDate: t.dealDate,
          amount: t.amount,
          exclusiveArea: t.exclusiveArea,
          priorMax: t.priorMax,
          previousRhAmount: t.previousRecordHighAmount,
          previousRhDate: t.previousRecordHighDate,
        }));

      for (const rh of recentRh) {
        externalSamples.push({
          aptNameNorm: pilot.aptNameNorm,
          groupLabel: label,
          exclusiveAreasInGroup: exclusiveAreas,
          ...rh,
        });
      }

      // Spot-check: production flag must match first-exclude audit for every trade
      let productionMismatch = 0;
      for (const t of audited.trades) {
        const prod = productionFlags.get(t.id) === true;
        if (prod !== t.isRecordHighFirstExclude) productionMismatch += 1;
      }

      groupAudits.push({
        groupKey: mg.groupKey,
        label,
        exclusiveAreaMin: mg.exclusiveAreaMin,
        exclusiveAreaMax: mg.exclusiveAreaMax,
        exclusiveAreaCount: exclusiveAreas.length,
        exclusiveAreas,
        tradeCount: inGroup.length,
        marketGroupFirstInclude: audited.firstInclude,
        marketGroupFirstExclude: audited.firstExclude,
        exclusivePriorExceedInGroup: exclusivePriorInGroup,
        exclusiveAllTimeMaxInGroup: exclusiveAllTimeInGroup,
        inflationVsExclusivePrior: audited.firstExclude - exclusivePriorInGroup,
        recordHighRateFirstExclude:
          inGroup.length > 0 ? round1((100 * audited.firstExclude) / inGroup.length) : 0,
        sameDayMultiExceedCases: audited.sameDayCases.length,
        firstDealDate,
        lastDealDate: inGroup.at(-1)?.dealDate ?? null,
        productionMismatchCount: productionMismatch,
        recentRecordHighs: recentRh,
        sampleTrades: [
          ...audited.trades.slice(0, 2),
          ...audited.trades.filter((t) => t.isRecordHighFirstExclude).slice(-3),
        ],
      });
    }

    const warehouseFirst = tradeLikes[0]?.dealDate ?? null;
    const warehouseLast = tradeLikes.at(-1)?.dealDate ?? null;
    const historyGapYears =
      warehouseFirst != null
        ? Math.max(0, Number(warehouseFirst.slice(0, 4)) - target.occupancyYear)
        : null;

    // Distinct exclusive areas overall
    const exclusiveAreaCount = new Set(
      tradeLikes.map((tx) => Math.round(tx.exclusiveArea * 100) / 100),
    ).size;

    results.push({
      complexKey: target.complexKey,
      aptNameNorm: pilot.aptNameNorm,
      displayName: target.displayName,
      classification: String(classification.classification),
      singogaMode: String(classification.singoga_mode),
      occupancyYear: target.occupancyYear,
      warehouseFirstDealDate: warehouseFirst,
      warehouseLastDealDate: warehouseLast,
      historyGapYears,
      historyCompleteness:
        historyGapYears != null && historyGapYears >= 5
          ? "low_confidence_early_window"
          : "ok",
      totalTrades: tradeLikes.length,
      marketGroupCount: marketGroups.length,
      exclusiveAreaCount,
      recordHigh: {
        marketGroupFirstInclude: firstIncludeTotal,
        marketGroupFirstExclude: firstExcludeTotal,
        productionMarkSingogaMarketGroupPriorExceed: productionCount,
        exclusivePriorExceed: exclusivePriorCount,
        exclusiveAllTimeMaxEquality: exclusiveAllTimeCount,
        phase5ReportedFirstExclude: target.phase5MarketGroupFirstExclude,
        matchesProductionCode: firstExcludeTotal === productionCount,
        matchesPhase5Report: firstExcludeTotal === target.phase5MarketGroupFirstExclude,
        inflationVsExclusivePrior: firstExcludeTotal - exclusivePriorCount,
        inflationVsExclusiveAllTime: firstExcludeTotal - exclusiveAllTimeCount,
        firstIncludeRate:
          tradeLikes.length > 0 ? round1((100 * firstIncludeTotal) / tradeLikes.length) : 0,
        firstExcludeRate:
          tradeLikes.length > 0 ? round1((100 * firstExcludeTotal) / tradeLikes.length) : 0,
      },
      inflationDecompositionNote:
        "Market-group prior-exceed counts every exceed of the group's shared max. Exclusive prior-exceed requires exceed within each exact area — merging areas multiplies 신고가 events because a mid-size trade can beat a smaller sibling area's history without beating its own area max.",
      sameDayMultiExceedCaseCount: allSameDay.length,
      sameDayMultiExceedCases: allSameDay.slice(0, 25),
      earlyWindowRecordHighsFirstMonth: earlyWindowRh.slice(0, 40),
      groups: groupAudits,
    });
  }

  const holds: string[] = [];
  for (const r of results as Array<Record<string, unknown>>) {
    if (r.historyCompleteness === "low_confidence_early_window") {
      holds.push(
        `${r.aptNameNorm}: warehouse starts ${r.warehouseFirstDealDate} vs occupancy ${r.occupancyYear} (gap ${r.historyGapYears}y) → early false 신고가 risk`,
      );
    }
    const rec = r.recordHigh as {
      matchesProductionCode: boolean;
      matchesPhase5Report: boolean;
    };
    if (!rec.matchesProductionCode) {
      holds.push(`${r.aptNameNorm}: audit first-exclude != production markSingogaMarketGroupPriorExceed`);
    }
    if (!rec.matchesPhase5Report) {
      holds.push(`${r.aptNameNorm}: audit first-exclude != Phase5 reported count`);
    }
    const groups = r.groups as Array<{ productionMismatchCount: number; label: string }>;
    for (const g of groups) {
      if (g.productionMismatchCount > 0) {
        holds.push(`${r.aptNameNorm}/${g.label}: ${g.productionMismatchCount} production flag mismatches`);
      }
    }
  }

  const algorithmOk = holds.every((h) => h.includes("warehouse starts") || h.includes("early false"));
  const decision = {
    allowlistExpansion: "HOLD" as const,
    reasons: holds,
    algorithmVerdict: algorithmOk
      ? "정상 (코드·재계산 일치). 확대 HOLD 이유는 history incompleteness."
      : "수정필요 또는 재검산 mismatch",
    note: "Same-day multi-exceed is intentional under current policy (no intra-day ordering). Not a HOLD by itself. History start gap is the blocking risk for allowlist expansion.",
  };

  const out = {
    generatedAt: new Date().toISOString(),
    scope: AUDIT_TARGETS.map((t) => t.displayName),
    safety: {
      productionWrite: false,
      pilotDataMutation: false,
      screenshots: 0,
    },
    algorithmNotes: {
      productionRule:
        "markSingogaMarketGroupPriorExceed + typeRecordHigh: current > priorMax; priorMax===0 → false (first trade excluded); ties false; same calendar date shares prior-day max only",
      firstTrade: {
        includeCountField: "marketGroupFirstInclude",
        excludeCountField: "marketGroupFirstExclude",
        productionPolicy: "exclude",
        recommendation: "exclude",
        rationale: [
          "이전 최고가가 없으면 '갱신'이 성립하지 않음",
          "아파트미/호갱노노 등 공개 서비스도 통상 첫 거래를 신고가로 세지 않음",
          "include는 group 수만큼 기계적 신고가를 추가해 비율을 왜곡",
        ],
      },
      sameDay: {
        policy: "prior = max(amount) where deal_date < D; no synthetic intra-day order",
        multiExceed: "each trade with amount > priorMax counts as 신고가",
      },
      exclusiveVsMarketGroup: {
        exclusiveAllTimeMaxEquality: "legacy apt-detail UI (ties at current max all true)",
        exclusivePriorExceed: "apples-to-apples prior-exceed per exact exclusive area",
        marketGroupPriorExceed: "A/B pilot production rule",
      },
      externalPractice: [
        "공개 서비스는 면적(또는 유사면적) 시계열의 이전 최고가 갱신을 신고가로 표시",
        "첫 거래 제외가 일반적",
        "동일일 다건 처리는 서비스마다 상이 — 재현 가능한 prior-date-only 규칙이 감사에 유리",
        "외부 사이트는 authoritative source 아님. 최종 기준은 MOLIT 거래 history",
      ],
    },
    decision,
    complexes: results,
    externalCrossCheckPack: {
      instruction:
        "Compare samples to 아파트미/호갱노노. Classify our/external as TT / TF / FT. MOLIT warehouse remains authoritative; external used only for discrepancy taxonomy.",
      sampleCount: externalSamples.length,
      samples: externalSamples,
      mismatchTaxonomy: [
        "history_start_gap",
        "grouping_diff_exact_vs_market_group",
        "first_trade_policy",
        "same_day_policy",
        "amount_or_date_display",
        "jeonse_or_cancelled_mix",
      ],
    },
  };

  const dir = join(process.cwd(), "data/poc/phase51");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "singoga-audit.json");
  writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`, "utf8");

  console.log(
    JSON.stringify(
      {
        wrote: path,
        decision: decision.allowlistExpansion,
        algorithmVerdict: decision.algorithmVerdict,
        holdReasons: decision.reasons,
        summary: (results as Array<Record<string, unknown>>).map((r) => {
          const rec = r.recordHigh as Record<string, number | boolean>;
          return {
            apt: r.aptNameNorm,
            trades: r.totalTrades,
            groups: r.marketGroupCount,
            exclusiveAreas: r.exclusiveAreaCount,
            firstInclude: rec.marketGroupFirstInclude,
            firstExclude: rec.marketGroupFirstExclude,
            exclusivePrior: rec.exclusivePriorExceed,
            exclusiveAllTime: rec.exclusiveAllTimeMaxEquality,
            inflationVsExclusivePrior: rec.inflationVsExclusivePrior,
            historyGapYears: r.historyGapYears,
            sameDayMulti: r.sameDayMultiExceedCaseCount,
            matchesPhase5: rec.matchesPhase5Report,
          };
        }),
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

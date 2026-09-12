/**
 * Phase 5.3b — production read-only verify: warehouse+DB baselines vs full-history.
 *
 * Seed each market-group with pre-warehouse MOLIT prior_max so that
 * 2016+ 신고가 matches full-history Phase 5.2b without storing old trades.
 *
 * No DB write / schema change / master mutation / screenshots.
 *
 *   npx tsx scripts/phase53b-verify-production-readonly.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { normalizeAptName } from "../src/lib/db/repository";
import { naturalKeyFromTx } from "../src/lib/market/identity";
import { fetchOneTradeForSync } from "../src/lib/molit/client";
import { typeRecordHigh } from "../src/lib/region/market-insight";
import type { Transaction } from "../src/types/transaction";

type Pilot = {
  complexKey: string;
  displayName: string;
  aptNameNorm: string;
  lawdCd: string;
  historyStartYm: string;
};

type Group = {
  groupKey: string;
  label: string;
  exclusiveAreaMin: number;
  exclusiveAreaMax: number;
  groupConfidenceHigh: boolean;
};

type TradeRow = {
  id: string;
  dealDate: string;
  dealAmount: number;
  exclusiveArea: number;
  naturalKey: string;
};

type Baseline = {
  groupKey: string;
  label: string;
  priorMaxAmount: number;
  priorMaxDealDate: string | null;
  preWarehouseTradeCount: number;
};

type MarkResult = {
  flags: Map<string, boolean>;
  priorAt: Map<string, number>;
};

const PILOTS: Pilot[] = [
  {
    complexKey: "hangang-daewoo",
    displayName: "한강(대우)",
    aptNameNorm: "한강(대우)",
    lawdCd: "11170",
    historyStartYm: "200601",
  },
  {
    complexKey: "parkrio",
    displayName: "파크리오",
    aptNameNorm: "파크리오",
    lawdCd: "11710",
    historyStartYm: "200808",
  },
  {
    complexKey: "banpo-xi",
    displayName: "반포자이",
    aptNameNorm: "반포자이",
    lawdCd: "11650",
    historyStartYm: "200903",
  },
  {
    complexKey: "jamsil-els",
    displayName: "잠실엘스",
    aptNameNorm: "잠실엘스",
    lawdCd: "11710",
    historyStartYm: "200809",
  },
];

const BANPO_TARGET_FLIPS = [
  { dealDate: "2025-02-18", dealAmount: 415000, exclusiveArea: 84.982 },
  { dealDate: "2025-07-10", dealAmount: 475000, exclusiveArea: 84.943 },
  { dealDate: "2026-06-20", dealAmount: 615000, exclusiveArea: 132.439 },
  { dealDate: "2026-07-20", dealAmount: 373000, exclusiveArea: 59.971 },
] as const;

/** Known MOLIT active trades that set full-history prior above warehouse max (not pre-WH). */
const BANPO_MISSING_PRIOR_TRADES = [
  {
    dealDate: "2025-01-25",
    dealAmount: 415000,
    exclusiveArea: 84.943,
    affectsFlip: "2025-02-18/415000",
  },
  {
    dealDate: "2025-06-14",
    dealAmount: 480000,
    exclusiveArea: 84.943,
    affectsFlip: "2025-07-10/475000",
  },
  {
    dealDate: "2026-03-09",
    dealAmount: 620000,
    exclusiveArea: 132.439,
    affectsFlip: "2026-06-20/615000",
  },
  {
    dealDate: "2025-07-10",
    dealAmount: 380000,
    exclusiveArea: 59.98,
    affectsFlip: "2026-07-20/373000",
  },
] as const;

function argValue(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function ymAdd(ym: string, delta: number): string {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(4, 6));
  const idx = y * 12 + (m - 1) + delta;
  return `${Math.floor(idx / 12)}${String((idx % 12) + 1).padStart(2, "0")}`;
}

function monthsBetween(fromYm: string, toYm: string): string[] {
  if (fromYm > toYm) return [];
  const out: string[] = [];
  for (let cur = fromYm; cur <= toYm; cur = ymAdd(cur, 1)) out.push(cur);
  return out;
}

function currentYmSeoul(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  return `${parts.find((p) => p.type === "year")!.value}${parts.find((p) => p.type === "month")!.value}`;
}

function matchGroup(area: number, groups: Group[]): Group | null {
  const hits = groups.filter(
    (g) =>
      g.groupConfidenceHigh &&
      area >= g.exclusiveAreaMin - 0.005 &&
      area <= g.exclusiveAreaMax + 0.005,
  );
  return hits.length === 1 ? hits[0]! : null;
}

function formatGroupLabel(row: Record<string, unknown>): string {
  const min = Number(row.exclusive_area_min);
  const max = Number(row.exclusive_area_max);
  const range =
    Math.abs(min - max) < 1e-9 ? `전용 ${min}㎡` : `전용 ${min}~${max}㎡`;
  if (row.market_label == null || row.market_label === "") return range;
  return `${Number(row.market_label)}평형 (${range})`;
}

function approxArea(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.001;
}

/** Phase5 rule + optional initial prior baseline per group. */
function markMarketGroupPriorExceed(
  trades: TradeRow[],
  groups: Group[],
  initialPrior?: Map<string, number>,
): MarkResult {
  const flags = new Map<string, boolean>();
  const priorAt = new Map<string, number>();
  const priorMax = new Map<string, number>(initialPrior ?? []);

  const sorted = [...trades].sort((a, b) => {
    if (a.dealDate !== b.dealDate) return a.dealDate < b.dealDate ? -1 : 1;
    return a.id.localeCompare(b.id);
  });

  let i = 0;
  while (i < sorted.length) {
    const day = sorted[i]!.dealDate;
    const batch: TradeRow[] = [];
    while (i < sorted.length && sorted[i]!.dealDate === day) {
      batch.push(sorted[i]!);
      i += 1;
    }
    const dayPeak = new Map<string, number>();
    for (const tx of batch) {
      const g = matchGroup(tx.exclusiveArea, groups);
      if (!g) {
        flags.set(tx.id, false);
        priorAt.set(tx.id, 0);
        continue;
      }
      const prior = priorMax.get(g.groupKey) ?? 0;
      priorAt.set(tx.id, prior);
      flags.set(tx.id, typeRecordHigh(tx.dealAmount, prior).isSingoga);
      dayPeak.set(
        g.groupKey,
        Math.max(dayPeak.get(g.groupKey) ?? 0, tx.dealAmount),
      );
    }
    for (const [gk, peak] of dayPeak) {
      priorMax.set(gk, Math.max(priorMax.get(gk) ?? 0, peak));
    }
  }
  return { flags, priorAt };
}

function computeBaselines(
  preWarehouseTrades: TradeRow[],
  groups: Group[],
): Baseline[] {
  const acc = new Map<
    string,
    { amount: number; date: string | null; count: number }
  >();
  for (const g of groups) {
    if (!g.groupConfidenceHigh) continue;
    acc.set(g.groupKey, { amount: 0, date: null, count: 0 });
  }
  for (const tx of preWarehouseTrades) {
    const g = matchGroup(tx.exclusiveArea, groups);
    if (!g) continue;
    const cur = acc.get(g.groupKey)!;
    cur.count += 1;
    if (tx.dealAmount > cur.amount) {
      cur.amount = tx.dealAmount;
      cur.date = tx.dealDate;
    }
  }
  return groups
    .filter((g) => g.groupConfidenceHigh)
    .map((g) => {
      const cur = acc.get(g.groupKey)!;
      return {
        groupKey: g.groupKey,
        label: g.label,
        priorMaxAmount: cur.amount,
        priorMaxDealDate: cur.date,
        preWarehouseTradeCount: cur.count,
      };
    });
}

async function mapPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, Math.max(items.length, 1)) },
      async () => {
        while (next < items.length) {
          const i = next;
          next += 1;
          await worker(items[i]!);
        }
      },
    ),
  );
}

function requireDb(): Client {
  const url = process.env.TURSO_DATABASE_URL?.trim();
  const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
  if (!url || !authToken) throw new Error("TURSO env missing");
  return createClient({ url, authToken });
}

async function loadGroups(db: Client, complexKey: string): Promise<Group[]> {
  const res = await db.execute({
    sql: `SELECT group_key, market_label, exclusive_area_min, exclusive_area_max,
                 group_confidence_high, sort_order
          FROM apt_pyeong_groups
          WHERE complex_key = ?
          ORDER BY sort_order`,
    args: [complexKey],
  });
  return res.rows.map((r) => ({
    groupKey: String(r.group_key),
    label: formatGroupLabel(r as Record<string, unknown>),
    exclusiveAreaMin: Number(r.exclusive_area_min),
    exclusiveAreaMax: Number(r.exclusive_area_max),
    groupConfidenceHigh: Number(r.group_confidence_high) === 1,
  }));
}

async function loadBaselinesFromDb(
  db: Client,
  complexKey: string,
): Promise<{ groupKey: string; priorMaxAmount: number; priorMaxDealDate: string | null; baselineUntil: string }[]> {
  const res = await db.execute({
    sql: `SELECT group_key, prior_max_amount, prior_max_deal_date, baseline_until
          FROM apt_pyeong_group_baselines WHERE complex_key = ?`,
    args: [complexKey],
  });
  return res.rows.map((r) => ({
    groupKey: String(r.group_key),
    priorMaxAmount: Number(r.prior_max_amount) || 0,
    priorMaxDealDate: r.prior_max_deal_date == null ? null : String(r.prior_max_deal_date),
    baselineUntil: String(r.baseline_until),
  }));
}

async function loadWarehouse(
  db: Client,
  aptNameNorm: string,
  lawdCd: string,
): Promise<TradeRow[]> {
  const res = await db.execute({
    sql: `SELECT id, deal_date, deal_amount, exclusive_area, apt_name,
                 gu, dong, jibun, floor, monthly_rent, dealing_gbn
          FROM transactions
          WHERE deal_type = 'trade' AND apt_name_norm = ? AND lawd_cd = ?
          ORDER BY deal_date ASC, id ASC`,
    args: [aptNameNorm, lawdCd],
  });
  return res.rows.map((r) => {
    const tx: Transaction = {
      id: String(r.id),
      dealType: "trade",
      dealDate: String(r.deal_date).slice(0, 10),
      aptName: String(r.apt_name),
      gu: String(r.gu ?? ""),
      dong: String(r.dong ?? ""),
      exclusiveArea: Number(r.exclusive_area) || 0,
      dealAmount: Number(r.deal_amount) || 0,
      monthlyRent: Number(r.monthly_rent) || 0,
      floor: Number(r.floor) || 0,
      buildYear: null,
      jibun: String(r.jibun ?? ""),
      dealingGbn: String(r.dealing_gbn ?? ""),
      lawdCd,
    };
    return {
      id: tx.id,
      dealDate: tx.dealDate,
      dealAmount: tx.dealAmount,
      exclusiveArea: tx.exclusiveArea,
      naturalKey: naturalKeyFromTx(tx, lawdCd),
    };
  });
}

function toTradeRow(tx: Transaction, lawdCd: string, idx: number): TradeRow {
  const dealDate = tx.dealDate.slice(0, 10);
  const id = [
    "molit",
    lawdCd,
    dealDate,
    normalizeAptName(tx.aptName),
    tx.dong,
    tx.jibun,
    String(tx.floor),
    String(tx.dealAmount),
    String(tx.exclusiveArea),
    String(idx),
  ].join("|");
  return {
    id,
    dealDate,
    dealAmount: tx.dealAmount,
    exclusiveArea: tx.exclusiveArea,
    naturalKey: naturalKeyFromTx({ ...tx, dealType: "trade" }, lawdCd),
  };
}

function dedupe(trades: TradeRow[]): TradeRow[] {
  const map = new Map<string, TradeRow>();
  for (const t of trades) {
    if (!map.has(t.naturalKey)) map.set(t.naturalKey, t);
  }
  return [...map.values()].sort((a, b) => {
    if (a.dealDate !== b.dealDate) return a.dealDate < b.dealDate ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
}

function countTrue(flags: Map<string, boolean>): number {
  let n = 0;
  for (const v of flags.values()) if (v) n += 1;
  return n;
}

async function main() {
  if (!process.env.MOLIT_API_KEY?.trim()) {
    throw new Error("MOLIT_API_KEY missing");
  }
  const db = requireDb();
  const concurrency = Number(argValue("concurrency", "5")) || 5;
  const toYm = argValue("to-month", currentYmSeoul());

  const cellMap = new Map<string, { lawdCd: string; yearMonth: string }>();
  for (const p of PILOTS) {
    for (const ym of monthsBetween(p.historyStartYm, toYm)) {
      cellMap.set(`${p.lawdCd}|${ym}`, { lawdCd: p.lawdCd, yearMonth: ym });
    }
  }
  const cells = [...cellMap.values()].sort((a, b) =>
    a.lawdCd === b.lawdCd
      ? a.yearMonth.localeCompare(b.yearMonth)
      : a.lawdCd.localeCompare(b.lawdCd),
  );

  console.log(
    `[phase53] READ-ONLY baseline PoC cells=${cells.length} concurrency=${concurrency} toYm=${toYm} WRITE=0`,
  );

  const pilotsByLawd = new Map<string, Pilot[]>();
  for (const p of PILOTS) {
    const list = pilotsByLawd.get(p.lawdCd) ?? [];
    list.push(p);
    pilotsByLawd.set(p.lawdCd, list);
  }

  const molitByApt = new Map<string, TradeRow[]>();
  for (const p of PILOTS) molitByApt.set(p.aptNameNorm, []);

  let done = 0;
  let fetchErrors = 0;
  const t0 = Date.now();

  await mapPool(cells, concurrency, async (cell) => {
    try {
      const active = await fetchOneTradeForSync(cell.lawdCd, cell.yearMonth);
      const pilots = pilotsByLawd.get(cell.lawdCd) ?? [];
      let idx = 0;
      for (const tx of active) {
        for (const p of pilots) {
          if (normalizeAptName(tx.aptName) !== p.aptNameNorm) continue;
          if (cell.yearMonth < p.historyStartYm) continue;
          molitByApt.get(p.aptNameNorm)!.push(toTradeRow(tx, p.lawdCd, idx++));
        }
      }
    } catch (err) {
      fetchErrors += 1;
      if (fetchErrors <= 5) {
        console.warn(
          `[phase53] fetch error ${cell.lawdCd} ${cell.yearMonth}`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    done += 1;
    if (done % 50 === 0 || done === cells.length) {
      console.log(
        `[phase53] fetch ${done}/${cells.length} errors=${fetchErrors} ${((Date.now() - t0) / 60000).toFixed(1)}m`,
      );
    }
  });

  const complexReports: unknown[] = [];
  let totalDiffs = 0;
  let totalPostWarehouseCompared = 0;
  let totalBaselineRows = 0;
  let totalPreWarehouseTrades = 0;
  let banpoFlipsCorrected = 0;

  for (const p of PILOTS) {
    const groups = await loadGroups(db, p.complexKey);
    const fullTrades = dedupe(molitByApt.get(p.aptNameNorm) ?? []);
    const whTrades = dedupe(await loadWarehouse(db, p.aptNameNorm, p.lawdCd));
    const warehouseStartDate = whTrades[0]?.dealDate ?? "2016-10-01";

    const preWarehouse = fullTrades.filter((t) => t.dealDate < warehouseStartDate);
    const postWarehouseFull = fullTrades.filter(
      (t) => t.dealDate >= warehouseStartDate,
    );

        const baselinesDb = await loadBaselinesFromDb(db, p.complexKey);
    if (baselinesDb.length === 0) {
      throw new Error(`no production baselines for ${p.complexKey}`);
    }
    totalBaselineRows += baselinesDb.length;
    totalPreWarehouseTrades += preWarehouse.length;

    const baselines = baselinesDb.map((b) => ({
      groupKey: b.groupKey,
      label: groups.find((g) => g.groupKey === b.groupKey)?.label ?? b.groupKey,
      priorMaxAmount: b.priorMaxAmount,
      priorMaxDealDate: b.priorMaxDealDate,
      preWarehouseTradeCount: 0,
      baselineUntil: b.baselineUntil,
    }));

    const initialPrior = new Map<string, number>();
    for (const b of baselinesDb) {
      if (b.priorMaxAmount > 0) initialPrior.set(b.groupKey, b.priorMaxAmount);
    }

    const fullMark = markMarketGroupPriorExceed(fullTrades, groups);
    const baselineMark = markMarketGroupPriorExceed(
      postWarehouseFull,
      groups,
      initialPrior,
    );
    const whNaive = markMarketGroupPriorExceed(whTrades, groups);
    const whBaseline = markMarketGroupPriorExceed(
      whTrades,
      groups,
      initialPrior,
    );

    const diffs: Array<Record<string, unknown>> = [];
    for (const tx of postWarehouseFull) {
      totalPostWarehouseCompared += 1;
      const fullFlag = fullMark.flags.get(tx.id) === true;
      const baseFlag = baselineMark.flags.get(tx.id) === true;
      if (fullFlag !== baseFlag) {
        const g = matchGroup(tx.exclusiveArea, groups);
        diffs.push({
          dealDate: tx.dealDate,
          dealAmount: tx.dealAmount,
          exclusiveArea: tx.exclusiveArea,
          groupLabel: g?.label ?? null,
          fullSingoga: fullFlag,
          baselineSingoga: baseFlag,
          fullPrior: fullMark.priorAt.get(tx.id) ?? 0,
          baselinePrior: baselineMark.priorAt.get(tx.id) ?? 0,
        });
      }
    }
    totalDiffs += diffs.length;

    let banpoDetail: unknown = null;
    if (p.complexKey === "banpo-xi") {
      banpoDetail = BANPO_TARGET_FLIPS.map((target) => {
        const whTx = whTrades.find(
          (t) =>
            t.dealDate === target.dealDate &&
            t.dealAmount === target.dealAmount &&
            approxArea(t.exclusiveArea, target.exclusiveArea),
        );
        if (!whTx) {
          return { ...target, foundInWarehouse: false, corrected: false };
        }
        const naive = whNaive.flags.get(whTx.id) === true;
        const withBase = whBaseline.flags.get(whTx.id) === true;
        const fullTx = postWarehouseFull.find(
          (t) =>
            t.dealDate === target.dealDate &&
            t.dealAmount === target.dealAmount &&
            approxArea(t.exclusiveArea, target.exclusiveArea),
        );
        const fullFlag = fullTx
          ? fullMark.flags.get(fullTx.id) === true
          : null;
        // Baseline-corrected means warehouse+baseline matches full (false),
        // while warehouse-naive was a false positive (true).
        const corrected =
          naive === true && withBase === false && fullFlag === false;
        if (corrected) banpoFlipsCorrected += 1;

        const g = matchGroup(whTx.exclusiveArea, groups);
        const missingPriors = BANPO_MISSING_PRIOR_TRADES.filter((m) =>
          m.affectsFlip.startsWith(target.dealDate),
        ).map((m) => {
          const inWh = whTrades.some(
            (t) =>
              t.dealDate === m.dealDate &&
              t.dealAmount === m.dealAmount &&
              approxArea(t.exclusiveArea, m.exclusiveArea),
          );
          const inMolit = postWarehouseFull.some(
            (t) =>
              t.dealDate === m.dealDate &&
              t.dealAmount === m.dealAmount &&
              approxArea(t.exclusiveArea, m.exclusiveArea),
          );
          return { ...m, inWarehouse: inWh, inMolitActive: inMolit };
        });

        return {
          ...target,
          groupLabel: g?.label ?? null,
          foundInWarehouse: true,
          warehouseNaiveSingoga: naive,
          warehouseBaselineSingoga: withBase,
          fullHistorySingoga: fullFlag,
          warehouseNaivePrior: whNaive.priorAt.get(whTx.id) ?? 0,
          warehouseBaselinePrior: whBaseline.priorAt.get(whTx.id) ?? 0,
          fullPrior: fullTx ? (fullMark.priorAt.get(fullTx.id) ?? 0) : null,
          corrected,
          rootCause:
            corrected
              ? "pre-warehouse-baseline"
              : "post-warehouse-molit-trade-missing-from-warehouse",
          missingPriorTrades: missingPriors,
        };
      });
    }

    const fullByKey = new Map(postWarehouseFull.map((t) => [t.naturalKey, t]));
    const whVsFullDiffs: unknown[] = [];
    let whMatched = 0;
    let whBaselineMatchFull = 0;
    let whNaiveMatchFull = 0;
    for (const whTx of whTrades) {
      const fullTx = fullByKey.get(whTx.naturalKey);
      if (!fullTx) continue;
      whMatched += 1;
      const fullFlag = fullMark.flags.get(fullTx.id) === true;
      const baseFlag = whBaseline.flags.get(whTx.id) === true;
      const naiveFlag = whNaive.flags.get(whTx.id) === true;
      if (baseFlag === fullFlag) whBaselineMatchFull += 1;
      if (naiveFlag === fullFlag) whNaiveMatchFull += 1;
      if (baseFlag !== fullFlag) {
        const g = matchGroup(whTx.exclusiveArea, groups);
        whVsFullDiffs.push({
          dealDate: whTx.dealDate,
          dealAmount: whTx.dealAmount,
          exclusiveArea: whTx.exclusiveArea,
          groupLabel: g?.label ?? null,
          fullSingoga: fullFlag,
          baselineSingoga: baseFlag,
          naiveSingoga: naiveFlag,
        });
      }
    }

    complexReports.push({
      complexKey: p.complexKey,
      displayName: p.displayName,
      aptNameNorm: p.aptNameNorm,
      lawdCd: p.lawdCd,
      warehouseStartDate,
      counts: {
        fullHistoryTrades: fullTrades.length,
        preWarehouseTrades: preWarehouse.length,
        postWarehouseFullTrades: postWarehouseFull.length,
        warehouseTrades: whTrades.length,
        marketGroupCount: baselines.length,
      },
      baselines,
      singogaCounts: {
        fullHistoryTrueOnPostWarehouse: countTrue(
          new Map(
            postWarehouseFull.map((t) => [
              t.id,
              fullMark.flags.get(t.id) === true,
            ]),
          ),
        ),
        baselineMethodTrue: countTrue(baselineMark.flags),
        warehouseNaiveTrue: countTrue(whNaive.flags),
        warehouseBaselineTrue: countTrue(whBaseline.flags),
      },
      fullVsBaselineOnPostWarehouseMolit: {
        comparedTrades: postWarehouseFull.length,
        diffCount: diffs.length,
        identical: diffs.length === 0,
        sampleDiffs: diffs.slice(0, 10),
      },
      warehousePathVsFullHistory: {
        matchedTrades: whMatched,
        baselineMatchCount: whBaselineMatchFull,
        naiveMatchCount: whNaiveMatchFull,
        baselineDiffCount: whVsFullDiffs.length,
        identical: whVsFullDiffs.length === 0,
        sampleDiffs: whVsFullDiffs.slice(0, 10),
      },
      banpoTargetFlips: banpoDetail,
    });
  }

  const historicalIdentical = totalDiffs === 0;
  const warehousePathDiffTotal = (
    complexReports as Array<Record<string, any>>
  ).reduce(
    (n, c) => n + Number(c.warehousePathVsFullHistory?.baselineDiffCount ?? 0),
    0,
  );
  const warehousePathIdentical = warehousePathDiffTotal === 0;

  const out = {
    generatedAt: new Date().toISOString(),
    phase: "5.3b-production-verify-readonly",
    safety: {
      productionWrite: false,
      schemaChange: false,
      pilotMasterMutation: false,
      screenshots: 0,
    },
    method: {
      fetch: "fetchOneTradeForSync → resolveActiveTrades",
      groups: "apt_pyeong_groups (Phase5, read-only)",
      baseline:
        "per market-group max(amount) where dealDate < warehouseStartDate",
      postWarehousePrior:
        "max(baseline, max of same-group trades on prior calendar dates)",
      rules: [
        "first observation not 신고가 when priorMax===0",
        "current > priorMax",
        "ties false",
        "same-day shares prior-day max only",
        "cancelled excluded via resolveActiveTrades",
      ],
      comparisonAxes: [
        "fullVsBaselineOnPostWarehouseMolit — Phase5.3 claim (MOLIT 2016+ + baseline vs full history)",
        "warehousePathVsFullHistory — production warehouse stream + baseline vs full history",
      ],
    },
    fetch: {
      uniqueLawdMonthCells: cells.length,
      concurrency,
      fetchErrors,
      elapsedSec: Math.round((Date.now() - t0) / 1000),
    },
    totals: {
      baselineStorageRows: totalBaselineRows,
      preWarehouseMolitTradesAvoided: totalPreWarehouseTrades,
      citedHistoricalBackfillTrades: 6414,
      writeReductionVsFullBackfill: {
        baselineRows: totalBaselineRows,
        measuredFullBackfillRows: totalPreWarehouseTrades,
        citedFullBackfillRows: 6414,
        rowsSavedVsMeasured: totalPreWarehouseTrades - totalBaselineRows,
        rowsSavedVsCited: 6414 - totalBaselineRows,
        reductionRatioVsMeasured:
          totalPreWarehouseTrades > 0
            ? Number(
                (1 - totalBaselineRows / totalPreWarehouseTrades).toFixed(4),
              )
            : null,
      },
      postWarehouseMolitTradesCompared: totalPostWarehouseCompared,
      fullVsBaselineDiffCount: totalDiffs,
      fullVsBaselineIdentical: historicalIdentical,
      warehousePathBaselineDiffCount: warehousePathDiffTotal,
      warehousePathIdentical,
      banpo2020FlipsCorrected: banpoFlipsCorrected,
      banpo2020FlipsTarget: BANPO_TARGET_FLIPS.length,
    },
    banpoFlipRootCause: {
      summary:
        "반포자이 2020+ flip 4건은 pre-warehouse baseline이 아니라 warehouse에 없는 post-2016 MOLIT 거래가 prior를 올린 경우",
      missingPriorTrades: BANPO_MISSING_PRIOR_TRADES,
    },
    verdict: {
      // Historical backfill replacement is proven iff MOLIT post-WH + baseline ≡ full.
      historicalBaselineReplacesFullHistoryBackfill: historicalIdentical,
      identicalToFullHistoryOnPostWarehouseMolit: historicalIdentical,
      banpoFlipsAllCorrected: banpoFlipsCorrected === 4,
      warehousePathMatchesFullHistory: warehousePathIdentical,
      // Baseline alone does not fix Banpo; warehouse sync gaps remain.
      productionApplicable:
        historicalIdentical &&
        banpoFlipsCorrected === 4 &&
        warehousePathIdentical,
      productionApplicableForHistoricalBaselineOnly: historicalIdentical,
      note: historicalIdentical
        ? banpoFlipsCorrected === 4 && warehousePathIdentical
          ? "Baseline prior-max reproduces full-history 신고가; Banpo flips corrected; warehouse path clean. Prefer ~19 baseline rows over ~6414 historical inserts (schema/write still needs separate approval)."
          : "PASS: pre-warehouse prior-max baseline reproduces full-history market-group 신고가 on the MOLIT 2016+ stream (0 diffs). FAIL: Banpo 2020+ flips are NOT corrected by baseline — root cause is missing post-warehouse MOLIT trades in warehouse (sync gap). Historical backfill replacement is valid; Banpo HOLD remains until warehouse completeness is fixed."
        : "Baseline did not match full-history on post-warehouse MOLIT; inspect diffs before production.",
    },
    complexes: complexReports,
  };

  const dir = join(process.cwd(), "data/poc/phase53b");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "prior-max-baseline-poc.json");
  writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`, "utf8");

  console.log(
    JSON.stringify(
      {
        wrote: path,
        fetch: out.fetch,
        totals: out.totals,
        verdict: out.verdict,
        summary: (complexReports as Array<Record<string, any>>).map((c) => ({
          apt: c.displayName,
          warehouseStart: c.warehouseStartDate,
          baselines: c.baselines.map((b: Baseline) => ({
            label: b.label,
            priorMax: b.priorMaxAmount,
            priorDate: b.priorMaxDealDate,
            preCount: b.preWarehouseTradeCount,
          })),
          fullVsBaselineDiff: c.fullVsBaselineOnPostWarehouseMolit.diffCount,
          whPathDiff: c.warehousePathVsFullHistory.baselineDiffCount,
          banpoCorrected:
            c.banpoTargetFlips == null
              ? null
              : (c.banpoTargetFlips as Array<{ corrected: boolean }>).filter(
                  (x) => x.corrected,
                ).length,
        })),
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

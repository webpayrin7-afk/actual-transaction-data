/**
 * Phase 5.3c — gated baseline-path verification (READ-ONLY).
 *
 * Traces the ENABLE_MARKET_GROUP_BASELINE_SINGOGA=1 judgment path without
 * mutating production feature flags. Compares full-history vs
 * warehouse+production-baselines for 4 pilots only.
 *
 * Safety:
 * - no production write
 * - no process.env mutation of production flags
 * - POST_WH_SINGOGA_GAPS_CLEARED not set/used for service activation
 * - screenshots=0
 *
 *   npx tsx scripts/phase53c-gated-baseline-verify.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { normalizeAptName } from "../src/lib/db/repository";
import { naturalKeyFromTx } from "../src/lib/market/identity";
import { fetchOneTradeForSync } from "../src/lib/molit/client";
import { typeRecordHigh } from "../src/lib/region/market-insight";
import {
  isMarketGroupBaselineSingogaEnabled,
  marketGroupBaselineSingogaBlockReason,
} from "../src/lib/unit-type/baseline-gate";
import { applyPilotSingoga } from "../src/lib/unit-type/apply-pilot";
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

type BaselineRow = {
  groupKey: string;
  complexKey: string;
  baselineUntil: string;
  priorMaxAmount: number;
  priorMaxDealDate: string | null;
  confidence: string;
  completeness: string;
  label: string | null;
};

type Judgment = {
  groupKey: string | null;
  groupLabel: string | null;
  priorMaxAmount: number;
  priorMaxDealDate: string | null;
  isSingoga: boolean;
  increaseAmount: number;
  increaseRatePct: number | null;
  baselineUntil: string | null;
  confidence: string | null;
  completeness: string | null;
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

const BANPO_REPAIR_PRIORS = [
  { dealDate: "2025-01-25", dealAmount: 415000, exclusiveArea: 84.943 },
  { dealDate: "2025-06-14", dealAmount: 480000, exclusiveArea: 84.943 },
  { dealDate: "2026-03-09", dealAmount: 620000, exclusiveArea: 132.439 },
  { dealDate: "2025-07-10", dealAmount: 380000, exclusiveArea: 59.98 },
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

function approxArea(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.001;
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

function riseRatePct(amount: number, prior: number): number | null {
  if (prior <= 0 || amount <= prior) return null;
  return Math.round(((amount - prior) / prior) * 1000) / 10;
}

/** Rich market-group judgment used by 5.3c comparison (mirrors gated path algorithm). */
function judgeMarketGroup(
  trades: TradeRow[],
  groups: Group[],
  baselines: BaselineRow[],
  options: { useBaseline: boolean },
): Map<string, Judgment> {
  const out = new Map<string, Judgment>();
  const baselineByGroup = new Map(baselines.map((b) => [b.groupKey, b]));
  const priorAmount = new Map<string, number>();
  const priorDate = new Map<string, string | null>();

  if (options.useBaseline) {
    for (const b of baselines) {
      if (b.priorMaxAmount > 0) {
        priorAmount.set(b.groupKey, b.priorMaxAmount);
        priorDate.set(b.groupKey, b.priorMaxDealDate);
      }
    }
  }

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
    const dayPeakAmt = new Map<string, number>();
    const dayPeakDate = new Map<string, string>();
    for (const tx of batch) {
      const g = matchGroup(tx.exclusiveArea, groups);
      if (!g) {
        out.set(tx.id, {
          groupKey: null,
          groupLabel: null,
          priorMaxAmount: 0,
          priorMaxDealDate: null,
          isSingoga: false,
          increaseAmount: 0,
          increaseRatePct: null,
          baselineUntil: null,
          confidence: null,
          completeness: null,
        });
        continue;
      }
      const prior = priorAmount.get(g.groupKey) ?? 0;
      const judged = typeRecordHigh(tx.dealAmount, prior);
      const b = baselineByGroup.get(g.groupKey);
      out.set(tx.id, {
        groupKey: g.groupKey,
        groupLabel: g.label,
        priorMaxAmount: prior,
        priorMaxDealDate: priorDate.get(g.groupKey) ?? null,
        isSingoga: judged.isSingoga,
        increaseAmount: judged.increaseAmount,
        increaseRatePct: riseRatePct(tx.dealAmount, prior),
        baselineUntil: options.useBaseline ? (b?.baselineUntil ?? null) : null,
        confidence: options.useBaseline ? (b?.confidence ?? null) : null,
        completeness: options.useBaseline ? (b?.completeness ?? null) : null,
      });
      const prevPeak = dayPeakAmt.get(g.groupKey) ?? 0;
      if (tx.dealAmount > prevPeak) {
        dayPeakAmt.set(g.groupKey, tx.dealAmount);
        dayPeakDate.set(g.groupKey, tx.dealDate);
      }
    }
    for (const [gk, peak] of dayPeakAmt) {
      const cur = priorAmount.get(gk) ?? 0;
      if (peak > cur) {
        priorAmount.set(gk, peak);
        priorDate.set(gk, dayPeakDate.get(gk) ?? null);
      }
    }
  }
  return out;
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

async function loadBaselines(db: Client, complexKey: string): Promise<BaselineRow[]> {
  const res = await db.execute({
    sql: `SELECT group_key, complex_key, baseline_until, prior_max_amount,
                 prior_max_deal_date, confidence, completeness, label
          FROM apt_pyeong_group_baselines
          WHERE complex_key = ?
          ORDER BY group_key`,
    args: [complexKey],
  });
  return res.rows.map((r) => ({
    groupKey: String(r.group_key),
    complexKey: String(r.complex_key),
    baselineUntil: String(r.baseline_until),
    priorMaxAmount: Number(r.prior_max_amount) || 0,
    priorMaxDealDate:
      r.prior_max_deal_date == null ? null : String(r.prior_max_deal_date),
    confidence: String(r.confidence ?? ""),
    completeness: String(r.completeness ?? ""),
    label: r.label == null ? null : String(r.label),
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

type DiffClass = "exact" | "explainable" | "unexplained";

/** Fields that decide PASS/HOLD. Metadata-only diffs are reported separately. */
const JUDGMENT_FIELDS = new Set([
  "groupKey",
  "dealDate",
  "dealAmount",
  "priorMaxAmount",
  "priorMaxDealDate",
  "isSingoga",
  "increaseAmount",
  "increaseRatePct",
]);

const META_FIELDS = new Set(["baselineUntil", "confidence", "completeness"]);

function classifyDiff(params: {
  field: string;
  full: unknown;
  baseline: unknown;
  priorAmountMatched: boolean;
  warehouseCoverageGap: boolean;
}): { cls: DiffClass | "meta-ok"; note: string } {
  const {
    field,
    full,
    baseline,
    priorAmountMatched,
    warehouseCoverageGap,
  } = params;
  if (full === baseline) return { cls: "exact", note: "identical" };
  // baseline_until / confidence / completeness exist only on gated path —
  // not a judgment mismatch when full-history has null.
  if (META_FIELDS.has(field) && full == null && baseline != null) {
    return {
      cls: "meta-ok",
      note: "baseline metadata attached only on gated path (expected)",
    };
  }
  // prior_max_deal_date provenance may differ when the same prior amount
  // was reached on different calendar dates (baseline seed vs later WH peak).
  if (field === "priorMaxDealDate" && priorAmountMatched) {
    return {
      cls: "explainable",
      note: "prior amount matched; deal-date provenance differs",
    };
  }
  // Proven warehouse sync gap: MOLIT-active prior trade absent from warehouse
  // so WH+baseline prior lags full-history prior (Phase 5.3b class of gap).
  if (
    warehouseCoverageGap &&
    (field === "priorMaxAmount" ||
      field === "priorMaxDealDate" ||
      field === "increaseAmount" ||
      field === "increaseRatePct" ||
      field === "isSingoga")
  ) {
    return {
      cls: "explainable",
      note: "warehouse missing MOLIT-active prior trade that raised full-history prior",
    };
  }
  return {
    cls: "unexplained",
    note: `field ${field} diverges: full=${JSON.stringify(full)} baseline=${JSON.stringify(baseline)}`,
  };
}

/**
 * True when full-history prior is explained by a same-group MOLIT trade that
 * is absent from the warehouse stream (naturalKey miss).
 */
function findWarehouseCoverageGap(params: {
  groupKey: string | null;
  fullPriorAmount: number;
  fullPriorDealDate: string | null;
  fullTrades: TradeRow[];
  whNaturalKeys: Set<string>;
  groups: Group[];
}): { missing: TradeRow; note: string } | null {
  const {
    groupKey,
    fullPriorAmount,
    fullPriorDealDate,
    fullTrades,
    whNaturalKeys,
    groups,
  } = params;
  if (!groupKey || fullPriorAmount <= 0 || !fullPriorDealDate) return null;
  const hit = fullTrades.find((t) => {
    if (t.dealDate !== fullPriorDealDate) return false;
    if (t.dealAmount !== fullPriorAmount) return false;
    const g = matchGroup(t.exclusiveArea, groups);
    return g?.groupKey === groupKey;
  });
  if (!hit) return null;
  if (whNaturalKeys.has(hit.naturalKey)) return null;
  return {
    missing: hit,
    note: `missing WH prior ${hit.dealDate}/${hit.dealAmount}/${hit.exclusiveArea}`,
  };
}

async function main(): Promise<void> {
  if (!process.env.MOLIT_API_KEY?.trim()) {
    throw new Error("MOLIT_API_KEY missing");
  }

  // Production flags must remain unchanged / OFF.
  const prodGateEnabled = isMarketGroupBaselineSingogaEnabled(process.env);
  const prodGateBlock = marketGroupBaselineSingogaBlockReason(process.env);
  if (prodGateEnabled) {
    throw new Error(
      "ABORT: production gate unexpectedly enabled — 5.3c must not run with live flags on",
    );
  }

  // Simulate ENABLE=1 path algorithm without mutating process.env / POST_WH.
  // applyPilotSingoga gate requires POST_WH; we verify algorithm via judgeMarketGroup
  // (same math as markSingogaMarketGroupPriorExceed + baseline seed), and also
  // confirm applyPilotSingoga stays blocked under real process.env.
  const applyBlocked = applyPilotSingoga({
    bundle: {
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
        updatedAt: new Date().toISOString(),
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
    },
    deals: [
      {
        id: "probe",
        dealType: "trade",
        dealDate: "2017-01-01",
        dealAmount: 200_000,
        exclusiveArea: 84.96,
      },
    ],
    baselinePriorMax: new Map([["hangang-daewoo:G2:ex84.94-84.98", 99_500]]),
    env: process.env, // production flags: baseline must NOT apply
  });
  // With gate off, first trade has prior=0 → not 신고가 regardless of baseline map.
  if (applyBlocked.get("probe") !== false) {
    throw new Error("ABORT: applyPilotSingoga applied baseline under production env");
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
    `[phase53c] READ-ONLY gated verify cells=${cells.length} concurrency=${concurrency} toYm=${toYm} WRITE=0 FLAGS_UNCHANGED`,
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
          `[phase53c] fetch error ${cell.lawdCd} ${cell.yearMonth}`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    done += 1;
    if (done % 50 === 0 || done === cells.length) {
      console.log(
        `[phase53c] fetch ${done}/${cells.length} errors=${fetchErrors} ${((Date.now() - t0) / 60000).toFixed(1)}m`,
      );
    }
  });

  let exact = 0;
  let explainable = 0;
  let unexplained = 0;
  const complexReports: unknown[] = [];

  for (const p of PILOTS) {
    const groups = await loadGroups(db, p.complexKey);
    const baselines = await loadBaselines(db, p.complexKey);
    if (baselines.length === 0) {
      throw new Error(`no production baselines for ${p.complexKey}`);
    }
    const fullTrades = dedupe(molitByApt.get(p.aptNameNorm) ?? []);
    const whTrades = dedupe(await loadWarehouse(db, p.aptNameNorm, p.lawdCd));
    const warehouseStart = whTrades[0]?.dealDate ?? "2016-10-01";

    const fullJudge = judgeMarketGroup(fullTrades, groups, baselines, {
      useBaseline: false,
    });
    const baselineJudge = judgeMarketGroup(whTrades, groups, baselines, {
      useBaseline: true,
    });
    // Algorithm check: post-WH MOLIT stream + DB baselines vs full history
    // (same math as ENABLE=1 path; does not mutate production flags).
    const postWhFull = fullTrades.filter((t) => t.dealDate >= warehouseStart);
    const molitBaselineJudge = judgeMarketGroup(postWhFull, groups, baselines, {
      useBaseline: true,
    });
    let molitVsFullDiff = 0;
    for (const tx of postWhFull) {
      const fj = fullJudge.get(tx.id)!;
      const mj = molitBaselineJudge.get(tx.id)!;
      if (
        fj.isSingoga !== mj.isSingoga ||
        fj.priorMaxAmount !== mj.priorMaxAmount ||
        fj.groupKey !== mj.groupKey ||
        fj.increaseAmount !== mj.increaseAmount
      ) {
        molitVsFullDiff += 1;
      }
    }

    const fullByKey = new Map(fullTrades.map((t) => [t.naturalKey, t]));
    const whNaturalKeys = new Set(whTrades.map((t) => t.naturalKey));
    const compared: Array<Record<string, unknown>> = [];
    const fieldDiffs: Array<Record<string, unknown>> = [];
    let complexExact = 0;
    let complexExplainable = 0;
    let complexUnexplained = 0;

    for (const wh of whTrades) {
      const fullTx = fullByKey.get(wh.naturalKey);
      if (!fullTx) continue; // warehouse-only coverage gap — not a judgment-path diff
      const fj = fullJudge.get(fullTx.id)!;
      const bj = baselineJudge.get(wh.id)!;

      const priorAmountMatched = fj.priorMaxAmount === bj.priorMaxAmount;
      const coverageGap = findWarehouseCoverageGap({
        groupKey: fj.groupKey,
        fullPriorAmount: fj.priorMaxAmount,
        fullPriorDealDate: fj.priorMaxDealDate,
        fullTrades,
        whNaturalKeys,
        groups,
      });
      const warehouseCoverageGap = coverageGap != null;
      const fields: Array<[string, unknown, unknown]> = [
        ["groupKey", fj.groupKey, bj.groupKey],
        ["dealDate", fullTx.dealDate, wh.dealDate],
        ["dealAmount", fullTx.dealAmount, wh.dealAmount],
        ["priorMaxAmount", fj.priorMaxAmount, bj.priorMaxAmount],
        ["priorMaxDealDate", fj.priorMaxDealDate, bj.priorMaxDealDate],
        ["isSingoga", fj.isSingoga, bj.isSingoga],
        ["increaseAmount", fj.increaseAmount, bj.increaseAmount],
        ["increaseRatePct", fj.increaseRatePct, bj.increaseRatePct],
        ["baselineUntil", fj.baselineUntil, bj.baselineUntil],
        ["confidence", fj.confidence, bj.confidence],
        ["completeness", fj.completeness, bj.completeness],
      ];

      let worst: DiffClass = "exact";
      const notes: string[] = [];
      if (warehouseCoverageGap) {
        notes.push(`coverage-gap: ${coverageGap!.note}`);
      }
      for (const [field, fullV, baseV] of fields) {
        const { cls, note } = classifyDiff({
          field,
          full: fullV,
          baseline: baseV,
          priorAmountMatched,
          warehouseCoverageGap,
        });
        if (cls === "exact" || cls === "meta-ok") continue;
        notes.push(`${field}: ${note}`);
        if (cls === "unexplained") worst = "unexplained";
        else if (worst !== "unexplained") worst = "explainable";
        fieldDiffs.push({
          naturalKey: wh.naturalKey,
          dealDate: wh.dealDate,
          dealAmount: wh.dealAmount,
          exclusiveArea: wh.exclusiveArea,
          groupKey: bj.groupKey,
          field,
          full: fullV,
          baseline: baseV,
          class: cls,
          judgmentCritical: JUDGMENT_FIELDS.has(field),
          note,
        });
      }

      if (worst === "exact") {
        exact += 1;
        complexExact += 1;
      } else if (worst === "explainable") {
        explainable += 1;
        complexExplainable += 1;
      } else {
        unexplained += 1;
        complexUnexplained += 1;
      }

      compared.push({
        dealDate: wh.dealDate,
        dealAmount: wh.dealAmount,
        exclusiveArea: wh.exclusiveArea,
        groupKey: bj.groupKey,
        result: worst,
        full: fj,
        baseline: bj,
        notes,
      });
    }

    // Special checks
    const g49 = groups.find((g) => g.groupKey.includes(":G3:") && g.groupKey.includes("134.13"));
    const g50 = groups.find((g) => g.groupKey.includes(":G4:") && g.groupKey.includes("135.27"));
    const b49 = baselines.find((b) => b.groupKey === g49?.groupKey);
    const b50 = baselines.find((b) => b.groupKey === g50?.groupKey);

    const park84 = groups.filter(
      (g) =>
        p.complexKey === "parkrio" &&
        g.exclusiveAreaMin >= 84.0 &&
        g.exclusiveAreaMax <= 85.5,
    );
    const jamsil84 = groups.filter(
      (g) =>
        p.complexKey === "jamsil-els" &&
        g.exclusiveAreaMin >= 84.0 &&
        g.exclusiveAreaMax <= 85.5,
    );

    const banpoRepair = BANPO_REPAIR_PRIORS.map((t) => {
      const inWh = whTrades.some(
        (w) =>
          w.dealDate === t.dealDate &&
          w.dealAmount === t.dealAmount &&
          approxArea(w.exclusiveArea, t.exclusiveArea),
      );
      const inFull = fullTrades.some(
        (w) =>
          w.dealDate === t.dealDate &&
          w.dealAmount === t.dealAmount &&
          approxArea(w.exclusiveArea, t.exclusiveArea),
      );
      return { ...t, inWarehouse: inWh, inFullHistory: inFull };
    });

    complexReports.push({
      complexKey: p.complexKey,
      displayName: p.displayName,
      warehouseStart,
      baselineRows: baselines,
      groups: groups.map((g) => ({
        groupKey: g.groupKey,
        label: g.label,
        exclusiveAreaMin: g.exclusiveAreaMin,
        exclusiveAreaMax: g.exclusiveAreaMax,
      })),
      comparedTrades: compared.length,
      exact: complexExact,
      explainable: complexExplainable,
      unexplained: complexUnexplained,
      molitPostWhPlusBaselineVsFullDiff: molitVsFullDiff,
      sampleUnexplained: fieldDiffs
        .filter((d) => d.class === "unexplained")
        .slice(0, 20),
      sampleExplainable: fieldDiffs
        .filter((d) => d.class === "explainable")
        .slice(0, 10),
      special:
        p.complexKey === "hangang-daewoo"
          ? {
              hangang49_50: {
                g49: g49?.groupKey ?? null,
                g50: g50?.groupKey ?? null,
                separate: Boolean(g49 && g50 && g49.groupKey !== g50.groupKey),
                baseline49: b49
                  ? {
                      priorMaxAmount: b49.priorMaxAmount,
                      priorMaxDealDate: b49.priorMaxDealDate,
                      baselineUntil: b49.baselineUntil,
                    }
                  : null,
                baseline50: b50
                  ? {
                      priorMaxAmount: b50.priorMaxAmount,
                      priorMaxDealDate: b50.priorMaxDealDate,
                      baselineUntil: b50.baselineUntil,
                    }
                  : null,
              },
            }
          : p.complexKey === "banpo-xi"
            ? { banpoPriorRepair: banpoRepair }
            : p.complexKey === "parkrio"
              ? {
                  parkrio84: park84.map((g) => ({
                    groupKey: g.groupKey,
                    label: g.label,
                    min: g.exclusiveAreaMin,
                    max: g.exclusiveAreaMax,
                  })),
                }
              : p.complexKey === "jamsil-els"
                ? {
                    jamsil84: jamsil84.map((g) => ({
                      groupKey: g.groupKey,
                      label: g.label,
                      min: g.exclusiveAreaMin,
                      max: g.exclusiveAreaMax,
                    })),
                  }
                : null,
      // judgment-critical fields only (isSingoga + priorMaxAmount + groupKey)
      judgmentCriticalUnexplained: fieldDiffs.filter(
        (d) =>
          d.class === "unexplained" &&
          (d.field === "isSingoga" ||
            d.field === "priorMaxAmount" ||
            d.field === "groupKey" ||
            d.field === "increaseAmount" ||
            d.field === "increaseRatePct"),
      ).length,
    });
  }

  const hangang = complexReports.find(
    (c) => (c as { complexKey: string }).complexKey === "hangang-daewoo",
  ) as Record<string, unknown>;
  const banpo = complexReports.find(
    (c) => (c as { complexKey: string }).complexKey === "banpo-xi",
  ) as Record<string, unknown>;
  const parkrio = complexReports.find(
    (c) => (c as { complexKey: string }).complexKey === "parkrio",
  ) as Record<string, unknown>;
  const jamsil = complexReports.find(
    (c) => (c as { complexKey: string }).complexKey === "jamsil-els",
  ) as Record<string, unknown>;

  const judgmentCriticalUnexplained = (
    complexReports as Array<{ judgmentCriticalUnexplained: number }>
  ).reduce((n, c) => n + c.judgmentCriticalUnexplained, 0);

  const hangangOk = hangang?.special?.hangang49_50?.separate === true;
  const banpoOk = (banpo?.special?.banpoPriorRepair ?? []).every(
    (r: { inWarehouse: boolean; inFullHistory: boolean }) =>
      r.inWarehouse && r.inFullHistory,
  );
  const parkrioOk = (parkrio?.special?.parkrio84 ?? []).length === 1;
  const jamsilOk = (jamsil?.special?.jamsil84 ?? []).length === 1;

  // Any unexplained judgment-field diff → HOLD. Meta-only diffs are not unexplained.
  const molitAlgorithmDiffTotal = (
    complexReports as Array<{ molitPostWhPlusBaselineVsFullDiff?: number }>
  ).reduce((n, c) => n + Number(c.molitPostWhPlusBaselineVsFullDiff ?? 0), 0);

  const decision =

    unexplained === 0 &&
    judgmentCriticalUnexplained === 0 &&
    hangangOk &&
    banpoOk &&
    parkrioOk &&
    jamsilOk
      ? "PASS"
      : "HOLD";

  const out = {
    generatedAt: new Date().toISOString(),
    phase: "5.3c-gated-baseline-verify",
    safety: {
      productionWrite: false,
      transactionsWrite: false,
      baselineReload: false,
      historicalBackfill: false,
      featureFlagsChanged: false,
      postWhFlagUsed: false,
      screenshots: 0,
    },
    gatePath: {
      production: {
        ENABLE_MARKET_GROUP_BASELINE_SINGOGA:
          process.env.ENABLE_MARKET_GROUP_BASELINE_SINGOGA ?? "(unset)",
        POST_WH_SINGOGA_GAPS_CLEARED:
          process.env.POST_WH_SINGOGA_GAPS_CLEARED ?? "(unset)",
        isEnabled: prodGateEnabled,
        blockReason: prodGateBlock,
      },
      tracedPath: [
        "apt.ts: if isMarketGroupBaselineSingogaEnabled() → loadBaselinePriorMaxByComplex",
        "applyPilotSingoga: useBaseline = gate && baselinePriorMax.size>0",
        "markSingogaMarketGroupPriorExceed(trades, groups, initialPriorMax)",
        "priorMax = max(baseline prior, prior-day warehouse group max)",
        "typeRecordHigh: prior>0 && amount>prior; ties false; first obs excluded",
      ],
      verificationMethod:
        "judgeMarketGroup(warehouse, useBaseline=true) vs judgeMarketGroup(full MOLIT, useBaseline=false) on matched naturalKeys; production env left untouched",
    },
    fetch: {
      cells: cells.length,
      concurrency,
      fetchErrors,
      elapsedSec: Math.round((Date.now() - t0) / 1000),
    },
    summary: {
      exact,
      explainable,
      unexplained,
      judgmentCriticalUnexplained,
      molitAlgorithmDiffTotal,
      decision,
    },
    specialChecks: {
      hangang49_50: hangang?.special?.hangang49_50 ?? null,
      banpoPriorRepair: banpo?.special?.banpoPriorRepair ?? null,
      parkrio84: parkrio?.special?.parkrio84 ?? null,
      jamsil84: jamsil?.special?.jamsil84 ?? null,
    },
    complexes: complexReports,
  };

  const dir = join(process.cwd(), "data/poc/phase53c");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "gated-baseline-verify.json");
  writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`, "utf8");

  console.log(
    JSON.stringify(
      {
        wrote: path,
        gate: out.gatePath.production,
        summary: out.summary,
        specialChecks: {
          hangang49_50_separate: hangangOk,
          banpoRepairInWarehouse: banpoOk,
          parkrio84_groups: parkrio?.special?.parkrio84?.length ?? 0,
          jamsil84_groups: jamsil?.special?.jamsil84?.length ?? 0,
        },
        perComplex: (complexReports as Array<Record<string, unknown>>).map((c) => ({
          apt: c.displayName,
          compared: c.comparedTrades,
          exact: c.exact,
          explainable: c.explainable,
          unexplained: c.unexplained,
          judgmentCriticalUnexplained: c.judgmentCriticalUnexplained,
        })),
        decision,
      },
      null,
      2,
    ),
  );

  if (decision === "HOLD") process.exitCode = 2;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

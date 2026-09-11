/**
 * Phase 5.2b — full-history 신고가 READ-ONLY 검증.
 *
 * fetchOneTradeForSync (= resolveActiveTrades) + Phase5 apt_pyeong_groups.
 * No DB write / sync / master mutation / screenshots.
 *
 *   npx tsx scripts/phase52b-fullhistory-singoga-readonly.ts
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
  startYm: string;
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

type MarkResult = {
  flags: Map<string, boolean>;
  priorAt: Map<string, number>;
  groupFirstTradeDate: Map<string, string>;
  groupFirstTradeAmount: Map<string, number>;
  groupFirstSingogaDate: Map<string, string>;
};

type Flip = {
  dealDate: string;
  dealAmount: number;
  exclusiveArea: number;
  groupKey: string | null;
  groupLabel: string | null;
  warehousePrior: number;
  fullPrior: number;
  fullSingoga: boolean;
};

const PILOTS: Pilot[] = [
  {
    complexKey: "hangang-daewoo",
    displayName: "한강(대우)",
    aptNameNorm: "한강(대우)",
    lawdCd: "11170",
    startYm: "200601",
  },
  {
    complexKey: "parkrio",
    displayName: "파크리오",
    aptNameNorm: "파크리오",
    lawdCd: "11710",
    startYm: "200808",
  },
  {
    complexKey: "banpo-xi",
    displayName: "반포자이",
    aptNameNorm: "반포자이",
    lawdCd: "11650",
    startYm: "200903",
  },
  {
    complexKey: "jamsil-els",
    displayName: "잠실엘스",
    aptNameNorm: "잠실엘스",
    lawdCd: "11710",
    startYm: "200809",
  },
];

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

function areaKey(sqm: number): string {
  return String(Math.round(sqm * 100) / 100);
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

/** Phase5 rule: first excluded, ties false, same-day shares prior-day max. */
function markMarketGroupPriorExceed(
  trades: TradeRow[],
  groups: Group[],
): MarkResult {
  const flags = new Map<string, boolean>();
  const priorAt = new Map<string, number>();
  const groupFirstTradeDate = new Map<string, string>();
  const groupFirstTradeAmount = new Map<string, number>();
  const groupFirstSingogaDate = new Map<string, string>();
  const priorMax = new Map<string, number>();

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
      if (!groupFirstTradeDate.has(g.groupKey)) {
        groupFirstTradeDate.set(g.groupKey, tx.dealDate);
        groupFirstTradeAmount.set(g.groupKey, tx.dealAmount);
      }
      const is = typeRecordHigh(tx.dealAmount, prior).isSingoga;
      flags.set(tx.id, is);
      if (is && !groupFirstSingogaDate.has(g.groupKey)) {
        groupFirstSingogaDate.set(g.groupKey, tx.dealDate);
      }
      dayPeak.set(
        g.groupKey,
        Math.max(dayPeak.get(g.groupKey) ?? 0, tx.dealAmount),
      );
    }
    for (const [gk, peak] of dayPeak) {
      priorMax.set(gk, Math.max(priorMax.get(gk) ?? 0, peak));
    }
  }

  return {
    flags,
    priorAt,
    groupFirstTradeDate,
    groupFirstTradeAmount,
    groupFirstSingogaDate,
  };
}

function markExclusivePriorExceed(trades: TradeRow[]): {
  flags: Map<string, boolean>;
  priorAt: Map<string, number>;
} {
  const flags = new Map<string, boolean>();
  const priorAt = new Map<string, number>();
  const priorMax = new Map<string, number>();
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
      const key = areaKey(tx.exclusiveArea);
      const prior = priorMax.get(key) ?? 0;
      priorAt.set(tx.id, prior);
      flags.set(tx.id, typeRecordHigh(tx.dealAmount, prior).isSingoga);
      dayPeak.set(key, Math.max(dayPeak.get(key) ?? 0, tx.dealAmount));
    }
    for (const [k, peak] of dayPeak) {
      priorMax.set(k, Math.max(priorMax.get(k) ?? 0, peak));
    }
  }
  return { flags, priorAt };
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
    for (const ym of monthsBetween(p.startYm, toYm)) {
      cellMap.set(`${p.lawdCd}|${ym}`, { lawdCd: p.lawdCd, yearMonth: ym });
    }
  }
  const cells = [...cellMap.values()].sort((a, b) =>
    a.lawdCd === b.lawdCd
      ? a.yearMonth.localeCompare(b.yearMonth)
      : a.lawdCd.localeCompare(b.lawdCd),
  );

  console.log(
    `[phase52b] READ-ONLY cells=${cells.length} concurrency=${concurrency} toYm=${toYm} WRITE=0`,
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
          if (cell.yearMonth < p.startYm) continue;
          molitByApt.get(p.aptNameNorm)!.push(toTradeRow(tx, p.lawdCd, idx++));
        }
      }
    } catch (err) {
      fetchErrors += 1;
      if (fetchErrors <= 5) {
        console.warn(
          `[phase52b] fetch error ${cell.lawdCd} ${cell.yearMonth}`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    done += 1;
    if (done % 50 === 0 || done === cells.length) {
      console.log(
        `[phase52b] fetch ${done}/${cells.length} errors=${fetchErrors} ${((Date.now() - t0) / 60000).toFixed(1)}m`,
      );
    }
  });

  const complexReports: unknown[] = [];
  let materialRecentFlips = 0;

  for (const p of PILOTS) {
    const groups = await loadGroups(db, p.complexKey);
    const fullTrades = dedupe(molitByApt.get(p.aptNameNorm) ?? []);
    const whTrades = dedupe(await loadWarehouse(db, p.aptNameNorm, p.lawdCd));

    const fullMg = markMarketGroupPriorExceed(fullTrades, groups);
    const fullEx = markExclusivePriorExceed(fullTrades);
    const whMg = markMarketGroupPriorExceed(whTrades, groups);
    const whEx = markExclusivePriorExceed(whTrades);

    const fullByKey = new Map(fullTrades.map((t) => [t.naturalKey, t]));

    const flipsWhTrueFullFalse: Flip[] = [];
    const bothTrue: Flip[] = [];
    let warehouseTrueMissingInFull = 0;

    for (const whTx of whTrades) {
      if (whMg.flags.get(whTx.id) !== true) continue;
      const fullTx = fullByKey.get(whTx.naturalKey);
      if (!fullTx) {
        warehouseTrueMissingInFull += 1;
        continue;
      }
      const g = matchGroup(whTx.exclusiveArea, groups);
      const fullSingoga = fullMg.flags.get(fullTx.id) === true;
      const flip: Flip = {
        dealDate: whTx.dealDate,
        dealAmount: whTx.dealAmount,
        exclusiveArea: whTx.exclusiveArea,
        groupKey: g?.groupKey ?? null,
        groupLabel: g?.label ?? null,
        warehousePrior: whMg.priorAt.get(whTx.id) ?? 0,
        fullPrior: fullMg.priorAt.get(fullTx.id) ?? 0,
        fullSingoga,
      };
      if (fullSingoga) bothTrue.push(flip);
      else flipsWhTrueFullFalse.push(flip);
    }

    const flips2020 = flipsWhTrueFullFalse.filter(
      (f) => f.dealDate >= "2020-01-01",
    );
    const bothTrue2020 = bothTrue.filter((f) => f.dealDate >= "2020-01-01");
    materialRecentFlips += flips2020.length;

    const groupReports = groups
      .filter((g) => g.groupConfidenceHigh)
      .map((g) => {
        const fullIn = fullTrades.filter(
          (t) => matchGroup(t.exclusiveArea, [g]) != null,
        );
        const whIn = whTrades.filter(
          (t) => matchGroup(t.exclusiveArea, [g]) != null,
        );
        const fullG = markMarketGroupPriorExceed(fullIn, [g]);
        const whG = markMarketGroupPriorExceed(whIn, [g]);

        let priorBeforeWh = 0;
        let priorBeforeWhDate: string | null = null;
        for (const t of fullIn) {
          if (t.dealDate >= "2016-10-01") break;
          if (t.dealAmount >= priorBeforeWh) {
            priorBeforeWh = t.dealAmount;
            priorBeforeWhDate = t.dealDate;
          }
        }

        const flipsG = flipsWhTrueFullFalse.filter(
          (f) => f.groupKey === g.groupKey,
        );
        const flipsG2020 = flips2020.filter((f) => f.groupKey === g.groupKey);

        return {
          groupKey: g.groupKey,
          label: g.label,
          exclusiveAreaMin: g.exclusiveAreaMin,
          exclusiveAreaMax: g.exclusiveAreaMax,
          fullTradeCount: fullIn.length,
          warehouseTradeCount: whIn.length,
          fullMarketGroupSingoga: countTrue(fullG.flags),
          warehouseMarketGroupSingoga: countTrue(whG.flags),
          firstTradeDate: fullG.groupFirstTradeDate.get(g.groupKey) ?? null,
          firstTradeAmount: fullG.groupFirstTradeAmount.get(g.groupKey) ?? null,
          firstSingogaDate: fullG.groupFirstSingogaDate.get(g.groupKey) ?? null,
          priorMaxBeforeWarehouse201610: priorBeforeWh,
          priorMaxBeforeWarehouseDate: priorBeforeWhDate,
          falseSingogaWarehouseOnly: flipsG.length,
          falseSingogaWarehouseOnly2020plus: flipsG2020.length,
          stillTrueBoth: bothTrue.filter((f) => f.groupKey === g.groupKey)
            .length,
          sampleFalseSingoga: flipsG.slice(0, 5).map((f) => ({
            dealDate: f.dealDate,
            amount: f.dealAmount,
            exclusiveArea: f.exclusiveArea,
            warehousePrior: f.warehousePrior,
            fullPrior: f.fullPrior,
          })),
        };
      });

    complexReports.push({
      complexKey: p.complexKey,
      displayName: p.displayName,
      aptNameNorm: p.aptNameNorm,
      lawdCd: p.lawdCd,
      startYm: p.startYm,
      fullHistory: {
        tradeCount: fullTrades.length,
        firstDealDate: fullTrades[0]?.dealDate ?? null,
        lastDealDate: fullTrades.at(-1)?.dealDate ?? null,
        marketGroupSingoga: countTrue(fullMg.flags),
        exclusivePriorExceedSingoga: countTrue(fullEx.flags),
      },
      warehouse2016plus: {
        tradeCount: whTrades.length,
        firstDealDate: whTrades[0]?.dealDate ?? null,
        lastDealDate: whTrades.at(-1)?.dealDate ?? null,
        marketGroupSingoga: countTrue(whMg.flags),
        exclusivePriorExceedSingoga: countTrue(whEx.flags),
      },
      comparison: {
        warehouseTrueFullFalse: flipsWhTrueFullFalse.length,
        warehouseTrueFullFalse2020plus: flips2020.length,
        bothTrue: bothTrue.length,
        bothTrue2020plus: bothTrue2020.length,
        warehouseTrueMissingInFullHistory: warehouseTrueMissingInFull,
        sampleWarehouseTrueFullFalse: flipsWhTrueFullFalse
          .slice(0, 10)
          .map((f) => ({
            dealDate: f.dealDate,
            amount: f.dealAmount,
            exclusiveArea: f.exclusiveArea,
            groupLabel: f.groupLabel,
            warehousePrior: f.warehousePrior,
            fullPrior: f.fullPrior,
          })),
        sampleWarehouseTrueFullFalse2020plus: flips2020.slice(0, 10).map((f) => ({
          dealDate: f.dealDate,
          amount: f.dealAmount,
          exclusiveArea: f.exclusiveArea,
          groupLabel: f.groupLabel,
          warehousePrior: f.warehousePrior,
          fullPrior: f.fullPrior,
        })),
      },
      groups: groupReports,
    });
  }

  const verdict = {
    recentSingogaMateriallyAffectedByHistoryGap: materialRecentFlips > 0,
    materialRecentFlipCount2020plus: materialRecentFlips,
    allowlistHoldLift: materialRecentFlips > 0 ? "HOLD" : "CONDITIONAL_HOLD",
    allowlistHoldLiftNote:
      materialRecentFlips > 0
        ? "2020+ warehouse 신고가 중 full-history에서 false로 뒤집힌 건이 있음 → A/B allowlist HOLD 유지. production historical backfill 필요."
        : "2020+ flip이 없더라도 early-window/전체 시계열 신뢰 부족으로 Phase5.1 HOLD 사유(history incompleteness)는 해소되지 않음. official backfill 권고.",
    productionHistoricalBackfillNeeded: true,
    productionHistoricalBackfillReason:
      "Warehouse starts 2016-10 for all four pilots. Full MOLIT history changes prior max and can reclassify 신고가. Backfill required before market-group 신고가 is historically authoritative.",
  };

  const out = {
    generatedAt: new Date().toISOString(),
    phase: "5.2b-fullhistory-singoga-readonly",
    safety: {
      productionWrite: false,
      syncExecuted: false,
      pilotMasterMutation: false,
      screenshots: 0,
    },
    method: {
      fetch: "fetchOneTradeForSync → resolveActiveTrades",
      groups: "apt_pyeong_groups (Phase5 pilot, read-only)",
      rules: [
        "market-group / exclusive prior-exceed",
        "first trade excluded",
        "ties false",
        "same calendar date shares prior-day max only",
      ],
    },
    fetch: {
      uniqueLawdMonthCells: cells.length,
      concurrency,
      fetchErrors,
      elapsedSec: Math.round((Date.now() - t0) / 1000),
    },
    complexes: complexReports,
    verdict,
  };

  const dir = join(process.cwd(), "data/poc/phase52b");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "fullhistory-singoga-readonly.json");
  writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`, "utf8");

  console.log(
    JSON.stringify(
      {
        wrote: path,
        fetch: out.fetch,
        verdict: out.verdict,
        summary: (complexReports as Array<Record<string, any>>).map((c) => ({
          apt: c.displayName,
          fullTrades: c.fullHistory.tradeCount,
          whTrades: c.warehouse2016plus.tradeCount,
          fullMg: c.fullHistory.marketGroupSingoga,
          whMg: c.warehouse2016plus.marketGroupSingoga,
          fullEx: c.fullHistory.exclusivePriorExceedSingoga,
          whEx: c.warehouse2016plus.exclusivePriorExceedSingoga,
          whTrueFullFalse: c.comparison.warehouseTrueFullFalse,
          whTrueFullFalse2020: c.comparison.warehouseTrueFullFalse2020plus,
          bothTrue: c.comparison.bothTrue,
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

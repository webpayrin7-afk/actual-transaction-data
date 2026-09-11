/**
 * Phase 5.2 — 신고가 history completeness dry-run (READ-ONLY).
 *
 * Reuses fetchOneTradeForSync (= resolveActiveTrades) and the same
 * natural-key / content diff as replaceMonthTransactions.
 * Never writes Turso.
 *
 *   npx tsx scripts/phase52-history-completeness-dryrun.ts
 *   npx tsx scripts/phase52-history-completeness-dryrun.ts --to-month=201609
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { normalizeAptName } from "../src/lib/db/repository";
import {
  isSameTransactionContent,
  snapshotFromTx,
  type TxContentSnapshot,
} from "../src/lib/db/sync-diff";
import { naturalKeyFromTx } from "../src/lib/market/identity";
import {
  fetchMonthMeta,
  fetchOneTradeForSync,
} from "../src/lib/molit/client";
import type { Transaction } from "../src/types/transaction";

type Pilot = {
  complexKey: string;
  displayName: string;
  aptNameNorm: string;
  lawdCd: string;
  gu: string;
  /** YYYYMM — official occupancy / trade-available month */
  occupancyYm: string;
  occupancyNote: string;
};

const PILOTS: Pilot[] = [
  {
    complexKey: "hangang-daewoo",
    displayName: "한강(대우)",
    aptNameNorm: "한강(대우)",
    lawdCd: "11170",
    gu: "용산구",
    occupancyYm: "200003",
    occupancyNote: "준공 2000-03 → floor 2006-01",
  },
  {
    complexKey: "parkrio",
    displayName: "파크리오",
    aptNameNorm: "파크리오",
    lawdCd: "11710",
    gu: "송파구",
    occupancyYm: "200808",
    occupancyNote: "사용승인 2008-08-29",
  },
  {
    complexKey: "banpo-xi",
    displayName: "반포자이",
    aptNameNorm: "반포자이",
    lawdCd: "11650",
    gu: "서초구",
    occupancyYm: "200903",
    occupancyNote: "사용승인 2009-03",
  },
  {
    complexKey: "jamsil-els",
    displayName: "잠실엘스",
    aptNameNorm: "잠실엘스",
    lawdCd: "11710",
    gu: "송파구",
    occupancyYm: "200809",
    occupancyNote: "사용승인 2008-09",
  },
];

const HISTORY_FLOOR_YM = "200601"; // max(2006-01, occupancy)

function argValue(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function ymAdd(ym: string, delta: number): string {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(4, 6));
  const idx = y * 12 + (m - 1) + delta;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  return `${ny}${String(nm).padStart(2, "0")}`;
}

function monthsBetween(fromYm: string, toYm: string): string[] {
  if (fromYm > toYm) return [];
  const out: string[] = [];
  let cur = fromYm;
  while (cur <= toYm) {
    out.push(cur);
    cur = ymAdd(cur, 1);
  }
  return out;
}

function maxYm(a: string, b: string): string {
  return a >= b ? a : b;
}

function minYm(a: string, b: string): string {
  return a <= b ? a : b;
}

function currentYmSeoul(): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
  });
  const parts = fmt.formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  return `${y}${m}`;
}

function requireDb(): Client {
  const url = process.env.TURSO_DATABASE_URL?.trim();
  const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
  if (!url || !authToken) throw new Error("TURSO_DATABASE_URL / TURSO_AUTH_TOKEN missing");
  return createClient({ url, authToken });
}

type WhRow = {
  id: string;
  yearMonth: string;
  dealDate: string;
  aptName: string;
  aptNameNorm: string;
  gu: string;
  dong: string;
  jibun: string;
  floor: number;
  exclusiveArea: number;
  dealAmount: number;
  monthlyRent: number;
  buildYear: number | null;
  dealingGbn: string;
  naturalKey: string;
  content: TxContentSnapshot;
};

async function loadWarehouseApt(
  db: Client,
  aptNameNorm: string,
  lawdCd: string,
  fromYm: string,
  toYm: string,
): Promise<WhRow[]> {
  const result = await db.execute({
    sql: `SELECT id, year_month, deal_date, apt_name, apt_name_norm, gu, dong, jibun,
                 floor, exclusive_area, deal_amount, monthly_rent, build_year, dealing_gbn
          FROM transactions
          WHERE deal_type = 'trade'
            AND apt_name_norm = ?
            AND lawd_cd = ?
            AND year_month >= ?
            AND year_month <= ?`,
    args: [aptNameNorm, lawdCd, fromYm, toYm],
  });
  return result.rows.map((row) => {
    const content: TxContentSnapshot = {
      dealDate: String(row.deal_date).slice(0, 10),
      aptName: String(row.apt_name),
      gu: String(row.gu ?? ""),
      dong: String(row.dong ?? ""),
      exclusiveArea: Number(row.exclusive_area) || 0,
      dealAmount: Number(row.deal_amount) || 0,
      monthlyRent: Number(row.monthly_rent) || 0,
      floor: Number(row.floor) || 0,
      buildYear:
        row.build_year == null || row.build_year === ""
          ? null
          : Number(row.build_year),
      jibun: String(row.jibun ?? ""),
      dealingGbn: String(row.dealing_gbn ?? ""),
    };
    const txLike = {
      id: String(row.id),
      dealType: "trade" as const,
      dealDate: content.dealDate,
      aptName: content.aptName,
      gu: content.gu,
      dong: content.dong,
      exclusiveArea: content.exclusiveArea,
      dealAmount: content.dealAmount,
      monthlyRent: content.monthlyRent,
      floor: content.floor,
      buildYear: content.buildYear,
      jibun: content.jibun,
      dealingGbn: content.dealingGbn,
      lawdCd,
    };
    return {
      id: String(row.id),
      yearMonth: String(row.year_month),
      dealDate: content.dealDate,
      aptName: content.aptName,
      aptNameNorm: String(row.apt_name_norm),
      gu: content.gu,
      dong: content.dong,
      jibun: content.jibun,
      floor: content.floor,
      exclusiveArea: content.exclusiveArea,
      dealAmount: content.dealAmount,
      monthlyRent: content.monthlyRent,
      buildYear: content.buildYear,
      dealingGbn: content.dealingGbn,
      naturalKey: naturalKeyFromTx(txLike, lawdCd),
      content,
    };
  });
}

function matchesPilot(tx: Transaction, aptNameNorm: string): boolean {
  return normalizeAptName(tx.aptName) === aptNameNorm;
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await worker(items[i]!, i);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(items.length, 1)) }, () =>
      run(),
    ),
  );
  return out;
}

async function main() {
  if (!process.env.MOLIT_API_KEY?.trim()) {
    throw new Error("MOLIT_API_KEY missing");
  }
  const db = requireDb();
  const toMonthArg = argValue("to-month", "");
  const concurrency = Number(argValue("concurrency", "4")) || 4;
  const nowYm = currentYmSeoul();
  const toYmGlobal = toMonthArg || nowYm;

  const pilotPlans = PILOTS.map((p) => {
    const requiredStartYm = maxYm(HISTORY_FLOOR_YM, p.occupancyYm);
    return { ...p, requiredStartYm };
  });

  // Warehouse baseline (full history, not only window)
  const baselines = [];
  for (const p of pilotPlans) {
    const all = await db.execute({
      sql: `SELECT COUNT(*) AS c, MIN(year_month) AS minym, MAX(year_month) AS maxym,
                   MIN(deal_date) AS mind, MAX(deal_date) AS maxd
            FROM transactions
            WHERE deal_type='trade' AND apt_name_norm=? AND lawd_cd=?`,
      args: [p.aptNameNorm, p.lawdCd],
    });
    const row = all.rows[0]!;
    baselines.push({
      complexKey: p.complexKey,
      warehouseCount: Number(row.c) || 0,
      warehouseFirstYm: row.minym == null ? null : String(row.minym),
      warehouseLastYm: row.maxym == null ? null : String(row.maxym),
      warehouseFirstDealDate: row.mind == null ? null : String(row.mind),
      warehouseLastDealDate: row.maxd == null ? null : String(row.maxd),
    });
  }

  // Unique lawd×ym cells to fetch (shared 11710 for parkrio+jamsil)
  type Cell = { lawdCd: string; yearMonth: string };
  const cellMap = new Map<string, Cell>();
  for (const p of pilotPlans) {
    const base = baselines.find((b) => b.complexKey === p.complexKey)!;
    // Fetch from required start through toYm (full completeness window).
    // Do not stop at warehouse first month — also verify post-2016 gaps.
    const fromYm = p.requiredStartYm;
    const toYm = toYmGlobal;
    for (const ym of monthsBetween(fromYm, toYm)) {
      cellMap.set(`${p.lawdCd}|${ym}`, { lawdCd: p.lawdCd, yearMonth: ym });
    }
    void base;
  }
  const cells = [...cellMap.values()].sort((a, b) =>
    a.lawdCd === b.lawdCd
      ? a.yearMonth.localeCompare(b.yearMonth)
      : a.lawdCd.localeCompare(b.lawdCd),
  );

  console.log(
    `[phase52-dryrun] pilots=${pilotPlans.length} uniqueCells=${cells.length} concurrency=${concurrency} toYm=${toYmGlobal} WRITE=0`,
  );

  // Pre-estimate pages via meta (1 HTTP/cell) — optional; skip if --skip-meta=1
  const skipMeta = argValue("skip-meta", "0") === "1";
  let estimatedPages = 0;
  let metaHttp = 0;
  if (!skipMeta) {
    console.log(`[phase52-dryrun] estimating pages via fetchMonthMeta…`);
    await mapPool(cells, concurrency, async (cell) => {
      try {
        const meta = await fetchMonthMeta("trade", cell.lawdCd, cell.yearMonth);
        metaHttp += 1;
        estimatedPages += meta.empty ? 0 : meta.pagesNeeded;
      } catch {
        metaHttp += 1;
        estimatedPages += 1;
      }
      return null;
    });
    console.log(
      `[phase52-dryrun] metaHttp=${metaHttp} estimatedFullFetchPages=${estimatedPages}`,
    );
  }

  // Full fetch + apt filter
  type CellResult = {
    lawdCd: string;
    yearMonth: string;
    sourceActiveAll: number;
    byApt: Record<string, Transaction[]>;
    error?: string;
  };

  const aptByLawd = new Map<string, Pilot[]>();
  for (const p of pilotPlans) {
    const list = aptByLawd.get(p.lawdCd) ?? [];
    list.push(p);
    aptByLawd.set(p.lawdCd, list);
  }

  let done = 0;
  let fetchErrors = 0;
  const cellResults: CellResult[] = [];
  const t0 = Date.now();

  await mapPool(cells, concurrency, async (cell) => {
    const pilotsHere = aptByLawd.get(cell.lawdCd) ?? [];
    try {
      const active = await fetchOneTradeForSync(cell.lawdCd, cell.yearMonth);
      const byApt: Record<string, Transaction[]> = {};
      for (const p of pilotsHere) byApt[p.aptNameNorm] = [];
      for (const tx of active) {
        for (const p of pilotsHere) {
          if (matchesPilot(tx, p.aptNameNorm)) {
            byApt[p.aptNameNorm]!.push(tx);
          }
        }
      }
      cellResults.push({
        lawdCd: cell.lawdCd,
        yearMonth: cell.yearMonth,
        sourceActiveAll: active.length,
        byApt,
      });
    } catch (err) {
      fetchErrors += 1;
      cellResults.push({
        lawdCd: cell.lawdCd,
        yearMonth: cell.yearMonth,
        sourceActiveAll: 0,
        byApt: Object.fromEntries(pilotsHere.map((p) => [p.aptNameNorm, []])),
        error: err instanceof Error ? err.message : String(err),
      });
    }
    done += 1;
    if (done % 25 === 0 || done === cells.length) {
      const elapsed = ((Date.now() - t0) / 1000 / 60).toFixed(1);
      console.log(
        `[phase52-dryrun] fetch ${done}/${cells.length} errors=${fetchErrors} elapsed=${elapsed}m`,
      );
    }
    return null;
  });

  // Diff per pilot (apt-scoped) using same natural key + content compare as repository
  const complexReports = [];
  for (const p of pilotPlans) {
    const base = baselines.find((b) => b.complexKey === p.complexKey)!;
    const windowFrom = p.requiredStartYm;
    const windowTo = toYmGlobal;
    const wh = await loadWarehouseApt(
      db,
      p.aptNameNorm,
      p.lawdCd,
      windowFrom,
      windowTo,
    );
    const whByKey = new Map<string, WhRow>();
    for (const row of wh) {
      if (!whByKey.has(row.naturalKey)) whByKey.set(row.naturalKey, row);
    }

    const sourceTxs: Transaction[] = [];
    const sourceMonths = new Set<string>();
    for (const cr of cellResults) {
      if (cr.lawdCd !== p.lawdCd) continue;
      if (cr.yearMonth < windowFrom || cr.yearMonth > windowTo) continue;
      const list = cr.byApt[p.aptNameNorm] ?? [];
      if (list.length) sourceMonths.add(cr.yearMonth);
      sourceTxs.push(...list);
    }

    const sourceByKey = new Map<string, Transaction>();
    for (const tx of sourceTxs) {
      const k = naturalKeyFromTx(tx, p.lawdCd);
      if (!sourceByKey.has(k)) sourceByKey.set(k, tx);
    }

    let insert = 0;
    let update = 0;
    let unchanged = 0;
    let deleteCount = 0;
    const insertSamples: unknown[] = [];
    const updateSamples: unknown[] = [];
    const deleteSamples: unknown[] = [];

    for (const [k, tx] of sourceByKey) {
      const existing = whByKey.get(k);
      if (!existing) {
        insert += 1;
        if (insertSamples.length < 8) {
          insertSamples.push({
            dealDate: tx.dealDate,
            amount: tx.dealAmount,
            exclusiveArea: tx.exclusiveArea,
            floor: tx.floor,
            yearMonth: tx.dealDate.slice(0, 7).replace("-", ""),
          });
        }
        continue;
      }
      const same = isSameTransactionContent(existing.content, snapshotFromTx(tx));
      if (same) unchanged += 1;
      else {
        update += 1;
        if (updateSamples.length < 5) {
          updateSamples.push({
            dealDate: tx.dealDate,
            amount: tx.dealAmount,
            exclusiveArea: tx.exclusiveArea,
          });
        }
      }
    }
    for (const [k, row] of whByKey) {
      if (!sourceByKey.has(k)) {
        deleteCount += 1;
        if (deleteSamples.length < 5) {
          deleteSamples.push({
            dealDate: row.dealDate,
            amount: row.dealAmount,
            exclusiveArea: row.exclusiveArea,
            yearMonth: row.yearMonth,
          });
        }
      }
    }

    // Gap vs covered split
    const whFirst = base.warehouseFirstYm;
    const gapToYm = whFirst ? ymAdd(whFirst, -1) : windowTo;
    const gapMonths = monthsBetween(windowFrom, minYm(gapToYm, windowTo));
    let sourceInGap = 0;
    let sourceAfterGap = 0;
    for (const tx of sourceByKey.values()) {
      const ym = tx.dealDate.slice(0, 7).replace("-", "");
      if (ym <= gapToYm) sourceInGap += 1;
      else sourceAfterGap += 1;
    }

    complexReports.push({
      complexKey: p.complexKey,
      displayName: p.displayName,
      aptNameNorm: p.aptNameNorm,
      lawdCd: p.lawdCd,
      gu: p.gu,
      occupancyYm: p.occupancyYm,
      occupancyNote: p.occupancyNote,
      requiredStartYm: p.requiredStartYm,
      windowFrom,
      windowTo,
      warehouse: base,
      monthsRequired: monthsBetween(windowFrom, windowTo).length,
      monthsWithSourceHits: sourceMonths.size,
      sourceActiveCount: sourceByKey.size,
      warehouseExistingInWindow: whByKey.size,
      expected: {
        insert,
        update,
        unchanged,
        delete: deleteCount,
      },
      gapAnalysis: {
        warehouseFirstYm: whFirst,
        preWarehouseMonths: gapMonths.length,
        sourceActiveBeforeWarehouseFirst: sourceInGap,
        sourceActiveFromWarehouseFirstOnward: sourceAfterGap,
      },
      samples: {
        insert: insertSamples,
        update: updateSamples,
        delete: deleteSamples,
      },
    });
  }

  // Full-cell write side-effect note: unique cells that would be synced
  const writeCells = cells.map((c) => `${c.lawdCd}|${c.yearMonth}`);
  const lawdMonthCounts = {
    "11170": cells.filter((c) => c.lawdCd === "11170").length,
    "11650": cells.filter((c) => c.lawdCd === "11650").length,
    "11710": cells.filter((c) => c.lawdCd === "11710").length,
  };

  const out = {
    generatedAt: new Date().toISOString(),
    phase: "5.2-history-completeness-dryrun",
    safety: {
      productionWrite: false,
      pilotMasterMutation: false,
      screenshots: 0,
      writeRequiresSeparateApproval: true,
    },
    policy: {
      historyStart: "max(2006-01, occupancy/trade-available)",
      historyFloorYm: HISTORY_FLOOR_YM,
      pre2006ExternalSupplement: "forbidden",
      reuse: [
        "fetchOneTradeForSync → resolveActiveTrades",
        "naturalKeyFromTx + isSameTransactionContent (replaceMonthTransactions semantics)",
      ],
      writePathIfApproved:
        "scripts/sync-molit.ts --codes=11170,11650,11710 --from-month=… --to-month=… --rent-months=0 --discovery=0 --skip-existing=0 --only-changed=0 (full lawd-month atomic replace; not apt-only)",
      pilotScopeOnly: true,
      noteFullCellSideEffect:
        "Existing monthly replace is lawd-scoped. Approving write for these lawd×months will also upsert other apts in 용산/서초/송파 for those months. No other lawds. No C/D pilots.",
    },
    fetch: {
      uniqueLawdMonthCells: cells.length,
      concurrency,
      fetchErrors,
      metaHttpCalls: skipMeta ? null : metaHttp,
      estimatedFullFetchPages: skipMeta ? null : estimatedPages,
      // Full fetch HTTP ≈ sum of pages; lower bound = unique cells
      apiCallEstimate: {
        lowerBoundCells: cells.length,
        withMetaProbe: skipMeta ? cells.length : metaHttp + estimatedPages,
        note: "Actual fetchOneTradeForSync issues pagesNeeded HTTP GETs per cell (resolveActiveTrades applied in-process).",
      },
      lawdMonthCounts,
      elapsedSec: Math.round((Date.now() - t0) / 1000),
    },
    complexes: complexReports,
    totals: {
      sourceActive: complexReports.reduce((s, c) => s + c.sourceActiveCount, 0),
      warehouseInWindow: complexReports.reduce(
        (s, c) => s + c.warehouseExistingInWindow,
        0,
      ),
      expectedInsert: complexReports.reduce((s, c) => s + c.expected.insert, 0),
      expectedUpdate: complexReports.reduce((s, c) => s + c.expected.update, 0),
      expectedDelete: complexReports.reduce((s, c) => s + c.expected.delete, 0),
      expectedUnchanged: complexReports.reduce(
        (s, c) => s + c.expected.unchanged,
        0,
      ),
      sourceActiveBeforeWarehouseFirst: complexReports.reduce(
        (s, c) => s + c.gapAnalysis.sourceActiveBeforeWarehouseFirst,
        0,
      ),
    },
    nextGate: {
      actualWrite: "BLOCKED — awaiting separate approval after this dry-run",
      afterWriteRevalidate: [
        "history first deal date per complex",
        "market-group prior-exceed 신고가 recount",
        "exclusive prior-exceed compare",
        "early-window false 신고가 cleared?",
        "A/B allowlist HOLD lift decision",
      ],
    },
  };

  const dir = join(process.cwd(), "data/poc/phase52");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "history-completeness-dryrun.json");
  writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`, "utf8");

  console.log(
    JSON.stringify(
      {
        wrote: path,
        totals: out.totals,
        fetch: out.fetch,
        perComplex: complexReports.map((c) => ({
          apt: c.displayName,
          requiredStartYm: c.requiredStartYm,
          warehouseFirstYm: c.warehouse.warehouseFirstYm,
          monthsRequired: c.monthsRequired,
          sourceActive: c.sourceActiveCount,
          warehouseInWindow: c.warehouseExistingInWindow,
          insert: c.expected.insert,
          update: c.expected.update,
          delete: c.expected.delete,
          unchanged: c.expected.unchanged,
          preWhSource: c.gapAnalysis.sourceActiveBeforeWarehouseFirst,
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

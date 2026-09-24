/**
 * READ-ONLY: sync_months 기준 매매(trade) 월 공백을 찾아 CSV로 저장.
 *
 * 정의: 해당 lawd에 trade sync_months가 있으면 min~max 사이 연속 달 중
 *       기록이 없는 (lawd_cd, year_month). 전월세(rent)만 있고 매매가 없는
 *       달도 포함(같은 lawd의 rent 달 범위에 trade가 비어 있는 경우).
 *
 *   npx tsx scripts/export-trade-sync-gaps.ts
 *   npx tsx scripts/export-trade-sync-gaps.ts --out=data/sync-gaps/trade-gaps.csv
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  districtNameFromCode,
  LAWD_TO_REGION,
} from "../src/lib/constants/regions-registry";
import { getDb } from "../src/lib/db/client";

function argValue(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function ymAdd(ym: string, delta: number): string {
  let y = Number(ym.slice(0, 4));
  let m = Number(ym.slice(4, 6)) + delta;
  while (m > 12) {
    m -= 12;
    y += 1;
  }
  while (m < 1) {
    m += 12;
    y -= 1;
  }
  return `${y}${String(m).padStart(2, "0")}`;
}

function monthsBetween(fromYm: string, toYm: string): string[] {
  const out: string[] = [];
  let cur = fromYm;
  while (cur <= toYm) {
    out.push(cur);
    cur = ymAdd(cur, 1);
    if (out.length > 600) break;
  }
  return out;
}

async function main() {
  const outPath = resolve(argValue("out", "data/sync-gaps/trade-gaps.csv"));
  const db = getDb();
  if (!db) throw new Error("no db");

  const trade = await db.execute(`
    SELECT lawd_cd, year_month, row_count
    FROM sync_months
    WHERE deal_kind = 'trade'
    ORDER BY lawd_cd, year_month
  `);
  const rent = await db.execute(`
    SELECT lawd_cd, year_month
    FROM sync_months
    WHERE deal_kind = 'rent'
    ORDER BY lawd_cd, year_month
  `);

  const tradeByLawd = new Map<string, Map<string, number>>();
  for (const row of trade.rows) {
    const lawd = String(row.lawd_cd);
    const ym = String(row.year_month);
    const map = tradeByLawd.get(lawd) ?? new Map<string, number>();
    map.set(ym, Number(row.row_count) || 0);
    tradeByLawd.set(lawd, map);
  }
  const rentByLawd = new Map<string, Set<string>>();
  for (const row of rent.rows) {
    const lawd = String(row.lawd_cd);
    const ym = String(row.year_month);
    const set = rentByLawd.get(lawd) ?? new Set<string>();
    set.add(ym);
    rentByLawd.set(lawd, set);
  }

  type Gap = {
    lawd_cd: string;
    name: string;
    metro: string;
    year_month: string;
    has_rent: number;
    tx_trade_count: number;
  };
  const gaps: Gap[] = [];

  // Candidate lawds: any with trade or rent sync history
  const lawds = new Set([...tradeByLawd.keys(), ...rentByLawd.keys()]);
  for (const lawd of [...lawds].sort()) {
    const tradeMap = tradeByLawd.get(lawd) ?? new Map<string, number>();
    const rentSet = rentByLawd.get(lawd) ?? new Set<string>();
    const tradeYms = [...tradeMap.keys()].sort();
    const rentYms = [...rentSet].sort();
    if (tradeYms.length === 0 && rentYms.length === 0) continue;

    // Span: union of trade min/max and rent min/max when trade exists,
    // else rent-only lawds with no trade at all in a contiguous rent span.
    let fromYm: string;
    let toYm: string;
    if (tradeYms.length > 0) {
      fromYm = tradeYms[0]!;
      toYm = tradeYms[tradeYms.length - 1]!;
      // Extend span with rent months that fall inside neighboring holes
      // (e.g. trade stops early but rent continues — those months are gaps too
      // if they sit between earlier trade and later trade, already covered;
      // if rent continues past last trade, do NOT extend — that would invent
      // open-ended future months. Only fill interior holes.)
    } else {
      // No trade sync at all — skip (different class: missing lawd, not month gap)
      continue;
    }

    const expected = monthsBetween(fromYm, toYm);
    for (const ym of expected) {
      if (tradeMap.has(ym)) continue;
      gaps.push({
        lawd_cd: lawd,
        name: districtNameFromCode(lawd) || "",
        metro: LAWD_TO_REGION[lawd]?.metro ?? "",
        year_month: ym,
        has_rent: rentSet.has(ym) ? 1 : 0,
        tx_trade_count: -1, // filled below
      });
    }
  }

  // Annotate with actual transaction counts (confirm warehouse also empty)
  const txCounts = await db.execute(`
    SELECT lawd_cd, year_month, COUNT(*) AS n
    FROM transactions
    WHERE deal_type = 'trade'
    GROUP BY lawd_cd, year_month
  `);
  const txMap = new Map<string, number>();
  for (const row of txCounts.rows) {
    txMap.set(`${row.lawd_cd}|${row.year_month}`, Number(row.n) || 0);
  }
  for (const g of gaps) {
    g.tx_trade_count = txMap.get(`${g.lawd_cd}|${g.year_month}`) ?? 0;
  }

  mkdirSync(dirname(outPath), { recursive: true });
  const header = "lawd_cd,name,metro,year_month,has_rent,tx_trade_count";
  const lines = gaps.map(
    (g) =>
      `${g.lawd_cd},${JSON.stringify(g.name)},${g.metro},${g.year_month},${g.has_rent},${g.tx_trade_count}`,
  );
  writeFileSync(outPath, `${header}\n${lines.join("\n")}\n`, "utf8");

  const byLawd = new Map<string, number>();
  const byMetro = new Map<string, number>();
  for (const g of gaps) {
    byLawd.set(g.lawd_cd, (byLawd.get(g.lawd_cd) ?? 0) + 1);
    byMetro.set(g.metro || "?", (byMetro.get(g.metro || "?") ?? 0) + 1);
  }
  const lawdSummary = [...byLawd.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([lawd, n]) => ({
      lawd_cd: lawd,
      name: districtNameFromCode(lawd),
      metro: LAWD_TO_REGION[lawd]?.metro ?? "",
      gap_months: n,
      ym_min: gaps.filter((g) => g.lawd_cd === lawd).map((g) => g.year_month).sort()[0],
      ym_max: gaps
        .filter((g) => g.lawd_cd === lawd)
        .map((g) => g.year_month)
        .sort()
        .at(-1),
      nonzero_tx: gaps.filter((g) => g.lawd_cd === lawd && g.tx_trade_count > 0).length,
    }));

  console.log(
    JSON.stringify(
      {
        out: outPath,
        lawd_count: byLawd.size,
        gap_months_total: gaps.length,
        by_metro: Object.fromEntries([...byMetro.entries()].sort()),
        nonzero_tx_cells: gaps.filter((g) => g.tx_trade_count > 0).length,
        lawd_summary: lawdSummary,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

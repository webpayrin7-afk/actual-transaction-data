/**
 * Post-backfill verification for trade sync gaps.
 * READ-ONLY against Turso (+ optional re-export of remaining gaps).
 *
 *   npx tsx scripts/verify-trade-gap-fill.ts
 *   npx tsx scripts/verify-trade-gap-fill.ts --gaps-file=data/sync-gaps/trade-gaps.csv
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  districtNameFromCode,
  LAWD_TO_REGION,
} from "../src/lib/constants/regions-registry";
import { getDb } from "../src/lib/db/client";

function argValue(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function parseGaps(path: string): Array<{ lawd_cd: string; year_month: string }> {
  const text = readFileSync(resolve(path), "utf8");
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const header = lines[0]!.split(",");
  const li = header.indexOf("lawd_cd");
  const yi = header.indexOf("year_month");
  const out: Array<{ lawd_cd: string; year_month: string }> = [];
  for (const line of lines.slice(1)) {
    const cols: string[] = [];
    let cur = "";
    let q = false;
    for (const ch of line) {
      if (ch === '"') {
        q = !q;
        continue;
      }
      if (ch === "," && !q) {
        cols.push(cur);
        cur = "";
        continue;
      }
      cur += ch;
    }
    cols.push(cur);
    out.push({ lawd_cd: cols[li]!.trim(), year_month: cols[yi]!.trim() });
  }
  return out;
}

async function main() {
  const gapsFile = argValue("gaps-file", "data/sync-gaps/trade-gaps.csv");
  const gaps = parseGaps(gapsFile);
  const db = getDb()!;

  const disc = await db.execute(
    `SELECT COUNT(*) AS n FROM transactions WHERE discovery_at IS NOT NULL AND discovery_at != ''`,
  );

  let filled = 0;
  let missingSync = 0;
  let zeroRow = 0;
  let withTx = 0;
  let totalTx = 0;
  const byLawd = new Map<
    string,
    { filled: number; missing: number; zero: number; tx: number }
  >();

  // batch: load all relevant sync_months + tx counts
  const lawds = [...new Set(gaps.map((g) => g.lawd_cd))];
  const sync = await db.execute({
    sql: `SELECT lawd_cd, year_month, row_count FROM sync_months
          WHERE deal_kind='trade' AND lawd_cd IN (${lawds.map(() => "?").join(",")})`,
    args: lawds,
  });
  const syncMap = new Map<string, number>();
  for (const r of sync.rows) {
    syncMap.set(`${r.lawd_cd}|${r.year_month}`, Number(r.row_count) || 0);
  }
  const tx = await db.execute({
    sql: `SELECT lawd_cd, year_month, COUNT(*) AS n FROM transactions
          WHERE deal_type='trade' AND lawd_cd IN (${lawds.map(() => "?").join(",")})
          GROUP BY lawd_cd, year_month`,
    args: lawds,
  });
  const txMap = new Map<string, number>();
  for (const r of tx.rows) {
    txMap.set(`${r.lawd_cd}|${r.year_month}`, Number(r.n) || 0);
  }

  const stillMissing: Array<{ lawd_cd: string; year_month: string; reason: string }> =
    [];

  for (const g of gaps) {
    const key = `${g.lawd_cd}|${g.year_month}`;
    const row = byLawd.get(g.lawd_cd) ?? {
      filled: 0,
      missing: 0,
      zero: 0,
      tx: 0,
    };
    if (!syncMap.has(key)) {
      missingSync += 1;
      row.missing += 1;
      stillMissing.push({ ...g, reason: "no_sync_months" });
    } else {
      filled += 1;
      row.filled += 1;
      const rc = syncMap.get(key)!;
      const n = txMap.get(key) ?? 0;
      totalTx += n;
      row.tx += n;
      if (rc === 0 && n === 0) {
        zeroRow += 1;
        row.zero += 1;
        stillMissing.push({ ...g, reason: "molit_empty_marked" });
      } else {
        withTx += 1;
      }
    }
    byLawd.set(g.lawd_cd, row);
  }

  // Region-level coverage: how many months nationally/capital/gyeonggi gained
  // Completeness: count distinct year_months where ALL capital/nationwide trade
  // sync exists — approximate via TREND scopes if available, else simple counts.
  const ymTradeAll = await db.execute(`
    SELECT year_month, COUNT(DISTINCT lawd_cd) AS lawds
    FROM sync_months WHERE deal_kind='trade'
    GROUP BY year_month ORDER BY year_month
  `);

  console.log(
    JSON.stringify(
      {
        gaps_file_rows: gaps.length,
        discovery_nn: Number(disc.rows[0]?.n),
        filled_sync_cells: filled,
        missing_sync_cells: missingSync,
        cells_with_tx: withTx,
        cells_molit_empty: zeroRow,
        total_tx_in_gap_cells: totalTx,
        still_open: stillMissing.filter((s) => s.reason === "no_sync_months"),
        molit_empty_sample: stillMissing
          .filter((s) => s.reason === "molit_empty_marked")
          .slice(0, 20),
        by_lawd: [...byLawd.entries()]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([lawd, s]) => ({
            lawd_cd: lawd,
            name: districtNameFromCode(lawd),
            metro: LAWD_TO_REGION[lawd]?.metro,
            ...s,
          })),
        sync_months_ym_sample: ymTradeAll.rows.slice(-5),
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

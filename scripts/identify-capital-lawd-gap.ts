/**
 * READ-only: capital 67 vs warehouse lawds, plus pagination-risk cell inventory.
 * No MOLIT unless --probe-missing=1. WRITE 0.
 *
 *   npx tsx scripts/identify-capital-lawd-gap.ts
 *   npx tsx scripts/identify-capital-lawd-gap.ts --probe-missing=1
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import {
  allCapitalLawdCodes,
  LAWD_TO_REGION,
  districtNameFromCode,
} from "../src/lib/constants/regions-registry";
import { getDb } from "../src/lib/db/client";
import { TRUSTED_DISCOVERY_COPY } from "../src/lib/db/discovery-axis";
import {
  fetchTradeMonthProbe,
  fetchOneRentForSync,
} from "../src/lib/molit/client";

function argValue(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

async function main() {
  const probeMissing = argValue("probe-missing", "0") === "1";
  const db = getDb();
  if (!db) throw new Error("no db");

  const capital = allCapitalLawdCodes();
  const capitalSet = new Set(capital);

  const lawdRows = await db.execute(`
    SELECT lawd_cd,
           SUM(CASE WHEN deal_type='trade' THEN 1 ELSE 0 END) AS trade_n,
           SUM(CASE WHEN deal_type='rent' THEN 1 ELSE 0 END) AS rent_n,
           MIN(deal_date) AS min_d,
           MAX(deal_date) AS max_d
    FROM transactions
    GROUP BY lawd_cd
  `);
  const warehouse = new Map<
    string,
    { trade: number; rent: number; minD: string; maxD: string }
  >();
  for (const row of lawdRows.rows) {
    warehouse.set(String(row.lawd_cd), {
      trade: Number(row.trade_n) || 0,
      rent: Number(row.rent_n) || 0,
      minD: String(row.min_d ?? ""),
      maxD: String(row.max_d ?? ""),
    });
  }

  const warehouseCapital = [...warehouse.keys()].filter((c) =>
    capitalSet.has(c),
  );
  const missing = capital.filter((c) => !warehouse.has(c));
  const extra = [...warehouse.keys()].filter((c) => !capitalSet.has(c));

  const syncMissing: Array<Record<string, unknown>> = [];
  for (const code of missing) {
    const sync = await db.execute({
      sql: `SELECT deal_kind, COUNT(*) AS n, MIN(year_month) AS min_ym,
                   MAX(year_month) AS max_ym, SUM(row_count) AS rows
            FROM sync_months WHERE lawd_cd = ? GROUP BY deal_kind`,
      args: [code],
    });
    syncMissing.push({
      code,
      name: districtNameFromCode(code) || LAWD_TO_REGION[code]?.name,
      region: LAWD_TO_REGION[code]?.fullName ?? null,
      slug: LAWD_TO_REGION[code]?.slug ?? null,
      warehouse: warehouse.get(code) ?? { trade: 0, rent: 0 },
      sync_months: sync.rows,
    });
  }

  const discovery = await db.execute(`
    SELECT
      COUNT(*) AS n_all,
      SUM(CASE WHEN discovery_at IS NOT NULL AND discovery_at != '' THEN 1 ELSE 0 END) AS nn,
      SUM(CASE WHEN discovery_at >= '${TRUSTED_DISCOVERY_COPY.fromInclusive}'
                AND discovery_at <  '${TRUSTED_DISCOVERY_COPY.toExclusive}' THEN 1 ELSE 0 END) AS trusted
    FROM transactions
  `);

  const rentRisk = await db.execute(`
    SELECT lawd_cd, year_month, COUNT(*) AS n
    FROM transactions
    WHERE deal_type = 'rent' AND year_month >= '202210' AND year_month <= '202609'
    GROUP BY lawd_cd, year_month
    HAVING n >= 850
    ORDER BY n DESC, lawd_cd, year_month
  `);
  const tradeRisk = await db.execute(`
    SELECT lawd_cd, year_month, COUNT(*) AS n
    FROM transactions
    WHERE deal_type = 'trade' AND year_month >= '201610' AND year_month <= '202609'
    GROUP BY lawd_cd, year_month
    HAVING n >= 850
    ORDER BY n DESC, lawd_cd, year_month
  `);

  const rentCells = await db.execute(`
    SELECT COUNT(*) AS n, SUM(cnt) AS rows FROM (
      SELECT lawd_cd, year_month, COUNT(*) AS cnt
      FROM transactions
      WHERE deal_type='rent' AND year_month >= '202210' AND year_month <= '202609'
      GROUP BY lawd_cd, year_month
    )
  `);
  const tradeCells = await db.execute(`
    SELECT COUNT(*) AS n, SUM(cnt) AS rows FROM (
      SELECT lawd_cd, year_month, COUNT(*) AS cnt
      FROM transactions
      WHERE deal_type='trade' AND year_month >= '201610' AND year_month <= '202609'
      GROUP BY lawd_cd, year_month
    )
  `);

  const probes: unknown[] = [];
  if (probeMissing && missing.length > 0) {
    const sampleYms = ["202609", "202508", "202409", "202309", "202003", "201610"];
    for (const code of missing) {
      for (const ym of sampleYms) {
        try {
          const trade = await fetchTradeMonthProbe(code, ym);
          let rentCount: number | null = null;
          if (ym >= "202210") {
            const rent = await fetchOneRentForSync(code, ym);
            rentCount = rent.length;
          }
          probes.push({
            code,
            ym,
            tradeTotalCount: trade.count,
            tradeMaxDealDate: trade.maxDealDate,
            rentResolved: rentCount,
          });
        } catch (err) {
          probes.push({
            code,
            ym,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  console.log(
    JSON.stringify(
      {
        capital_target: capital.length,
        warehouse_distinct: warehouse.size,
        warehouse_capital: warehouseCapital.length,
        missing_lawds: missing.map((c) => ({
          code: c,
          name: districtNameFromCode(c) || LAWD_TO_REGION[c]?.name,
          region: LAWD_TO_REGION[c]?.fullName,
          slug: LAWD_TO_REGION[c]?.slug,
        })),
        extra_non_capital_sample: extra.slice(0, 20),
        extra_non_capital_n: extra.length,
        missing_detail: syncMissing,
        discovery: discovery.rows[0],
        rent_cells_202210_202609: rentCells.rows[0],
        trade_cells_201610_202609: tradeCells.rows[0],
        rent_risk_ge_850: rentRisk.rows.map((r) => ({
          lawd: String(r.lawd_cd),
          name: districtNameFromCode(String(r.lawd_cd)),
          ym: String(r.year_month),
          warehouse: Number(r.n),
        })),
        trade_risk_ge_850: tradeRisk.rows.map((r) => ({
          lawd: String(r.lawd_cd),
          name: districtNameFromCode(String(r.lawd_cd)),
          ym: String(r.year_month),
          warehouse: Number(r.n),
        })),
        probes,
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

/**
 * READ-ONLY MOLIT source vs warehouse identity diff.
 * Management script only. No DB WRITE. Not on the product request path.
 *
 *   npx tsx scripts/audit-molit-source-gap-r2.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { getDb } from "../src/lib/db/client";
import { fetchOneRentForSync, fetchOneTradeForSync } from "../src/lib/molit/client";
import { dailyRentMonths, dailyTradeMonths } from "../src/lib/molit/sync-policy";
import { naturalKeyFromTx } from "../src/lib/market/identity";
import type { DealType } from "../src/types/transaction";

const LAWDS: { code: string; name: string }[] = [
  { code: "11680", name: "강남구" },
  { code: "11710", name: "송파구" },
  { code: "11170", name: "용산구" },
  { code: "41131", name: "성남수정" },
  { code: "41135", name: "성남분당" },
  { code: "41115", name: "수원팔달" },
  { code: "41117", name: "수원영통" },
];

function keySet(
  items: Array<{ dealDate: string; aptName: string; dong: string; jibun: string; floor: number; exclusiveArea: number; dealAmount: number; monthlyRent: number; dealType: DealType }>,
  lawdCd: string,
): Set<string> {
  const out = new Set<string>();
  for (const item of items) {
    out.add(naturalKeyFromTx(item as never, lawdCd));
  }
  return out;
}

async function warehouseRows(
  db: NonNullable<ReturnType<typeof getDb>>,
  lawdCd: string,
  ym: string,
  kind: DealType,
) {
  const result = await db.execute({
    sql: `SELECT deal_type, deal_date, apt_name, dong, jibun, floor,
                 exclusive_area, deal_amount, monthly_rent
          FROM transactions
          WHERE lawd_cd = ? AND year_month = ? AND deal_type = ?`,
    args: [lawdCd, ym, kind],
  });
  return result.rows.map((row) => ({
    dealType: String(row.deal_type) as DealType,
    dealDate: String(row.deal_date),
    aptName: String(row.apt_name),
    dong: String(row.dong ?? ""),
    jibun: String(row.jibun ?? ""),
    floor: Number(row.floor) || 0,
    exclusiveArea: Number(row.exclusive_area) || 0,
    dealAmount: Number(row.deal_amount) || 0,
    monthlyRent: Number(row.monthly_rent) || 0,
  }));
}

async function main() {
  if (!process.env.MOLIT_API_KEY) throw new Error("MOLIT_API_KEY missing");
  const db = getDb();
  if (!db) throw new Error("no db");

  const tradeYms = dailyTradeMonths();
  const rentYms = dailyRentMonths();
  const cells: unknown[] = [];
  let httpApprox = 0;
  let missingTotal = 0;
  let extraTotal = 0;
  const missingCells: string[] = [];

  for (const { code, name } of LAWDS) {
    for (const ym of tradeYms) {
      const source = await fetchOneTradeForSync(code, ym);
      httpApprox += 1;
      const warehouse = await warehouseRows(db, code, ym, "trade");
      const srcKeys = keySet(source, code);
      const whKeys = keySet(warehouse, code);
      let missing = 0;
      let extra = 0;
      for (const k of srcKeys) if (!whKeys.has(k)) missing += 1;
      for (const k of whKeys) if (!srcKeys.has(k)) extra += 1;
      missingTotal += missing;
      extraTotal += extra;
      if (missing > 0) missingCells.push(`${code}|${ym}|trade`);
      cells.push({
        name,
        code,
        ym,
        kind: "trade",
        source: source.length,
        warehouse: warehouse.length,
        missing,
        extra,
      });
    }
    for (const ym of rentYms) {
      const source = await fetchOneRentForSync(code, ym);
      httpApprox += 1;
      const warehouse = await warehouseRows(db, code, ym, "rent");
      const srcKeys = keySet(source, code);
      const whKeys = keySet(warehouse, code);
      let missing = 0;
      let extra = 0;
      for (const k of srcKeys) if (!whKeys.has(k)) missing += 1;
      for (const k of whKeys) if (!srcKeys.has(k)) extra += 1;
      missingTotal += missing;
      extraTotal += extra;
      if (missing > 0) missingCells.push(`${code}|${ym}|rent`);
      cells.push({
        name,
        code,
        ym,
        kind: "rent",
        source: source.length,
        warehouse: warehouse.length,
        missing,
        extra,
      });
    }
  }

  console.log(
    JSON.stringify(
      {
        tradeYms,
        rentYms,
        jobs: cells.length,
        http_month_fetches_min: httpApprox,
        missingTotal,
        extraTotal,
        missingCells,
        cells,
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

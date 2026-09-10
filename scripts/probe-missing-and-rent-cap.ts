/**
 * READ-only source probes for missing lawds + representative rent 1000-cap cells.
 * WRITE 0.
 *
 *   npx tsx scripts/probe-missing-and-rent-cap.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { getDb } from "../src/lib/db/client";
import {
  fetchMonthMeta,
  fetchOneRentForSync,
  fetchOneTradeForSync,
} from "../src/lib/molit/client";
import { naturalKeyFromTx } from "../src/lib/market/identity";
import { districtNameFromCode } from "../src/lib/constants/regions-registry";
import type { DealType, Transaction } from "../src/types/transaction";

type Cell = { code: string; ym: string; kind: DealType; note: string };

const MISSING_PROBES: Cell[] = [];
for (const code of ["41190", "41192", "41194", "41196", "41590"]) {
  for (const ym of ["202609", "202508", "202409", "202309", "202001", "201610"]) {
    MISSING_PROBES.push({
      code,
      ym,
      kind: "trade",
      note: "missing-lawd-trade",
    });
    if (ym >= "202210") {
      MISSING_PROBES.push({
        code,
        ym,
        kind: "rent",
        note: "missing-lawd-rent",
      });
    }
  }
}

const RENT_ROOT: Cell[] = [
  { code: "41220", ym: "202608", kind: "rent", note: "warehouse>1000" },
  { code: "11500", ym: "202608", kind: "rent", note: "warehouse>1000" },
  { code: "11710", ym: "202608", kind: "rent", note: "warehouse>1000" },
  { code: "11170", ym: "202212", kind: "rent", note: "warehouse~1000-hist" },
  { code: "11680", ym: "202302", kind: "rent", note: "eq1000-2023" },
  { code: "41135", ym: "202403", kind: "rent", note: "bundang-2024" },
  { code: "11470", ym: "202510", kind: "rent", note: "900-999-recent" },
  { code: "11560", ym: "202412", kind: "rent", note: "999" },
  { code: "41117", ym: "202501", kind: "rent", note: "suwon-2025" },
  { code: "41360", ym: "202303", kind: "rent", note: "namyangju-2023" },
  { code: "41281", ym: "202212", kind: "rent", note: "goyang-2022" },
  { code: "11680", ym: "202609", kind: "rent", note: "gangnam-recent-control" },
  { code: "41135", ym: "202509", kind: "trade", note: "bundang-trade-1020-known" },
  { code: "11350", ym: "201610", kind: "trade", note: "nowon-trade-eq1000" },
];

async function warehouseIdentities(
  db: NonNullable<ReturnType<typeof getDb>>,
  lawdCd: string,
  ym: string,
  kind: DealType,
): Promise<Set<string>> {
  const r = await db.execute({
    sql: `SELECT deal_type, deal_date, apt_name, dong, jibun, floor,
                 exclusive_area, deal_amount, monthly_rent
          FROM transactions
          WHERE lawd_cd = ? AND year_month = ? AND deal_type = ?`,
    args: [lawdCd, ym, kind],
  });
  const keys = new Set<string>();
  for (const row of r.rows) {
    keys.add(
      naturalKeyFromTx(
        {
          id: "",
          dealType: kind,
          dealDate: String(row.deal_date),
          aptName: String(row.apt_name),
          gu: "",
          dong: String(row.dong ?? ""),
          jibun: String(row.jibun ?? ""),
          floor: Number(row.floor) || 0,
          exclusiveArea: Number(row.exclusive_area) || 0,
          dealAmount: Number(row.deal_amount) || 0,
          monthlyRent: Number(row.monthly_rent) || 0,
          dealingGbn: "",
          buildYear: null,
        },
        lawdCd,
      ),
    );
  }
  return keys;
}

function sourceKeys(items: Transaction[], lawdCd: string): {
  keys: Set<string>;
  dupes: number;
} {
  const keys = new Set<string>();
  let dupes = 0;
  for (const item of items) {
    const k = naturalKeyFromTx(item, lawdCd);
    if (keys.has(k)) dupes += 1;
    else keys.add(k);
  }
  return { keys, dupes };
}

async function main() {
  const db = getDb();
  if (!db) throw new Error("no db");

  const missing: unknown[] = [];
  for (const cell of MISSING_PROBES) {
    try {
      const meta = await fetchMonthMeta(cell.kind, cell.code, cell.ym);
      missing.push({
        ...cell,
        name: districtNameFromCode(cell.code) || cell.code,
        totalCount: meta.totalCount,
        page1Count: meta.page1Count,
        pagesNeeded: meta.pagesNeeded,
        empty: meta.empty,
      });
    } catch (err) {
      missing.push({
        ...cell,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const root: unknown[] = [];
  let http = 0;
  for (const cell of RENT_ROOT) {
    const warehouse = await warehouseIdentities(db, cell.code, cell.ym, cell.kind);
    try {
      const meta = await fetchMonthMeta(cell.kind, cell.code, cell.ym);
      http += 1;
      const source =
        cell.kind === "rent"
          ? await fetchOneRentForSync(cell.code, cell.ym)
          : await fetchOneTradeForSync(cell.code, cell.ym);
      http += Math.max(1, Math.ceil(Math.max(source.length, 1) / 1000));
      const { keys, dupes } = sourceKeys(source, cell.code);
      let missingN = 0;
      let extraN = 0;
      for (const k of keys) if (!warehouse.has(k)) missingN += 1;
      for (const k of warehouse) if (!keys.has(k)) extraN += 1;
      const unchanged = keys.size - missingN;
      root.push({
        ...cell,
        name: districtNameFromCode(cell.code),
        sourceTotalCount: meta.totalCount,
        sourcePages: meta.pagesNeeded,
        sourceResolved: keys.size,
        sourceDupes: dupes,
        warehouse: warehouse.size,
        missing: missingN,
        extras: extraN,
        unchanged,
        page1Count: meta.page1Count,
        truncatedLikely:
          warehouse.size <= 1000 &&
          meta.totalCount > warehouse.size &&
          warehouse.size >= 850,
      });
    } catch (err) {
      root.push({
        ...cell,
        warehouse: warehouse.size,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  console.log(JSON.stringify({ missing, root, http }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

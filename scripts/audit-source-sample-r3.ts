/**
 * READ-ONLY source vs warehouse sample across ages.
 * Management only. WRITE 0. Uses Public Data API.
 *
 *   npx tsx scripts/audit-source-sample-r3.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { getDb } from "../src/lib/db/client";
import { fetchOneRentForSync, fetchOneTradeForSync } from "../src/lib/molit/client";
import { naturalKeyFromTx } from "../src/lib/market/identity";
import { isSameTransactionContent, snapshotFromTx } from "../src/lib/db/sync-diff";
import type { DealType, Transaction } from "../src/types/transaction";

const LAWDS: { code: string; name: string }[] = [
  { code: "11680", name: "강남구" },
  { code: "11710", name: "송파구" },
  { code: "11170", name: "용산구" },
  { code: "41135", name: "성남분당" },
  { code: "41117", name: "수원영통" },
];

const PERIODS: { label: string; ym: string }[] = [
  { label: "recent", ym: "202609" },
  { label: "recent-1", ym: "202606" },
  { label: "about-1y", ym: "202509" },
  { label: "about-2y", ym: "202409" },
  { label: "about-3y", ym: "202309" },
  { label: "older", ym: "202003" },
];

function asTx(
  row: {
    dealType: DealType;
    dealDate: string;
    aptName: string;
    dong: string;
    jibun: string;
    floor: number;
    exclusiveArea: number;
    dealAmount: number;
    monthlyRent: number;
  },
): Transaction {
  return {
    id: "",
    gu: "",
    dealingGbn: "",
    buildYear: null,
    ...row,
  };
}

async function warehouseRows(
  db: NonNullable<ReturnType<typeof getDb>>,
  lawdCd: string,
  ym: string,
  kind: DealType,
) {
  const result = await db.execute({
    sql: `SELECT deal_type, deal_date, apt_name, dong, jibun, floor,
                 exclusive_area, deal_amount, monthly_rent, dealing_gbn, build_year, gu
          FROM transactions
          WHERE lawd_cd = ? AND year_month = ? AND deal_type = ?`,
    args: [lawdCd, ym, kind],
  });
  return result.rows.map((row) => ({
    dealType: String(row.deal_type) as DealType,
    dealDate: String(row.deal_date),
    aptName: String(row.apt_name),
    gu: String(row.gu ?? ""),
    dong: String(row.dong ?? ""),
    jibun: String(row.jibun ?? ""),
    floor: Number(row.floor) || 0,
    exclusiveArea: Number(row.exclusive_area) || 0,
    dealAmount: Number(row.deal_amount) || 0,
    monthlyRent: Number(row.monthly_rent) || 0,
    dealingGbn: String(row.dealing_gbn ?? ""),
    buildYear: row.build_year == null ? null : Number(row.build_year),
  }));
}

async function main() {
  if (!process.env.MOLIT_API_KEY) throw new Error("MOLIT_API_KEY missing");
  const db = getDb();
  if (!db) throw new Error("no db");

  const cells: unknown[] = [];
  const totals = {
    source: 0,
    warehouse: 0,
    unchanged: 0,
    missing: 0,
    changed: 0,
    cancelled: 0,
    ambiguous: 0,
    http: 0,
  };

  for (const { code, name } of LAWDS) {
    for (const { label, ym } of PERIODS) {
      const kinds: DealType[] =
        ym >= "202210" ? ["trade", "rent"] : ["trade"];
      for (const kind of kinds) {
        const source =
          kind === "trade"
            ? await fetchOneTradeForSync(code, ym)
            : await fetchOneRentForSync(code, ym);
        totals.http += 1;
        const warehouse = await warehouseRows(db, code, ym, kind);
        const srcByKey = new Map<string, Transaction>();
        for (const item of source) {
          srcByKey.set(naturalKeyFromTx(item, code), item);
        }
        const whByKey = new Map<string, (typeof warehouse)[number]>();
        for (const item of warehouse) {
          whByKey.set(naturalKeyFromTx(asTx(item), code), item);
        }

        let unchanged = 0;
        let missing = 0;
        let changed = 0;
        let cancelled = 0;
        const ambiguous = 0;
        for (const [key, src] of srcByKey) {
          const wh = whByKey.get(key);
          if (!wh) {
            missing += 1;
            continue;
          }
          if (
            isSameTransactionContent(
              snapshotFromTx(src),
              snapshotFromTx(asTx(wh)),
            )
          ) {
            unchanged += 1;
          } else {
            changed += 1;
          }
        }
        for (const key of whByKey.keys()) {
          if (!srcByKey.has(key)) cancelled += 1;
        }

        totals.source += source.length;
        totals.warehouse += warehouse.length;
        totals.unchanged += unchanged;
        totals.missing += missing;
        totals.changed += changed;
        totals.cancelled += cancelled;
        totals.ambiguous += ambiguous;
        cells.push({
          name,
          code,
          label,
          ym,
          kind,
          source: source.length,
          warehouse: warehouse.length,
          unchanged,
          missing,
          changed,
          cancelled,
          ambiguous,
        });
      }
    }
  }

  console.log(
    JSON.stringify(
      {
        write: 0,
        expectedInsert: totals.missing,
        expectedUpdate: totals.changed,
        expectedDelete: totals.cancelled,
        estimatedSqlWrites:
          totals.missing + totals.changed + totals.cancelled,
        billedRowsWritten: "UNKNOWN",
        totals,
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

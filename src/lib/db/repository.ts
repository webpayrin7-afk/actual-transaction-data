import type { Client } from "@libsql/client";
import { getDb, ensureSchema } from "@/lib/db/client";
import type { DealType, Transaction } from "@/types/transaction";

export function normalizeAptName(name: string): string {
  return name.replace(/\s+/g, "").toLowerCase();
}

function yearMonthFromDealDate(dealDate: string): string {
  return `${dealDate.slice(0, 4)}${dealDate.slice(5, 7)}`;
}

/** 로컬/원격 DB 스키마 준비 (한 번만) */
let schemaReady: Promise<void> | null = null;
async function readyDb(): Promise<Client | null> {
  const db = getDb();
  if (!db) return null;
  if (!schemaReady) {
    schemaReady = ensureSchema(db).catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  await schemaReady;
  return db;
}

export async function replaceMonthTransactions(params: {
  lawdCd: string;
  yearMonth: string;
  dealKind: DealType;
  items: Transaction[];
}): Promise<number> {
  const db = await readyDb();
  if (!db) return 0;

  const { lawdCd, yearMonth, dealKind, items } = params;
  const syncedAt = new Date().toISOString();

  const statements: Array<{
    sql: string;
    args: Array<string | number | null>;
  }> = [
    {
      sql: `DELETE FROM transactions WHERE lawd_cd = ? AND year_month = ? AND deal_type = ?`,
      args: [lawdCd, yearMonth, dealKind],
    },
    {
      sql: `INSERT INTO sync_months (lawd_cd, year_month, deal_kind, synced_at, row_count)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(lawd_cd, year_month, deal_kind) DO UPDATE SET
              synced_at = excluded.synced_at,
              row_count = excluded.row_count`,
      args: [lawdCd, yearMonth, dealKind, syncedAt, items.length],
    },
  ];

  // libSQL batch limit — chunk inserts
  const insertSql = `INSERT OR REPLACE INTO transactions (
    id, lawd_cd, year_month, deal_type, deal_date, apt_name, apt_name_norm,
    gu, dong, exclusive_area, deal_amount, monthly_rent, floor, build_year, jibun, dealing_gbn
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  for (const tx of items) {
    statements.push({
      sql: insertSql,
      args: [
        tx.id,
        lawdCd,
        yearMonth,
        tx.dealType,
        tx.dealDate,
        tx.aptName,
        normalizeAptName(tx.aptName),
        tx.gu,
        tx.dong,
        tx.exclusiveArea,
        tx.dealAmount,
        tx.monthlyRent,
        tx.floor,
        tx.buildYear,
        tx.jibun,
        tx.dealingGbn,
      ],
    });
  }

  // batch in chunks of 100 statements to stay under limits
  const CHUNK = 80;
  for (let i = 0; i < statements.length; i += CHUNK) {
    await db.batch(statements.slice(i, i + CHUNK), "write");
  }

  return items.length;
}

export async function isMonthCoverageComplete(params: {
  lawdCodes: string[];
  yearMonths: string[];
  dealKinds: DealType[];
}): Promise<boolean> {
  const db = await readyDb();
  if (!db) return false;

  const { lawdCodes, yearMonths, dealKinds } = params;
  if (!lawdCodes.length || !yearMonths.length || !dealKinds.length) return false;

  const needed = lawdCodes.length * yearMonths.length * dealKinds.length;
  const lawdPlaceholders = lawdCodes.map(() => "?").join(",");
  const ymPlaceholders = yearMonths.map(() => "?").join(",");
  const kindPlaceholders = dealKinds.map(() => "?").join(",");

  const result = await db.execute({
    sql: `SELECT COUNT(*) AS cnt FROM sync_months
          WHERE lawd_cd IN (${lawdPlaceholders})
            AND year_month IN (${ymPlaceholders})
            AND deal_kind IN (${kindPlaceholders})`,
    args: [...lawdCodes, ...yearMonths, ...dealKinds],
  });

  const cnt = Number(result.rows[0]?.cnt ?? 0);
  return cnt >= needed;
}

export async function queryAptTransactions(params: {
  lawdCodes: string[];
  aptName: string;
  yearMonths: string[];
  dealKinds?: DealType[];
}): Promise<Transaction[]> {
  const db = await readyDb();
  if (!db) return [];

  const aptKey = normalizeAptName(params.aptName);
  if (!aptKey || !params.lawdCodes.length || !params.yearMonths.length) return [];

  const dealKinds = params.dealKinds ?? ["trade", "rent"];
  const lawdPlaceholders = params.lawdCodes.map(() => "?").join(",");
  const ymPlaceholders = params.yearMonths.map(() => "?").join(",");
  const kindPlaceholders = dealKinds.map(() => "?").join(",");

  const result = await db.execute({
    sql: `SELECT id, deal_type, deal_date, apt_name, gu, dong, exclusive_area,
                 deal_amount, monthly_rent, floor, build_year, jibun, dealing_gbn
          FROM transactions
          WHERE lawd_cd IN (${lawdPlaceholders})
            AND year_month IN (${ymPlaceholders})
            AND deal_type IN (${kindPlaceholders})
            AND apt_name_norm LIKE ?
          ORDER BY deal_date DESC`,
    args: [
      ...params.lawdCodes,
      ...params.yearMonths,
      ...dealKinds,
      `%${aptKey}%`,
    ],
  });

  return result.rows.map((row) => ({
    id: String(row.id),
    dealType: row.deal_type as DealType,
    dealDate: String(row.deal_date),
    aptName: String(row.apt_name),
    gu: String(row.gu ?? ""),
    dong: String(row.dong ?? ""),
    exclusiveArea: Number(row.exclusive_area) || 0,
    dealAmount: Number(row.deal_amount) || 0,
    monthlyRent: Number(row.monthly_rent) || 0,
    floor: Number(row.floor) || 0,
    buildYear: row.build_year == null ? null : Number(row.build_year),
    jibun: String(row.jibun ?? ""),
    dealingGbn: String(row.dealing_gbn ?? ""),
  }));
}

/** 자동완성용: 여러 법정동의 최근 N개월 매매 풀 */
export async function queryTradePool(params: {
  lawdCodes: string[];
  yearMonths: string[];
}): Promise<Transaction[] | null> {
  const db = await readyDb();
  if (!db) return null;

  const covered = await isMonthCoverageComplete({
    lawdCodes: params.lawdCodes,
    yearMonths: params.yearMonths,
    dealKinds: ["trade"],
  });
  if (!covered) return null;

  const lawdPlaceholders = params.lawdCodes.map(() => "?").join(",");
  const ymPlaceholders = params.yearMonths.map(() => "?").join(",");

  const result = await db.execute({
    sql: `SELECT id, deal_type, deal_date, apt_name, gu, dong, exclusive_area,
                 deal_amount, monthly_rent, floor, build_year, jibun, dealing_gbn
          FROM transactions
          WHERE lawd_cd IN (${lawdPlaceholders})
            AND year_month IN (${ymPlaceholders})
            AND deal_type = 'trade'`,
    args: [...params.lawdCodes, ...params.yearMonths],
  });

  return result.rows.map((row) => ({
    id: String(row.id),
    dealType: "trade" as const,
    dealDate: String(row.deal_date),
    aptName: String(row.apt_name),
    gu: String(row.gu ?? ""),
    dong: String(row.dong ?? ""),
    exclusiveArea: Number(row.exclusive_area) || 0,
    dealAmount: Number(row.deal_amount) || 0,
    monthlyRent: 0,
    floor: Number(row.floor) || 0,
    buildYear: row.build_year == null ? null : Number(row.build_year),
    jibun: String(row.jibun ?? ""),
    dealingGbn: String(row.dealing_gbn ?? ""),
  }));
}

export async function getSyncStats(): Promise<{
  months: number;
  transactions: number;
}> {
  const db = await readyDb();
  if (!db) return { months: 0, transactions: 0 };
  const [m, t] = await Promise.all([
    db.execute(`SELECT COUNT(*) AS cnt FROM sync_months`),
    db.execute(`SELECT COUNT(*) AS cnt FROM transactions`),
  ]);
  return {
    months: Number(m.rows[0]?.cnt ?? 0),
    transactions: Number(t.rows[0]?.cnt ?? 0),
  };
}

export { yearMonthFromDealDate };

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

/** 자동완성용: 여러 법정동의 최근 N개월 매매 풀 (부분 적재도 사용) */
export async function queryTradePool(params: {
  lawdCodes: string[];
  yearMonths: string[];
}): Promise<Transaction[] | null> {
  const db = await readyDb();
  if (!db) return null;
  if (!params.lawdCodes.length || !params.yearMonths.length) return null;

  const lawdPlaceholders = params.lawdCodes.map(() => "?").join(",");
  const ymPlaceholders = params.yearMonths.map(() => "?").join(",");

  const coverage = await db.execute({
    sql: `SELECT COUNT(*) AS cnt FROM sync_months
          WHERE lawd_cd IN (${lawdPlaceholders})
            AND year_month IN (${ymPlaceholders})
            AND deal_kind = 'trade'`,
    args: [...params.lawdCodes, ...params.yearMonths],
  });
  if (Number(coverage.rows[0]?.cnt ?? 0) === 0) return null;

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

/** 단지명 LIKE 집계 — apt_catalog 우선, 없으면 transactions 폴백 */
export async function searchAptAggregatesFromDb(params: {
  queryNorm: string;
  limit?: number;
}): Promise<
  | Array<{
      aptName: string;
      gu: string;
      dong: string;
      dealCount: number;
      maxDealAmount: number;
      latestDealDate: string;
    }>
  | null
> {
  const db = await readyDb();
  if (!db) return null;

  const q = params.queryNorm.trim();
  if (q.length < 1) return [];
  const limit = Math.min(Math.max(params.limit ?? 8, 1), 20);

  const catalog = await loadAptCatalogRows();
  if (!catalog) return null;
  if (catalog.length === 0) return [];

  const scored: Array<{
    row: (typeof catalog)[number];
    score: number;
  }> = [];

  for (const row of catalog) {
    const score = scoreAptNorm(q, row.aptNameNorm);
    if (score <= 0) continue;
    scored.push({ row, score });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.row.dealCount !== a.row.dealCount) return b.row.dealCount - a.row.dealCount;
    return b.row.maxDealAmount - a.row.maxDealAmount;
  });

  return scored.slice(0, limit).map(({ row }) => ({
    aptName: row.aptName,
    gu: row.gu,
    dong: row.dong,
    dealCount: row.dealCount,
    maxDealAmount: row.maxDealAmount,
    latestDealDate: row.latestDealDate,
  }));
}

export type CatalogRow = {
  aptNameNorm: string;
  aptName: string;
  gu: string;
  dong: string;
  dealCount: number;
  maxDealAmount: number;
  latestDealDate: string;
};

let catalogCache: { builtAt: number; rows: CatalogRow[] } | null = null;
const CATALOG_TTL_MS = 15 * 60 * 1000;

function scoreAptNorm(query: string, aptKey: string): number {
  if (!query) return 0;
  if (aptKey === query) return 10_000;
  if (aptKey.startsWith(query)) return 5_000 + query.length;
  if (aptKey.includes(query)) return 3_000 + query.length;
  if (query.length >= 4) {
    let i = 0;
    for (const ch of aptKey) {
      if (ch === query[i]) i += 1;
      if (i >= query.length) return 1_000 + query.length;
    }
  }
  return 0;
}

async function loadAptCatalogRows(): Promise<CatalogRow[] | null> {
  const db = await readyDb();
  if (!db) return null;

  if (catalogCache && Date.now() - catalogCache.builtAt < CATALOG_TTL_MS) {
    return catalogCache.rows;
  }

  const countRes = await db.execute(`SELECT COUNT(*) AS cnt FROM apt_catalog`);
  const hasCatalog = Number(countRes.rows[0]?.cnt ?? 0) > 0;

  const result = hasCatalog
    ? await db.execute(
        `SELECT apt_name_norm, apt_name, gu, dong, deal_count, max_deal_amount, latest_deal_date
         FROM apt_catalog`,
      )
    : await db.execute(
        `SELECT apt_name_norm,
                MAX(apt_name) AS apt_name,
                gu,
                MAX(dong) AS dong,
                COUNT(*) AS deal_count,
                MAX(deal_amount) AS max_deal_amount,
                MAX(deal_date) AS latest_deal_date
         FROM transactions
         WHERE deal_type = 'trade'
         GROUP BY apt_name_norm, gu`,
      );

  const rows: CatalogRow[] = result.rows.map((row) => ({
    aptNameNorm: String(row.apt_name_norm),
    aptName: String(row.apt_name),
    gu: String(row.gu ?? ""),
    dong: String(row.dong ?? ""),
    dealCount: Number(row.deal_count) || 0,
    maxDealAmount: Number(row.max_deal_amount) || 0,
    latestDealDate: String(row.latest_deal_date ?? ""),
  }));

  catalogCache = { builtAt: Date.now(), rows };
  return rows;
}

export async function listAptCatalog(): Promise<CatalogRow[] | null> {
  return loadAptCatalogRows();
}

/** transactions → apt_catalog 전체 재구축 (적재 후 1회/주기) */
export async function rebuildAptCatalog(): Promise<number> {
  const db = await readyDb();
  if (!db) return 0;

  await db.execute(`DELETE FROM apt_catalog`);
  await db.execute(`
    INSERT INTO apt_catalog (
      apt_name_norm, apt_name, gu, dong, deal_count, max_deal_amount, latest_deal_date
    )
    SELECT apt_name_norm,
           MAX(apt_name) AS apt_name,
           gu,
           MAX(dong) AS dong,
           COUNT(*) AS deal_count,
           MAX(deal_amount) AS max_deal_amount,
           MAX(deal_date) AS latest_deal_date
    FROM transactions
    WHERE deal_type = 'trade'
    GROUP BY apt_name_norm, gu
  `);

  catalogCache = null;

  const count = await db.execute(`SELECT COUNT(*) AS cnt FROM apt_catalog`);
  return Number(count.rows[0]?.cnt ?? 0);
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

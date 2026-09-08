import type { Client } from "@libsql/client";
import { getDb, ensureSchema } from "@/lib/db/client";
import { naturalKeyFromTx, stableTransactionId } from "@/lib/market/identity";
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

type ExistingRow = {
  id: string;
  naturalKey: string;
  firstSeenAt: string | null;
};

/**
 * 월 단위 upsert.
 * - 신규 INSERT: first_seen_at / last_seen_at = now
 * - 기존 UPDATE: first_seen_at 보존 (NULL legacy도 유지), last_seen_at 갱신
 * - DELETE+INSERT 금지 (discovery 시간축 파괴 방지)
 */
export async function replaceMonthTransactions(params: {
  lawdCd: string;
  yearMonth: string;
  dealKind: DealType;
  items: Transaction[];
}): Promise<{ rowCount: number; inserted: number; updated: number }> {
  const db = await readyDb();
  if (!db) return { rowCount: 0, inserted: 0, updated: 0 };

  const { lawdCd, yearMonth, dealKind, items } = params;
  const syncedAt = new Date().toISOString();

  const existingResult = await db.execute({
    sql: `SELECT id, deal_type, deal_date, apt_name, dong, jibun, floor,
                 exclusive_area, deal_amount, monthly_rent, first_seen_at
          FROM transactions
          WHERE lawd_cd = ? AND year_month = ? AND deal_type = ?`,
    args: [lawdCd, yearMonth, dealKind],
  });

  const byId = new Map<string, ExistingRow>();
  const byNatural = new Map<string, ExistingRow>();
  for (const row of existingResult.rows) {
    const id = String(row.id);
    const nk = naturalKeyFromTx(
      {
        id,
        dealType: dealKind,
        dealDate: String(row.deal_date),
        aptName: String(row.apt_name),
        gu: "",
        dong: String(row.dong ?? ""),
        exclusiveArea: Number(row.exclusive_area) || 0,
        dealAmount: Number(row.deal_amount) || 0,
        monthlyRent: Number(row.monthly_rent) || 0,
        floor: Number(row.floor) || 0,
        buildYear: null,
        jibun: String(row.jibun ?? ""),
        dealingGbn: "",
        lawdCd,
      },
      lawdCd,
    );
    const er: ExistingRow = {
      id,
      naturalKey: nk,
      firstSeenAt:
        row.first_seen_at == null || row.first_seen_at === ""
          ? null
          : String(row.first_seen_at),
    };
    byId.set(id, er);
    // 자연키 충돌 시 기존 id 유지(첫 매칭)
    if (!byNatural.has(nk)) byNatural.set(nk, er);
  }

  // 배치 내 안정 ID 충돌 방지
  const usedIds = new Set<string>();
  const seenNatural = new Set<string>();
  const upserts: Array<{
    id: string;
    tx: Transaction;
    firstSeen: string | null; // null → INSERT with now; string|keep → UPDATE preserve
    isInsert: boolean;
  }> = [];

  for (const raw of items) {
    const nk = naturalKeyFromTx(raw, lawdCd);
    if (seenNatural.has(nk)) continue; // 동일 배치 중복 스킵
    seenNatural.add(nk);

    let collision = 0;
    let candidateId = stableTransactionId(
      { ...raw, lawdCd },
      collision,
    );
    // 레거시 index ID와 새 안정 ID가 다를 수 있음 — 자연키 우선
    const matched = byNatural.get(nk) ?? byId.get(raw.id) ?? byId.get(candidateId);

    if (matched) {
      upserts.push({
        id: matched.id,
        tx: raw,
        firstSeen: matched.firstSeenAt,
        isInsert: false,
      });
      usedIds.add(matched.id);
      continue;
    }

    while (usedIds.has(candidateId) || byId.has(candidateId)) {
      collision += 1;
      candidateId = stableTransactionId({ ...raw, lawdCd }, collision);
    }
    usedIds.add(candidateId);
    upserts.push({
      id: candidateId,
      tx: raw,
      firstSeen: null,
      isInsert: true,
    });
  }

  const keepIds = new Set(upserts.map((u) => u.id));
  const deleteIds = [...byId.keys()].filter((id) => !keepIds.has(id));

  const statements: Array<{
    sql: string;
    args: Array<string | number | null>;
  }> = [
    {
      sql: `INSERT INTO sync_months (lawd_cd, year_month, deal_kind, synced_at, row_count)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(lawd_cd, year_month, deal_kind) DO UPDATE SET
              synced_at = excluded.synced_at,
              row_count = excluded.row_count`,
      args: [lawdCd, yearMonth, dealKind, syncedAt, upserts.length],
    },
  ];

  // orphan 삭제 (취소/누락 반영 — first_seen은 해당 row와 함께 제거)
  for (const id of deleteIds) {
    statements.push({
      sql: `DELETE FROM transactions WHERE id = ?`,
      args: [id],
    });
  }

  const insertSql = `INSERT INTO transactions (
    id, lawd_cd, year_month, deal_type, deal_date, apt_name, apt_name_norm,
    gu, dong, exclusive_area, deal_amount, monthly_rent, floor, build_year,
    jibun, dealing_gbn, first_seen_at, last_seen_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  // first_seen_at은 UPDATE에서 절대 덮어쓰지 않음 (legacy NULL 유지)
  let inserted = 0;
  let updated = 0;

  for (const u of upserts) {
    const aptNorm = normalizeAptName(u.tx.aptName);
    if (u.isInsert) {
      inserted += 1;
      statements.push({
        sql: insertSql,
        args: [
          u.id,
          lawdCd,
          yearMonth,
          u.tx.dealType,
          u.tx.dealDate,
          u.tx.aptName,
          aptNorm,
          u.tx.gu,
          u.tx.dong,
          u.tx.exclusiveArea,
          u.tx.dealAmount,
          u.tx.monthlyRent,
          u.tx.floor,
          u.tx.buildYear,
          u.tx.jibun,
          u.tx.dealingGbn,
          syncedAt,
          syncedAt,
        ],
      });
    } else {
      updated += 1;
      statements.push({
        sql: `UPDATE transactions SET
          lawd_cd = ?, year_month = ?, deal_type = ?, deal_date = ?,
          apt_name = ?, apt_name_norm = ?, gu = ?, dong = ?,
          exclusive_area = ?, deal_amount = ?, monthly_rent = ?, floor = ?,
          build_year = ?, jibun = ?, dealing_gbn = ?,
          last_seen_at = ?
        WHERE id = ?`,
        args: [
          lawdCd,
          yearMonth,
          u.tx.dealType,
          u.tx.dealDate,
          u.tx.aptName,
          aptNorm,
          u.tx.gu,
          u.tx.dong,
          u.tx.exclusiveArea,
          u.tx.dealAmount,
          u.tx.monthlyRent,
          u.tx.floor,
          u.tx.buildYear,
          u.tx.jibun,
          u.tx.dealingGbn,
          syncedAt,
          u.id,
        ],
      });
    }
  }

  const CHUNK = 80;
  for (let i = 0; i < statements.length; i += CHUNK) {
    await db.batch(statements.slice(i, i + CHUNK), "write");
  }

  return { rowCount: upserts.length, inserted, updated };
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

/** 지역 다개월 전세(월세 0) 풀 — 커버리지가 전혀 없으면 null */
export async function queryRentPool(params: {
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
            AND deal_kind = 'rent'`,
    args: [...params.lawdCodes, ...params.yearMonths],
  });
  if (Number(coverage.rows[0]?.cnt ?? 0) === 0) return null;

  const result = await db.execute({
    sql: `SELECT id, deal_type, deal_date, apt_name, gu, dong, exclusive_area,
                 deal_amount, monthly_rent, floor, build_year, jibun, dealing_gbn
          FROM transactions
          WHERE lawd_cd IN (${lawdPlaceholders})
            AND year_month IN (${ymPlaceholders})
            AND deal_type = 'rent'
            AND monthly_rent = 0`,
    args: [...params.lawdCodes, ...params.yearMonths],
  });

  return result.rows.map((row) => ({
    id: String(row.id),
    dealType: "rent" as const,
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

/** 지역 검색용: 해당 월(들) 매매/전월세 (적재된 것만, 커버리지 없으면 null) */
export async function queryRegionMonthPool(params: {
  lawdCodes: string[];
  yearMonths: string[];
  dealKinds?: DealType[];
}): Promise<Transaction[] | null> {
  const db = await readyDb();
  if (!db) return null;
  if (!params.lawdCodes.length || !params.yearMonths.length) return null;

  const dealKinds = params.dealKinds ?? ["trade", "rent"];
  const lawdPlaceholders = params.lawdCodes.map(() => "?").join(",");
  const ymPlaceholders = params.yearMonths.map(() => "?").join(",");
  const kindPlaceholders = dealKinds.map(() => "?").join(",");

  const coverage = await db.execute({
    sql: `SELECT COUNT(*) AS cnt FROM sync_months
          WHERE lawd_cd IN (${lawdPlaceholders})
            AND year_month IN (${ymPlaceholders})
            AND deal_kind IN (${kindPlaceholders})`,
    args: [...params.lawdCodes, ...params.yearMonths, ...dealKinds],
  });
  if (Number(coverage.rows[0]?.cnt ?? 0) === 0) return null;

  const result = await db.execute({
    sql: `SELECT id, deal_type, deal_date, apt_name, gu, dong, exclusive_area,
                 deal_amount, monthly_rent, floor, build_year, jibun, dealing_gbn
          FROM transactions
          WHERE lawd_cd IN (${lawdPlaceholders})
            AND year_month IN (${ymPlaceholders})
            AND deal_type IN (${kindPlaceholders})
          ORDER BY deal_date DESC`,
    args: [...params.lawdCodes, ...params.yearMonths, ...dealKinds],
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

export type RegionBrowseAptRow = {
  aptName: string;
  gu: string;
  dong: string;
  dealCount: number;
  tradeCount: number;
  maxDealAmount: number;
  latestDealDate: string;
  buildYear: number | null;
};

/** 지역(법정동코드) 매매 거래 기준 단지 집계 — 동별 상세용 */
export async function queryRegionBrowseApts(
  lawdCodes: string[],
): Promise<RegionBrowseAptRow[] | null> {
  const db = await readyDb();
  if (!db || !lawdCodes.length) return null;

  const placeholders = lawdCodes.map(() => "?").join(",");
  const result = await db.execute({
    sql: `SELECT MAX(apt_name) AS apt_name,
                 MAX(gu) AS gu,
                 MAX(dong) AS dong,
                 COUNT(*) AS deal_count,
                 MAX(deal_amount) AS max_deal_amount,
                 MAX(deal_date) AS latest_deal_date,
                 MAX(build_year) AS build_year
          FROM transactions
          WHERE lawd_cd IN (${placeholders})
            AND deal_type = 'trade'
            AND TRIM(dong) != ''
          GROUP BY apt_name_norm, gu, dong`,
    args: [...lawdCodes],
  });

  if (!result.rows.length) return null;

  return result.rows.map((row) => {
    const dealCount = Number(row.deal_count) || 0;
    return {
      aptName: String(row.apt_name ?? ""),
      gu: String(row.gu ?? ""),
      dong: String(row.dong ?? ""),
      dealCount,
      tradeCount: dealCount,
      maxDealAmount: Number(row.max_deal_amount) || 0,
      latestDealDate: String(row.latest_deal_date ?? ""),
      buildYear:
        row.build_year == null || row.build_year === ""
          ? null
          : Number(row.build_year) || null,
    };
  });
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

/** 지역(법정동코드)에 적재된 계약년월 목록 (최신순) */
export async function listSyncedYearMonths(
  lawdCodes: string[],
): Promise<string[]> {
  const db = await readyDb();
  if (!db || !lawdCodes.length) return [];

  const placeholders = lawdCodes.map(() => "?").join(",");
  const result = await db.execute({
    sql: `SELECT DISTINCT year_month AS ym
          FROM sync_months
          WHERE lawd_cd IN (${placeholders})
            AND row_count > 0
          ORDER BY year_month DESC`,
    args: [...lawdCodes],
  });

  return result.rows
    .map((row) => String(row.ym ?? ""))
    .filter((ym) => /^\d{6}$/.test(ym));
}

export { yearMonthFromDealDate };

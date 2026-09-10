import type { Client } from "@libsql/client";
import { getDb, ensureSchema } from "@/lib/db/client";
import {
  isSameTransactionContent,
  snapshotFromTx,
} from "@/lib/db/sync-diff";
import type { TxContentSnapshot } from "@/lib/db/sync-diff";
import { naturalKeyFromTx, stableTransactionId } from "@/lib/market/identity";
import { isUnsafeMonthShrink } from "@/lib/molit/trade-resolve";
import type { DealType, Transaction } from "@/types/transaction";
import { noteDbQuery } from "@/lib/db/query-stats";
import {
  hasDiscoveryAtColumn,
  isoOrNull,
} from "@/lib/db/discovery-axis";

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
  content: TxContentSnapshot;
};

export type ReplaceMonthResult = {
  rowCount: number;
  inserted: number;
  /** 본문이 실제로 달라서 UPDATE 한 건수 */
  updated: number;
  /** 본문 동일 → DB write 없음 */
  unchanged: number;
  deleted: number;
  /** transaction INSERT/UPDATE/DELETE 가 있었는지 */
  wrote: boolean;
};

/**
 * 월 단위 upsert.
 * - 신규 INSERT (discovery=1): first_seen_at = last_seen_at = discovery_at = now
 * - 신규 INSERT (discovery=0): first_seen_at = last_seen_at = now, discovery_at = NULL
 *   (discovery_at 컬럼이 없으면 legacy: first_seen_at = NULL)
 * - 기존 + 본문 변경: first_seen_at / discovery_at 보존, 필드+last_seen_at 갱신
 * - 기존 + 본문 동일: NO-OP (last_seen_at도 갱신하지 않음 — 코드베이스에서 미사용)
 * - orphan: id 단위 DELETE
 * - 월 전체 DELETE+INSERT 금지 (discovery 시간축 파괴 방지)
 */
export async function replaceMonthTransactions(params: {
  lawdCd: string;
  yearMonth: string;
  dealKind: DealType;
  items: Transaction[];
  /**
   * true(기본): daily discovery INSERT.
   *   discovery_at 컬럼 있음 → first_seen_at=now, discovery_at=now
   *   컬럼 없음(legacy) → first_seen_at=now
   * false: backfill/correction INSERT.
   *   discovery_at 컬럼 있음 → first_seen_at=now, discovery_at=NULL
   *   컬럼 없음(legacy) → first_seen_at=NULL
   */
  setFirstSeenOnInsert?: boolean;
  /** Classify diffs but execute no SQL. UNCHANGED/INSERT/UPDATE/DELETE counts only. */
  dryRun?: boolean;
  /**
   * Historical repair: classify warehouse extras but do not DELETE them.
   * `deleted` still reports the extra-candidate count; SQL DELETE is 0.
   */
  skipDelete?: boolean;
}): Promise<ReplaceMonthResult> {
  const empty: ReplaceMonthResult = {
    rowCount: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    deleted: 0,
    wrote: false,
  };
  const db = await readyDb();
  if (!db) return empty;

  const { lawdCd, yearMonth, dealKind, items } = params;
  const setFirstSeenOnInsert = params.setFirstSeenOnInsert !== false;
  const dryRun = params.dryRun === true;
  const skipDelete = params.skipDelete === true;
  const syncedAt = new Date().toISOString();
  const writeDiscoveryCol = await hasDiscoveryAtColumn(db);
  // Future ingest: audit first_seen always; product discovery only when flagged.
  // Legacy (no column): keep first_seen as the product switch so prod feeds
  // are not suddenly filled by discovery=0 warehouse INSERTs.
  const insertFirstSeen: string | null = writeDiscoveryCol
    ? syncedAt
    : setFirstSeenOnInsert
      ? syncedAt
      : null;
  const insertDiscoveryAt: string | null = setFirstSeenOnInsert ? syncedAt : null;

  const existingResult = await db.execute({
    sql: `SELECT id, deal_type, deal_date, apt_name, gu, dong, jibun, floor,
                 exclusive_area, deal_amount, monthly_rent, build_year,
                 dealing_gbn, first_seen_at
          FROM transactions
          WHERE lawd_cd = ? AND year_month = ? AND deal_type = ?`,
    args: [lawdCd, yearMonth, dealKind],
  });

  const byId = new Map<string, ExistingRow>();
  const byNatural = new Map<string, ExistingRow>();
  for (const row of existingResult.rows) {
    const id = String(row.id);
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
    const nk = naturalKeyFromTx(
      {
        id,
        dealType: dealKind,
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
      content,
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
    dirty: boolean;
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
      const dirty = !isSameTransactionContent(
        matched.content,
        snapshotFromTx(raw),
      );
      upserts.push({
        id: matched.id,
        tx: raw,
        firstSeen: matched.firstSeenAt,
        isInsert: false,
        dirty,
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
      dirty: true,
    });
  }

  const keepIds = new Set(upserts.map((u) => u.id));
  const deleteIds = [...byId.keys()].filter((id) => !keepIds.has(id));

  const statements: Array<{
    sql: string;
    args: Array<string | number | null>;
  }> = [];

  // first_seen_at / discovery_at은 UPDATE에서 절대 덮어쓰지 않음
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;

  const insertSql = writeDiscoveryCol
    ? `INSERT INTO transactions (
    id, lawd_cd, year_month, deal_type, deal_date, apt_name, apt_name_norm,
    gu, dong, exclusive_area, deal_amount, monthly_rent, floor, build_year,
    jibun, dealing_gbn, first_seen_at, last_seen_at, discovery_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    : `INSERT INTO transactions (
    id, lawd_cd, year_month, deal_type, deal_date, apt_name, apt_name_norm,
    gu, dong, exclusive_area, deal_amount, monthly_rent, floor, build_year,
    jibun, dealing_gbn, first_seen_at, last_seen_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

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
          insertFirstSeen,
          syncedAt,
          ...(writeDiscoveryCol ? [insertDiscoveryAt] : []),
        ],
      });
    } else if (u.dirty) {
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
    } else {
      unchanged += 1;
    }
  }

  // orphan 삭제 (취소/누락 반영 — first_seen은 해당 row와 함께 제거)
  // skipDelete: extras는 보고만 하고 자동 DELETE 하지 않음 (historical repair)
  if (!skipDelete) {
    for (const id of deleteIds) {
      statements.push({
        sql: `DELETE FROM transactions WHERE id = ?`,
        args: [id],
      });
    }
  }

  const deleted = deleteIds.length;
  const executedDeletes = skipDelete ? 0 : deleted;
  const wroteTx = inserted + updated + executedDeletes > 0;

  if (
    !skipDelete &&
    isUnsafeMonthShrink({
      previousRowCount: byId.size,
      nextRowCount: upserts.length,
    })
  ) {
    throw new Error(
      `refusing destructive month replace ${lawdCd} ${yearMonth} ${dealKind}: warehouse=${byId.size} incomingUnique=${upserts.length}`,
    );
  }

  // sync_months metadata는 transaction write가 있을 때만 (1 cell upsert)
  if (wroteTx) {
    statements.unshift({
      sql: `INSERT INTO sync_months (lawd_cd, year_month, deal_kind, synced_at, row_count)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(lawd_cd, year_month, deal_kind) DO UPDATE SET
              synced_at = excluded.synced_at,
              row_count = excluded.row_count`,
      args: [lawdCd, yearMonth, dealKind, syncedAt, upserts.length],
    });
  }

  if (dryRun) {
    return {
      rowCount: upserts.length,
      inserted,
      updated,
      unchanged,
      deleted,
      wrote: false,
    };
  }

  if (statements.length > 0) {
    const CHUNK = 80;
    for (let i = 0; i < statements.length; i += CHUNK) {
      await db.batch(statements.slice(i, i + CHUNK), "write");
    }
  }

  return {
    rowCount: upserts.length,
    inserted,
    updated,
    unchanged,
    deleted: executedDeletes,
    wrote: wroteTx,
  };
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
  if (!aptKey || !params.lawdCodes.length) return [];

  const dealKinds = params.dealKinds ?? ["trade", "rent"];
  const lawdPlaceholders = params.lawdCodes.map(() => "?").join(",");
  const kindPlaceholders = dealKinds.map(() => "?").join(",");
  const yearMonths = params.yearMonths ?? [];
  const ymClause =
    yearMonths.length > 0
      ? `AND year_month IN (${yearMonths.map(() => "?").join(",")})`
      : "";

  // exact apt_name_norm = ? → idx_tx_lawd_apt_ym 사용.
  const result = await db.execute({
    sql: `SELECT id, deal_type, deal_date, apt_name, gu, dong, exclusive_area,
                 deal_amount, monthly_rent, floor, build_year, jibun, dealing_gbn
          FROM transactions
          WHERE lawd_cd IN (${lawdPlaceholders})
            ${ymClause}
            AND deal_type IN (${kindPlaceholders})
            AND apt_name_norm = ?
          ORDER BY deal_date DESC`,
    args: [
      ...params.lawdCodes,
      ...yearMonths,
      ...dealKinds,
      aptKey,
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

/** 자동완성용: 여러 법정동의 매매 풀. sync_months 게이트 없음 — warehouse rows 그대로. */
export async function queryTradePool(params: {
  lawdCodes: string[];
  yearMonths: string[];
}): Promise<Transaction[] | null> {
  const db = await readyDb();
  if (!db) return null;
  if (!params.lawdCodes.length || !params.yearMonths.length) return [];

  const lawdPlaceholders = params.lawdCodes.map(() => "?").join(",");
  const ymPlaceholders = params.yearMonths.map(() => "?").join(",");

  noteDbQuery();
  const writeDiscoveryCol = await hasDiscoveryAtColumn(db);
  const result = await db.execute({
    sql: `SELECT id, deal_type, deal_date, apt_name, gu, dong, exclusive_area,
                 deal_amount, monthly_rent, floor, build_year, jibun, dealing_gbn,
                 first_seen_at${writeDiscoveryCol ? ", discovery_at" : ""}
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
    firstSeenAt: isoOrNull(row.first_seen_at),
    ...(writeDiscoveryCol
      ? { discoveryAt: isoOrNull(row.discovery_at) }
      : {}),
  }));
}

function mapTradeQueryRow(
  row: Record<string, unknown>,
  writeDiscoveryCol: boolean,
): Transaction {
  return {
    id: String(row.id),
    dealType: "trade",
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
    firstSeenAt: isoOrNull(row.first_seen_at),
    ...(writeDiscoveryCol
      ? { discoveryAt: isoOrNull(row.discovery_at) }
      : {}),
  };
}

/** Distinct trade year_month values that actually exist in the warehouse. */
export async function queryAvailableTradeMonths(params: {
  lawdCodes: string[];
}): Promise<string[]> {
  const db = await readyDb();
  if (!db || !params.lawdCodes.length) return [];
  const ph = params.lawdCodes.map(() => "?").join(",");
  noteDbQuery();
  const result = await db.execute({
    sql: `SELECT year_month AS ym
          FROM sync_months
          WHERE lawd_cd IN (${ph}) AND deal_kind = 'trade'
          GROUP BY year_month
          HAVING SUM(row_count) > 0
          ORDER BY year_month DESC`,
    args: [...params.lawdCodes],
  });
  const fromSync = result.rows
    .map((row) => String(row.ym))
    .filter((ym) => ym.length === 6);
  if (fromSync.length > 0) return fromSync;

  noteDbQuery();
  const fallback = await db.execute({
    sql: `SELECT DISTINCT year_month AS ym
          FROM transactions
          WHERE lawd_cd IN (${ph}) AND deal_type = 'trade'
          ORDER BY year_month DESC`,
    args: [...params.lawdCodes],
  });
  return fallback.rows.map((row) => String(row.ym)).filter((ym) => ym.length === 6);
}

/**
 * Month-scoped trade read. Does not require sync_months coverage —
 * warehouse rows are served even if metadata is missing.
 */
export async function queryRegionTrades(params: {
  lawdCodes: string[];
  yearMonths: string[];
}): Promise<Transaction[]> {
  const db = await readyDb();
  if (!db) return [];
  if (!params.lawdCodes.length || !params.yearMonths.length) return [];
  const lawdPh = params.lawdCodes.map(() => "?").join(",");
  const ymPh = params.yearMonths.map(() => "?").join(",");
  noteDbQuery();
  const writeDiscoveryCol = await hasDiscoveryAtColumn(db);
  const result = await db.execute({
    sql: `SELECT id, deal_type, deal_date, apt_name, gu, dong, exclusive_area,
                 deal_amount, monthly_rent, floor, build_year, jibun, dealing_gbn,
                 first_seen_at${writeDiscoveryCol ? ", discovery_at" : ""}
          FROM transactions
          WHERE lawd_cd IN (${lawdPh})
            AND year_month IN (${ymPh})
            AND deal_type = 'trade'`,
    args: [...params.lawdCodes, ...params.yearMonths],
  });
  return result.rows.map((row) =>
    mapTradeQueryRow(row as Record<string, unknown>, writeDiscoveryCol),
  );
}

/** Section 2 / Home-style product discoveries for a region. */
export async function queryRegionDiscoveries(params: {
  lawdCodes: string[];
}): Promise<Transaction[]> {
  const db = await readyDb();
  if (!db || !params.lawdCodes.length) return [];
  const writeDiscoveryCol = await hasDiscoveryAtColumn(db);
  const lawdPh = params.lawdCodes.map(() => "?").join(",");
  noteDbQuery();
  const activityClause = writeDiscoveryCol
    ? "AND discovery_at IS NOT NULL AND discovery_at != ''"
    : "AND first_seen_at IS NOT NULL AND first_seen_at != ''";
  const result = await db.execute({
    sql: `SELECT id, deal_type, deal_date, apt_name, gu, dong, exclusive_area,
                 deal_amount, monthly_rent, floor, build_year, jibun, dealing_gbn,
                 first_seen_at${writeDiscoveryCol ? ", discovery_at" : ""}
          FROM transactions
          WHERE lawd_cd IN (${lawdPh})
            AND deal_type = 'trade'
            ${activityClause}`,
    args: [...params.lawdCodes],
  });
  return result.rows.map((row) =>
    mapTradeQueryRow(row as Record<string, unknown>, writeDiscoveryCol),
  );
}

export type AptTradeHistoryRow = {
  id: string;
  aptNameNorm: string;
  exclusiveArea: number;
  dealDate: string;
  dealAmount: number;
};

const APT_HISTORY_IN_CHUNK = 80;

export type AptTypePriorCandidate = {
  aptNameNorm: string;
  exclusiveArea: number;
  dealDate: string;
};

const APT_PRIOR_MAX_CHUNK = 16;

function dealYearMonth(dealDate: string): string {
  const d = dealDate.slice(0, 10);
  return `${d.slice(0, 4)}${d.slice(5, 7)}`;
}

/**
 * 후보 거래별 all-time prior MAX. 행을 Node로 가져오지 않는다.
 * deal_date 전국 스캔(idx_tx_type_deal_date)을 피하고 idx_tx_lawd_apt_ym 을 쓴다.
 * 같은 (apt, areaKey, contract date) 후보는 한 번만 조회한다.
 * 다른 cutoff는 합치지 않는다. 신규 index 없음.
 */
export async function queryAptTypePriorMaxes(params: {
  lawdCodes: string[];
  candidates: AptTypePriorCandidate[];
}): Promise<number[] | null> {
  const db = await readyDb();
  if (!db) return null;
  const { lawdCodes, candidates } = params;
  if (!lawdCodes.length) return candidates.map(() => 0);
  const out = candidates.map(() => 0);
  if (candidates.length === 0) return out;

  const lawdPlaceholders = lawdCodes.map(() => "?").join(",");
  const unique: AptTypePriorCandidate[] = [];
  const uniqueIndexByKey = new Map<string, number>();
  const sourceToUnique = candidates.map((candidate) => {
    const key = `${candidate.aptNameNorm}|${Math.round(candidate.exclusiveArea * 100)}|${candidate.dealDate.slice(0, 10)}`;
    const existing = uniqueIndexByKey.get(key);
    if (existing != null) return existing;
    const next = unique.length;
    uniqueIndexByKey.set(key, next);
    unique.push(candidate);
    return next;
  });

  const uniqueMaxes = unique.map(() => 0);
  const byDate = new Map<string, number[]>();
  unique.forEach((candidate, index) => {
    const day = candidate.dealDate.slice(0, 10);
    const prev = byDate.get(day);
    if (prev) prev.push(index);
    else byDate.set(day, [index]);
  });

  const dateJobs = [...byDate.entries()].map(([day, indexes]) => async () => {
    const norms = [...new Set(indexes.map((i) => unique[i]!.aptNameNorm))];
    const areaCents = [
      ...new Set(indexes.map((i) => Math.round(unique[i]!.exclusiveArea * 100))),
    ];
    for (let i = 0; i < norms.length; i += APT_PRIOR_MAX_CHUNK) {
      const chunk = norms.slice(i, i + APT_PRIOR_MAX_CHUNK);
      const namePlaceholders = chunk.map(() => "?").join(",");
      const areaPlaceholders = areaCents.map(() => "?").join(",");
      noteDbQuery();
      const result = await db.execute({
        sql: `SELECT apt_name_norm,
                     CAST(ROUND(exclusive_area * 100) AS INTEGER) AS area_cents,
                     MAX(deal_amount) AS prior_max
              FROM transactions INDEXED BY idx_tx_lawd_apt_ym
              WHERE lawd_cd IN (${lawdPlaceholders})
                AND apt_name_norm IN (${namePlaceholders})
                AND year_month <= ?
                AND deal_type = 'trade'
                AND deal_date < ?
                AND CAST(ROUND(exclusive_area * 100) AS INTEGER) IN (${areaPlaceholders})
              GROUP BY apt_name_norm, CAST(ROUND(exclusive_area * 100) AS INTEGER)`,
        args: [
          ...lawdCodes,
          ...chunk,
          dealYearMonth(day),
          day,
          ...areaCents,
        ],
      });
      const maxByKey = new Map<string, number>();
      for (const row of result.rows) {
        maxByKey.set(
          `${String(row.apt_name_norm)}|${Number(row.area_cents) || 0}`,
          Number(row.prior_max) || 0,
        );
      }
      for (const index of indexes) {
        const candidate = unique[index]!;
        if (!chunk.includes(candidate.aptNameNorm)) continue;
        const key = `${candidate.aptNameNorm}|${Math.round(candidate.exclusiveArea * 100)}`;
        const sqlMax = maxByKey.get(key) ?? 0;
        if (sqlMax > uniqueMaxes[index]!) uniqueMaxes[index] = sqlMax;
      }
    }
  });

  const DATE_CONCURRENCY = 3;
  for (let i = 0; i < dateJobs.length; i += DATE_CONCURRENCY) {
    await Promise.all(dateJobs.slice(i, i + DATE_CONCURRENCY).map((job) => job()));
  }

  for (let i = 0; i < candidates.length; i++) {
    out[i] = uniqueMaxes[sourceToUnique[i]!] ?? 0;
  }
  return out;
}

/**
 * 동일 지역·후보 단지 all-time 매매 (신고가 prior).
 * 요청마다 지역 전체 scan 금지 — apt_name_norm IN 으로 한정.
 * 신규 index/backfill 없음. 기존 idx_tx_lawd_apt_ym 활용.
 */
export async function queryAptTradeHistory(params: {
  lawdCodes: string[];
  aptNameNorms: string[];
}): Promise<AptTradeHistoryRow[] | null> {
  const db = await readyDb();
  if (!db) return null;
  const client = db;
  const norms = [
    ...new Set(params.aptNameNorms.map((n) => n.trim()).filter(Boolean)),
  ];
  if (!params.lawdCodes.length || norms.length === 0) return [];

  const lawdPlaceholders = params.lawdCodes.map(() => "?").join(",");
  const out: AptTradeHistoryRow[] = [];
  const HISTORY_CHUNK_CONCURRENCY = 3;

  async function fetchChunk(chunk: string[]): Promise<AptTradeHistoryRow[]> {
    const namePlaceholders = chunk.map(() => "?").join(",");
    noteDbQuery();
    const result = await client.execute({
      sql: `SELECT id, apt_name_norm, exclusive_area, deal_date, deal_amount
            FROM transactions INDEXED BY idx_tx_lawd_apt_ym
            WHERE lawd_cd IN (${lawdPlaceholders})
              AND apt_name_norm IN (${namePlaceholders})
              AND deal_type = 'trade'`,
      args: [...params.lawdCodes, ...chunk],
    });
    return result.rows.map((row) => ({
      id: String(row.id),
      aptNameNorm: String(row.apt_name_norm),
      exclusiveArea: Number(row.exclusive_area) || 0,
      dealDate: String(row.deal_date),
      dealAmount: Number(row.deal_amount) || 0,
    }));
  }

  const chunks: string[][] = [];
  for (let i = 0; i < norms.length; i += APT_HISTORY_IN_CHUNK) {
    chunks.push(norms.slice(i, i + APT_HISTORY_IN_CHUNK));
  }
  for (let i = 0; i < chunks.length; i += HISTORY_CHUNK_CONCURRENCY) {
    const parts = await Promise.all(
      chunks.slice(i, i + HISTORY_CHUNK_CONCURRENCY).map((chunk) => fetchChunk(chunk)),
    );
    for (const part of parts) out.push(...part);
  }

  return out;
}

/** 지역 다개월 전세(월세 0) 풀. sync_months 게이트 없음. */
export async function queryRentPool(params: {
  lawdCodes: string[];
  yearMonths: string[];
}): Promise<Transaction[] | null> {
  const db = await readyDb();
  if (!db) return null;
  if (!params.lawdCodes.length || !params.yearMonths.length) return [];

  const lawdPlaceholders = params.lawdCodes.map(() => "?").join(",");
  const ymPlaceholders = params.yearMonths.map(() => "?").join(",");

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

/** 지역 검색용: 해당 월(들) 매매/전월세. sync_months 게이트 없음. */
export async function queryRegionMonthPool(params: {
  lawdCodes: string[];
  yearMonths: string[];
  dealKinds?: DealType[];
}): Promise<Transaction[] | null> {
  const db = await readyDb();
  if (!db) return null;
  if (!params.lawdCodes.length || !params.yearMonths.length) return [];

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

const REGION_BROWSE_CACHE_TTL_MS = 10 * 60 * 1000;
const regionBrowseCache = new Map<
  string,
  { builtAt: number; rows: RegionBrowseAptRow[] }
>();
const regionBrowseInflight = new Map<
  string,
  Promise<RegionBrowseAptRow[] | null>
>();

/** 지역(법정동코드) 매매 거래 기준 단지 집계 — 동별 상세용 */
export async function queryRegionBrowseApts(
  lawdCodes: string[],
): Promise<RegionBrowseAptRow[] | null> {
  if (!lawdCodes.length) return null;

  const cacheKey = [...lawdCodes].sort().join(",");
  const cached = regionBrowseCache.get(cacheKey);
  if (cached && Date.now() - cached.builtAt < REGION_BROWSE_CACHE_TTL_MS) {
    return cached.rows;
  }

  const inflight = regionBrowseInflight.get(cacheKey);
  if (inflight) return inflight;

  const request = queryRegionBrowseAptsUncached(lawdCodes)
    .then((rows) => {
      if (rows) {
        regionBrowseCache.set(cacheKey, { builtAt: Date.now(), rows });
      }
      return rows;
    })
    .finally(() => {
      regionBrowseInflight.delete(cacheKey);
    });
  regionBrowseInflight.set(cacheKey, request);
  return request;
}

async function queryRegionBrowseAptsUncached(
  lawdCodes: string[],
): Promise<RegionBrowseAptRow[] | null> {
  const db = await readyDb();
  if (!db) return null;

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

/**
 * 단지 실거래 원본 스냅샷 (apt_tx_hist_snap).
 *
 * 단지(lawd_cd, apt_name_norm)마다 queryAptTransactions 라이브 쿼리(전체 이력, trade+rent)와
 * 똑같은 행 집합(같은 컬럼 매핑, 같은 ORDER BY deal_date DESC, id)을 컬럼형 JSON → brotli BLOB 1행으로 둔다.
 * 응답이 아니라 원본 행만 담으므로 날짜 의존 계산(최근 N개월, 신고가 등)은 요청 시점에 그대로 돌고
 * 숫자는 라이브와 같다.
 *
 * 신선도: transactions 변경 표시(src/lib/db/snapshot-freshness.ts). 스냅샷 행마다 빌드 직전에 읽은
 * 단지 번호(mark)를 저장하고, 읽을 때 같은 SELECT 에서 현재 단지 번호를 같이 읽어 같을 때만 쓴다.
 * sync 밖의 직접 UPDATE(행 수가 그대로인 apt_dong·정정 등)도 트리거가 번호를 올리므로 잡힌다.
 * 저장은 "번호가 아직 그대로일 때만" 조건부 쓰기 — 빌드 도중 바뀐 단지는 저장되지 않는다.
 *
 * 읽기(요청 경로, 쓰기 없음): 1왕복. 표·트리거 없음·에러·형식 불일치·디코드 실패 → null → 라이브.
 * 갱신: 일일 sync 끝(scripts/sync-molit.ts) refreshAptTxSnapshots — 지난 갱신 뒤 번호가 바뀐 단지만
 *       다시 읽고, 내용이 같으면 mark 만 올린다.
 * 초기 적재/재빌드: scripts/build-apt-tx-snapshot.ts
 */
import { createHash } from "node:crypto";
import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from "node:zlib";
import type { Client, InStatement } from "@libsql/client";
import type { DealType, Transaction } from "@/types/transaction";
import {
  changeMarkSubquery,
  listChangedComplexesSince,
  markUnchangedCondition,
  readGlobalChangeSeq,
} from "@/lib/db/snapshot-freshness";

export const APT_TX_SNAPSHOT_TABLE = "apt_tx_hist_snap";
export const APT_TX_SNAPSHOT_FORMAT = 2;
/** snapshot_watermark family — synced_through = 마지막으로 다 반영한 tx_change_seq (문자열) */
export const APT_TX_SNAPSHOT_WM_FAMILY = "apt_tx_hist";

/** 스냅샷이 믿는 트리거 (src/lib/db/migrations/20261001_tx_change_marks.sql). 하나라도 없으면 라이브. */
export const TX_CHANGE_TRIGGERS = [
  "trg_tx_change_ai",
  "trg_tx_change_au",
  "trg_tx_change_au_old",
  "trg_tx_change_ad",
] as const;

/** queryAptTransactions 와 스냅샷 빌더가 공유하는 SELECT 컬럼 (순서·매핑 동일해야 함) */
export const APT_TX_SELECT_COLUMNS = `id, deal_type, deal_date, apt_name, gu, dong, exclusive_area,
                 deal_amount, monthly_rent, floor, build_year, jibun, dealing_gbn, rgst_date, apt_dong`;

/** 단지 안 정렬. id 로 동률을 끊어 라이브·스냅샷 순서가 항상 같게 한다. */
export const APT_TX_ORDER_BY = `deal_date DESC, id`;

export const APT_TX_SNAPSHOT_DDL = `CREATE TABLE IF NOT EXISTS ${APT_TX_SNAPSHOT_TABLE} (
  lawd_cd TEXT NOT NULL,
  apt_name_norm TEXT NOT NULL,
  mark INTEGER NOT NULL,
  format INTEGER NOT NULL,
  tx_count INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  built_at TEXT NOT NULL,
  payload BLOB NOT NULL,
  PRIMARY KEY (lawd_cd, apt_name_norm)
)`;

export function mapAptTxRow(row: Record<string, unknown>): Transaction {
  return {
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
    rgstDate: row.rgst_date == null || String(row.rgst_date).trim() === "" ? null : String(row.rgst_date),
    aptDong: row.apt_dong == null || String(row.apt_dong).trim() === "" ? null : String(row.apt_dong).trim(),
  };
}

// ---------------------------------------------------------------------------
// 인코딩 (format 2): 컬럼형. 단지 안에서 값이 하나뿐인 컬럼은 상수로, 문자열은 사전 번호로,
// 거래일은 일수 차분으로, id 는 적재 규칙으로 다시 만들 수 있으면 0 으로 줄인다.
// 규칙(아래 idTemplate)은 이 형식에 고정 — identity.ts 가 바뀌어도 디코드는 그대로.
// 빌드는 항상 디코드 왕복이 원본과 같은지 확인한 뒤에만 저장한다.
// ---------------------------------------------------------------------------

type Prim = string | number | null;

type PackedV2 = {
  f: 2;
  n: number;
  /** 문자열 사전 */
  s: string[];
  /** 상수 컬럼 */
  k: Record<string, Prim>;
  /** 변하는 컬럼 */
  c: Record<string, Prim[]>;
};

const STRING_COLS = [
  ["t", "dealType"],
  ["a", "aptName"],
  ["g", "gu"],
  ["dn", "dong"],
  ["j", "jibun"],
  ["dg", "dealingGbn"],
  ["rg", "rgstDate"],
  ["ad", "aptDong"],
] as const;

const NUMBER_COLS = [
  ["ea", "exclusiveArea"],
  ["am", "dealAmount"],
  ["mr", "monthlyRent"],
  ["fl", "floor"],
  ["by", "buildYear"],
] as const;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

function dayNumber(date: string): number | null {
  const m = DATE_RE.exec(date);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (!Number.isFinite(ms)) return null;
  const day = ms / DAY_MS;
  return dayString(day) === date ? day : null;
}

function dayString(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** 적재 id 규칙 (identity.ts stableTransactionId 의 2026-09 모양, 여기 고정). lawdCd 는 스냅샷 키. */
function idTemplate(tx: Transaction, lawdCd: string): string {
  return [
    tx.dealType,
    lawdCd,
    tx.dealDate.slice(0, 10),
    tx.aptName.replace(/\s+/g, ""),
    tx.dong.replace(/\s+/g, ""),
    tx.jibun.replace(/\s+/g, ""),
    String(tx.floor),
    String(tx.dealAmount),
    String(tx.monthlyRent),
    String(Math.round(tx.exclusiveArea * 100) / 100),
  ].join("-");
}

function allSame(values: Prim[]): boolean {
  for (let i = 1; i < values.length; i += 1) if (!Object.is(values[i], values[0])) return false;
  return true;
}

export function packAptTx(rows: Transaction[], lawdCd: string): string {
  const n = rows.length;
  const dict = new Map<string, number>();
  const s: string[] = [];
  const idx = (v: string | null | undefined): number => {
    if (v == null) return -1;
    let i = dict.get(v);
    if (i === undefined) {
      i = s.length;
      s.push(v);
      dict.set(v, i);
    }
    return i;
  };
  const p: PackedV2 = { f: 2, n, s, k: {}, c: {} };
  if (n === 0) return JSON.stringify(p);

  for (const [key, field] of STRING_COLS) {
    const values = rows.map((r) => (r[field] ?? null) as string | null);
    if (allSame(values)) p.k[key] = values[0];
    else p.c[key] = values.map(idx);
  }
  for (const [key, field] of NUMBER_COLS) {
    const values = rows.map((r) => r[field] as number | null);
    if (allSame(values)) p.k[key] = values[0];
    else p.c[key] = values;
  }

  // 거래일: 모두 정상 날짜면 첫 값(일수) + 차분(앞 행 - 이 행, 내림차순이라 대개 0 이상 작은 수)
  const days = rows.map((r) => dayNumber(r.dealDate));
  if (days.every((d): d is number => d != null)) {
    p.c.dd = days.map((d, i) => (i === 0 ? d : days[i - 1]! - d));
  } else {
    const values = rows.map((r) => r.dealDate);
    if (allSame(values)) p.k.d = values[0];
    else p.c.d = values.map(idx);
  }

  // id: 규칙 그대로면 0, 규칙+꼬리("~1" 등)면 "+꼬리", 아니면 "=원본"
  const ids: Prim[] = rows.map((r) => {
    const base = idTemplate(r, lawdCd);
    if (r.id === base) return 0;
    if (r.id.startsWith(base)) return `+${r.id.slice(base.length)}`;
    return `=${r.id}`;
  });
  if (allSame(ids)) p.k.id = ids[0];
  else p.c.id = ids;

  return JSON.stringify(p);
}

export function unpackAptTx(json: string, lawdCd: string): Transaction[] {
  const p = JSON.parse(json) as PackedV2;
  if (p.f !== 2) throw new Error(`${APT_TX_SNAPSHOT_TABLE}: unknown packed format ${String(p.f)}`);
  const { n, s, k, c } = p;
  const col = (key: string, i: number): Prim => (key in k ? k[key] : c[key][i]);
  const str = (key: string, i: number): string | null => {
    if (key in k) return k[key] as string | null;
    const j = c[key][i] as number;
    return j < 0 ? null : s[j];
  };
  const dd = c.dd as number[] | undefined;
  const out: Transaction[] = new Array(n);
  let day = 0;
  for (let i = 0; i < n; i += 1) {
    let dealDate: string;
    if (dd) {
      day = i === 0 ? dd[0] : day - dd[i];
      dealDate = dayString(day);
    } else {
      dealDate = str("d", i) as string;
    }
    const tx: Transaction = {
      id: "",
      dealType: str("t", i) as DealType,
      dealDate,
      aptName: str("a", i) as string,
      gu: str("g", i) as string,
      dong: str("dn", i) as string,
      exclusiveArea: col("ea", i) as number,
      dealAmount: col("am", i) as number,
      monthlyRent: col("mr", i) as number,
      floor: col("fl", i) as number,
      buildYear: col("by", i) as number | null,
      jibun: str("j", i) as string,
      dealingGbn: str("dg", i) as string,
      rgstDate: str("rg", i),
      aptDong: str("ad", i),
    };
    const code = col("id", i);
    tx.id =
      code === 0
        ? idTemplate(tx, lawdCd)
        : typeof code === "string" && code.startsWith("+")
          ? idTemplate(tx, lawdCd) + code.slice(1)
          : String(code).slice(1);
    out[i] = tx;
  }
  return out;
}

export function compressPacked(json: string): Buffer {
  const input = Buffer.from(json, "utf8");
  return brotliCompressSync(input, {
    params: {
      [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
      [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
      [zlibConstants.BROTLI_PARAM_SIZE_HINT]: input.byteLength,
    },
  });
}

export function decompressPacked(buf: Buffer): string {
  return brotliDecompressSync(buf).toString("utf8");
}

export function contentHashOf(packedJson: string): string {
  return createHash("sha256").update(packedJson).digest("hex").slice(0, 32);
}

/** 라이브 행과 디코드한 행이 키·값·순서까지 같은지 (다르면 첫 차이 설명) */
export function sameAptTxRows(a: Transaction[], b: Transaction[]): string | null {
  if (a.length !== b.length) return `length ${a.length} != ${b.length}`;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] as unknown as Record<string, unknown>;
    const y = b[i] as unknown as Record<string, unknown>;
    const kx = Object.keys(x);
    const ky = Object.keys(y);
    if (kx.join(",") !== ky.join(",")) return `row ${i} keys differ`;
    for (const key of kx) {
      if (!Object.is(x[key], y[key])) return `row ${i} ${key}: ${String(x[key])} != ${String(y[key])}`;
    }
  }
  return null;
}

function toBuffer(v: unknown): Buffer | null {
  if (v == null) return null;
  if (v instanceof ArrayBuffer) return Buffer.from(v);
  if (ArrayBuffer.isView(v)) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  return null;
}

function toSafeInt(v: unknown): number | null {
  const n = typeof v === "bigint" ? Number(v) : typeof v === "number" ? v : Number.NaN;
  return Number.isSafeInteger(n) ? n : null;
}

// ---------------------------------------------------------------------------
// 읽기 (요청 경로 — 쓰기 없음)
// ---------------------------------------------------------------------------

let readDisabledUntil = 0;
/** 트리거 4개 확인 결과 캐시 (sqlite_master 읽기를 요청마다 하지 않게). 확인 전 = 0 */
let triggersCheckedUntil = 0;
const TRIGGER_CHECK_TTL_MS = 10 * 60 * 1000;

/** 테스트 전용: 읽기 비활성·트리거 확인 캐시 초기화 */
export function resetAptTxSnapshotReadStateForTest(): void {
  readDisabledUntil = 0;
  triggersCheckedUntil = 0;
}

export function aptTxSnapshotReadEnabled(): boolean {
  if (process.env.APT_TX_SNAPSHOT_READ === "0") return false;
  return Date.now() >= readDisabledUntil;
}

const TRIGGER_COUNT_SQL = `(SELECT COUNT(*) FROM sqlite_master
   WHERE type = 'trigger' AND tbl_name = 'transactions'
     AND name IN (${TX_CHANGE_TRIGGERS.map((t) => `'${t}'`).join(", ")}))`;

/**
 * 스냅샷이 최신이면 행(ORDER BY deal_date DESC, id) 반환, 아니면 null (호출부가 라이브로).
 * 1왕복: 스냅샷 행 + 현재 단지 번호(+ 10분마다 트리거 확인)를 같은 SELECT 로.
 * 표가 없거나 오류면 5분간 시도하지 않는다(라이브만).
 */
export async function readAptTxSnapshot(
  db: Client,
  lawdCd: string,
  aptNameNorm: string,
): Promise<Transaction[] | null> {
  if (!aptTxSnapshotReadEnabled()) return null;
  const checkTriggers = Date.now() >= triggersCheckedUntil;
  let row: Record<string, unknown> | undefined;
  try {
    const cur = changeMarkSubquery({ complexes: [{ lawdCd, aptNameNorm }] });
    const rs = await db.execute({
      sql: `SELECT s.mark, s.format, s.tx_count, s.payload, ${cur.sql} AS cur_mark
                   ${checkTriggers ? `, ${TRIGGER_COUNT_SQL} AS trg` : ""}
            FROM ${APT_TX_SNAPSHOT_TABLE} s
            WHERE s.lawd_cd = ? AND s.apt_name_norm = ?`,
      args: [...cur.args, lawdCd, aptNameNorm],
    });
    row = rs.rows[0] as Record<string, unknown> | undefined;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // 표·변경 표시가 아직 없음(적재 전) → 30분, 그 밖의 오류 → 5분 동안 라이브만 (왕복 낭비 방지)
    const missing = /no such table/i.test(message);
    readDisabledUntil = Date.now() + (missing ? 30 : 5) * 60 * 1000;
    console.warn(`[apt-tx-snapshot] read failed, live fallback for ${missing ? 30 : 5}m:`, message);
    return null;
  }
  if (!row) return null;
  if (checkTriggers) {
    if (toSafeInt(row.trg) !== TX_CHANGE_TRIGGERS.length) {
      console.warn("[apt-tx-snapshot] tx change triggers missing — live fallback");
      return null;
    }
    triggersCheckedUntil = Date.now() + TRIGGER_CHECK_TTL_MS;
  }
  if (toSafeInt(row.format) !== APT_TX_SNAPSHOT_FORMAT) return null;
  const stored = toSafeInt(row.mark);
  const current = toSafeInt(row.cur_mark);
  if (stored == null || current == null || stored !== current) return null;
  const buf = toBuffer(row.payload);
  if (!buf) return null;
  try {
    const rows = unpackAptTx(decompressPacked(buf), lawdCd);
    if (rows.length !== toSafeInt(row.tx_count)) return null;
    return rows;
  } catch (err) {
    console.warn("[apt-tx-snapshot] decode failed, live fallback:", err instanceof Error ? err.message : err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// 빌드 / 갱신 (sync·스크립트 전용)
// ---------------------------------------------------------------------------

export class AptTxSnapshotAnomaly extends Error {}

export type LawdBuildStats = {
  lawdCd: string;
  /** 대상 단지 수 (전체 빌드 = lawd 안 단지, 부분 = 요청 단지) */
  apts: number;
  /** 이미 최신(mark·형식 일치)이라 읽지도 않은 단지 */
  fresh: number;
  rowsRead: number;
  inserted: number;
  updated: number;
  /** 내용이 같아 mark 만 올린 단지 */
  markOnly: number;
  deleted: number;
  /** 빌드 도중 번호가 바뀌어 저장되지 않은 단지 (다음 갱신이 다시 잡는다) */
  raced: number;
  payloadBytes: number;
  maxPayloadBytes: number;
  dryRun: boolean;
};

const FETCH_ROWS = 20_000;
const FETCH_APTS = 50;
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
const WRITE_BATCH_BYTES = 1024 * 1024;
const WRITE_BATCH_STATEMENTS = 50;
const SLOW_WRITE_MS = 5_000;

export type BuildOptions = {
  /** 이 단지들만 (없으면 lawd 전체) */
  aptNorms?: readonly string[];
  dryRun: boolean;
  /** 쓰기 묶음 사이 쉼 (ms) */
  pauseMs?: number;
  log?: (msg: string) => void;
};

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function placeholders(n: number): string {
  return new Array(n).fill("?").join(",");
}

/** 트리거 4개가 다 있는지 — 없으면 번호가 변경을 놓치므로 빌드하지 않는다. */
export async function assertTxChangeTriggers(db: Client): Promise<void> {
  const rs = await db.execute(`SELECT ${TRIGGER_COUNT_SQL} AS trg`);
  if (toSafeInt(rs.rows[0]?.trg) !== TX_CHANGE_TRIGGERS.length) {
    throw new AptTxSnapshotAnomaly(
      "transactions 변경 표시 트리거가 없음 — scripts/apply-tx-change-marks.ts --apply 먼저",
    );
  }
}

/** 단지 번호 (표시 없음 = 0). 에러는 던진다. */
async function loadMarks(
  db: Client,
  lawdCd: string,
  aptNorms: readonly string[] | null,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const add = (rows: Array<Record<string, unknown>>) => {
    for (const r of rows) {
      const seq = toSafeInt(r.seq);
      if (seq == null) throw new AptTxSnapshotAnomaly(`${lawdCd}: bad mark ${String(r.seq)}`);
      out.set(String(r.apt_name_norm), seq);
    }
  };
  if (aptNorms == null) {
    const rs = await db.execute({
      sql: `SELECT apt_name_norm, seq FROM tx_change_marks WHERE lawd_cd = ?`,
      args: [lawdCd],
    });
    add(rs.rows as unknown as Array<Record<string, unknown>>);
    return out;
  }
  for (const part of chunk(aptNorms, 200)) {
    const rs = await db.execute({
      sql: `SELECT apt_name_norm, seq FROM tx_change_marks
            WHERE lawd_cd = ? AND apt_name_norm IN (${placeholders(part.length)})`,
      args: [lawdCd, ...part],
    });
    add(rs.rows as unknown as Array<Record<string, unknown>>);
  }
  return out;
}

type ExistingSnap = { mark: number; format: number; txCount: number; contentHash: string };

async function loadExisting(
  db: Client,
  lawdCd: string,
  aptNorms: readonly string[] | null,
): Promise<Map<string, ExistingSnap>> {
  const out = new Map<string, ExistingSnap>();
  const add = (rows: Array<Record<string, unknown>>) => {
    for (const r of rows) {
      out.set(String(r.apt_name_norm), {
        mark: toSafeInt(r.mark) ?? -1,
        format: toSafeInt(r.format) ?? -1,
        txCount: toSafeInt(r.tx_count) ?? -1,
        contentHash: String(r.content_hash),
      });
    }
  };
  // 작은 컬럼만 — payload(BLOB, 행 끝)는 읽지 않는다.
  if (aptNorms == null) {
    const rs = await db.execute({
      sql: `SELECT apt_name_norm, mark, format, tx_count, content_hash
            FROM ${APT_TX_SNAPSHOT_TABLE} WHERE lawd_cd = ?`,
      args: [lawdCd],
    });
    add(rs.rows as unknown as Array<Record<string, unknown>>);
    return out;
  }
  for (const part of chunk(aptNorms, 200)) {
    const rs = await db.execute({
      sql: `SELECT apt_name_norm, mark, format, tx_count, content_hash
            FROM ${APT_TX_SNAPSHOT_TABLE}
            WHERE lawd_cd = ? AND apt_name_norm IN (${placeholders(part.length)})`,
      args: [lawdCd, ...part],
    });
    add(rs.rows as unknown as Array<Record<string, unknown>>);
  }
  return out;
}

/** lawd 안 단지별 행 수 (idx_tx_lawd_apt_ym 만 읽음) */
async function listLawdApts(db: Client, lawdCd: string): Promise<Map<string, number>> {
  const rs = await db.execute({
    sql: `SELECT apt_name_norm, COUNT(*) AS n FROM transactions WHERE lawd_cd = ? GROUP BY apt_name_norm`,
    args: [lawdCd],
  });
  const out = new Map<string, number>();
  for (const r of rs.rows) out.set(String(r.apt_name_norm), Number(r.n) || 0);
  return out;
}

/**
 * 단지들의 행을 라이브 쿼리와 같은 조건·정렬로 읽는다 (idx_tx_lawd_apt_ym, +deal_type 로 인덱스 고정).
 * 읽기 에러는 그대로 던진다 — 부분 결과를 저장하지 않는다.
 */
export async function fetchAptTxRowsForSnapshot(
  db: Client,
  lawdCd: string,
  aptNorms: readonly string[],
): Promise<Map<string, Transaction[]>> {
  const rs = await db.execute({
    sql: `SELECT apt_name_norm, ${APT_TX_SELECT_COLUMNS}
          FROM transactions
          WHERE lawd_cd = ? AND apt_name_norm IN (${placeholders(aptNorms.length)})
            AND +deal_type IN ('trade', 'rent')
          ORDER BY apt_name_norm, ${APT_TX_ORDER_BY}`,
    args: [lawdCd, ...aptNorms],
  });
  const out = new Map<string, Transaction[]>();
  for (const norm of aptNorms) out.set(norm, []);
  for (const r of rs.rows) {
    const norm = String(r.apt_name_norm);
    const list = out.get(norm);
    if (!list) throw new AptTxSnapshotAnomaly(`${lawdCd}: 요청하지 않은 단지 행 ${norm}`);
    list.push(mapAptTxRow(r as unknown as Record<string, unknown>));
  }
  return out;
}

/** 행 수 기준으로 단지를 묶는다 (한 번에 FETCH_ROWS 행·FETCH_APTS 단지 안쪽). 큰 단지는 혼자. */
function planFetchGroups(norms: readonly string[], counts: Map<string, number> | null): string[][] {
  if (!counts) return chunk(norms, 20);
  const groups: string[][] = [];
  let cur: string[] = [];
  let rows = 0;
  for (const norm of norms) {
    const n = counts.get(norm) ?? 0;
    if (cur.length > 0 && (rows + n > FETCH_ROWS || cur.length >= FETCH_APTS)) {
      groups.push(cur);
      cur = [];
      rows = 0;
    }
    cur.push(norm);
    rows += n;
  }
  if (cur.length) groups.push(cur);
  return groups;
}

type PendingWrite = { stmt: InStatement; bytes: number; kind: "insert" | "update" | "mark" | "delete" };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function flushWrites(
  db: Client,
  writes: PendingWrite[],
  stats: LawdBuildStats,
  pauseMs: number,
): Promise<void> {
  let i = 0;
  while (i < writes.length) {
    const batch: PendingWrite[] = [];
    let bytes = 0;
    while (
      i < writes.length &&
      (batch.length === 0 ||
        (batch.length < WRITE_BATCH_STATEMENTS && bytes + writes[i].bytes <= WRITE_BATCH_BYTES))
    ) {
      batch.push(writes[i]);
      bytes += writes[i].bytes;
      i += 1;
    }
    const t0 = Date.now();
    const results = await db.batch(
      batch.map((w) => w.stmt),
      "write",
    );
    const ms = Date.now() - t0;
    results.forEach((res, j) => {
      const kind = batch[j].kind;
      if (kind === "delete") {
        stats.deleted += res.rowsAffected > 0 ? 1 : 0;
      } else if (res.rowsAffected === 0) {
        stats.raced += 1;
      } else if (kind === "insert") {
        stats.inserted += 1;
      } else if (kind === "update") {
        stats.updated += 1;
      } else {
        stats.markOnly += 1;
      }
    });
    if (ms > SLOW_WRITE_MS) {
      throw new AptTxSnapshotAnomaly(
        `${stats.lawdCd}: 쓰기 묶음 ${batch.length}문장 ${(bytes / 1024).toFixed(0)}KB 가 ${ms}ms — 멈춤`,
      );
    }
    if (pauseMs > 0 && i < writes.length) await sleep(pauseMs);
  }
}

/**
 * lawd 하나(전체 또는 일부 단지)의 스냅샷을 라이브 행에서 다시 만든다.
 * 1) 단지 번호(mark)를 먼저 읽고 2) 이미 최신(저장 mark = 현재 mark, 형식 일치)인 단지는 건너뛰고
 * 3) 나머지만 행을 읽어 인코딩 왕복 확인 4) 번호가 그대로일 때만 조건부 UPSERT
 *    (내용 해시가 같으면 mark 만 UPDATE). 라이브에 행이 없는 단지는 스냅샷 행을 지운다.
 */
export async function buildAptTxSnapshotsForLawd(
  db: Client,
  lawdCd: string,
  opts: BuildOptions,
): Promise<LawdBuildStats> {
  const t0 = Date.now();
  const builtAt = new Date().toISOString();
  const subset = opts.aptNorms ? [...new Set(opts.aptNorms)].sort() : null;
  const stats: LawdBuildStats = {
    lawdCd,
    apts: 0,
    fresh: 0,
    rowsRead: 0,
    inserted: 0,
    updated: 0,
    markOnly: 0,
    deleted: 0,
    raced: 0,
    payloadBytes: 0,
    maxPayloadBytes: 0,
    dryRun: opts.dryRun,
  };

  // 드라이런은 표·트리거가 아직 없어도 계획(단지 수·크기)을 낼 수 있게
  const missingOk = <T,>(fallback: T) => (err: unknown): T => {
    if (!opts.dryRun || !/no such table/i.test(err instanceof Error ? err.message : String(err))) throw err;
    return fallback;
  };
  if (!opts.dryRun) await assertTxChangeTriggers(db);
  // 번호는 행보다 먼저 읽는다 — 그 뒤의 변경은 번호를 올려 조건부 쓰기가 막거나 읽는 쪽이 거른다.
  const marks = await loadMarks(db, lawdCd, subset).catch(missingOk(new Map<string, number>()));
  const existing = await loadExisting(db, lawdCd, subset).catch(missingOk(new Map<string, ExistingSnap>()));
  const counts = subset ? null : await listLawdApts(db, lawdCd);
  const targets = subset ?? [...counts!.keys()].sort();
  stats.apts = targets.length;

  const writes: PendingWrite[] = [];
  const markOf = (norm: string) => marks.get(norm) ?? 0;
  const stale: string[] = [];
  for (const norm of targets) {
    const prev = existing.get(norm);
    if (prev && prev.format === APT_TX_SNAPSHOT_FORMAT && prev.mark === markOf(norm)) {
      stats.fresh += 1;
      continue;
    }
    stale.push(norm);
  }
  // 전체 빌드: 스냅샷에만 있는 단지(라이브 행 0) 지우기
  if (!subset) {
    for (const norm of existing.keys()) {
      if (counts!.has(norm)) continue;
      writes.push({
        stmt: {
          sql: `DELETE FROM ${APT_TX_SNAPSHOT_TABLE} WHERE lawd_cd = ? AND apt_name_norm = ?`,
          args: [lawdCd, norm],
        },
        bytes: 100,
        kind: "delete",
      });
    }
  }

  for (const group of planFetchGroups(stale, counts)) {
    const fetched = await fetchAptTxRowsForSnapshot(db, lawdCd, group);
    for (const norm of group) {
      const rows = fetched.get(norm)!;
      stats.rowsRead += rows.length;
      const prev = existing.get(norm);
      if (rows.length === 0) {
        if (prev) {
          writes.push({
            stmt: {
              sql: `DELETE FROM ${APT_TX_SNAPSHOT_TABLE} WHERE lawd_cd = ? AND apt_name_norm = ?`,
              args: [lawdCd, norm],
            },
            bytes: 100,
            kind: "delete",
          });
        }
        continue;
      }
      const json = packAptTx(rows, lawdCd);
      const diff = sameAptTxRows(rows, unpackAptTx(json, lawdCd));
      if (diff) throw new AptTxSnapshotAnomaly(`${lawdCd} ${norm}: 인코딩 왕복 불일치 (${diff})`);
      const hash = contentHashOf(json);
      const mark = markOf(norm);
      const cond = markUnchangedCondition({ complexes: [{ lawdCd, aptNameNorm: norm }] }, mark);

      if (prev && prev.format === APT_TX_SNAPSHOT_FORMAT && prev.contentHash === hash && prev.txCount === rows.length) {
        // 내용 같음 (번호만 오른 UPDATE 등) → mark 만
        writes.push({
          stmt: {
            sql: `UPDATE ${APT_TX_SNAPSHOT_TABLE} SET mark = ?, built_at = ?
                  WHERE lawd_cd = ? AND apt_name_norm = ? AND format = ? AND content_hash = ?
                    AND ${cond.sql}`,
            args: [mark, builtAt, lawdCd, norm, APT_TX_SNAPSHOT_FORMAT, hash, ...cond.args],
          },
          bytes: 200,
          kind: "mark",
        });
        continue;
      }
      const payload = compressPacked(json);
      if (payload.byteLength > MAX_PAYLOAD_BYTES) {
        throw new AptTxSnapshotAnomaly(
          `${lawdCd} ${norm}: payload ${payload.byteLength}B > ${MAX_PAYLOAD_BYTES}B (rows=${rows.length})`,
        );
      }
      stats.payloadBytes += payload.byteLength;
      stats.maxPayloadBytes = Math.max(stats.maxPayloadBytes, payload.byteLength);
      writes.push({
        stmt: {
          sql: `INSERT INTO ${APT_TX_SNAPSHOT_TABLE}
                  (lawd_cd, apt_name_norm, mark, format, tx_count, content_hash, built_at, payload)
                SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${cond.sql}
                ON CONFLICT(lawd_cd, apt_name_norm) DO UPDATE SET
                  mark = excluded.mark,
                  format = excluded.format,
                  tx_count = excluded.tx_count,
                  content_hash = excluded.content_hash,
                  built_at = excluded.built_at,
                  payload = excluded.payload`,
          args: [lawdCd, norm, mark, APT_TX_SNAPSHOT_FORMAT, rows.length, hash, builtAt, payload, ...cond.args],
        },
        bytes: payload.byteLength + 200,
        kind: prev ? "update" : "insert",
      });
    }
  }

  let writeMs = 0;
  if (opts.dryRun) {
    for (const w of writes) {
      if (w.kind === "insert") stats.inserted += 1;
      else if (w.kind === "update") stats.updated += 1;
      else if (w.kind === "mark") stats.markOnly += 1;
      else stats.deleted += 1;
    }
  } else if (writes.length > 0) {
    const tw = Date.now();
    await flushWrites(db, writes, stats, opts.pauseMs ?? 1000);
    writeMs = Date.now() - tw;
  }
  opts.log?.(
    `[apt-tx-snapshot] ${lawdCd}${subset ? ` subset=${subset.length}` : ""} apts=${stats.apts} fresh=${stats.fresh} rows=${stats.rowsRead} ins=${stats.inserted} upd=${stats.updated} markOnly=${stats.markOnly} del=${stats.deleted} raced=${stats.raced} payload=${(stats.payloadBytes / 1024 / 1024).toFixed(2)}MB max=${(stats.maxPayloadBytes / 1024).toFixed(0)}KB ms=${Date.now() - t0} writeMs=${writeMs}${opts.dryRun ? " DRY-RUN" : ""}`,
  );
  return stats;
}

/** 갱신 기준 번호 (snapshot_watermark). 없으면 null = 초기 적재 전. */
export async function readAptTxSnapshotWatermark(db: Client): Promise<number | null> {
  const rs = await db.execute({
    sql: `SELECT synced_through FROM snapshot_watermark WHERE family = ?`,
    args: [APT_TX_SNAPSHOT_WM_FAMILY],
  });
  const v = rs.rows[0]?.synced_through;
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 0) throw new AptTxSnapshotAnomaly(`bad watermark ${String(v)}`);
  return n;
}

/** 갱신 기준 번호 저장. 더 큰 값으로만 올린다. */
export async function writeAptTxSnapshotWatermark(db: Client, seq: number): Promise<void> {
  await db.execute({
    sql: `INSERT INTO snapshot_watermark (family, synced_through, built_at)
          VALUES (?, ?, ?)
          ON CONFLICT(family) DO UPDATE SET
            synced_through = excluded.synced_through,
            built_at = excluded.built_at
          WHERE CAST(snapshot_watermark.synced_through AS INTEGER) < CAST(excluded.synced_through AS INTEGER)`,
    args: [APT_TX_SNAPSHOT_WM_FAMILY, String(seq), new Date().toISOString()],
  });
}

export type RefreshResult = {
  skipped?: string;
  /** 기준 번호 뒤에 바뀐 단지 수 (목록 시점) */
  changed: number;
  /** 이번 실행에서 빌드까지 끝낸 단지 수 */
  processed: number;
  /** 돌린 묶음 수 */
  batches: number;
  lawds: number;
  failedLawds: string[];
  /** 이번 실행 한도(maxComplexes·deadline)로 남긴 단지 수 — 다음 실행이 커서부터 이어서 한다 */
  deferred: number;
  /**
   * from = 시작 기준 번호. cursor = 여기까지 반영했다고 말할 수 있는 번호(드라이런에서도 계산).
   * to = 실제로 저장한 기준 번호 (드라이런·전진 없음이면 null).
   */
  watermark: { from: number; cursor: number; to: number | null };
  stats: LawdBuildStats[];
};

export type RefreshOptions = {
  dryRun?: boolean;
  /** 이번 실행에서 처리할 최대 단지 수 (기본 5000). 넘치면 다음 실행이 커서부터 이어서. */
  maxComplexes?: number;
  /** 묶음 크기 (기본 500 단지). 묶음이 끝날 때마다 기준 번호를 올린다. */
  batchSize?: number;
  /** 이 시각(epoch ms)이 지나면 새 묶음을 시작하지 않는다 */
  deadlineAt?: number;
  pauseMs?: number;
  log?: (msg: string) => void;
};

/**
 * 바뀐 단지 목록(번호 오름차순)을 묶음으로 나눈다. 같은 번호는 한 묶음에 둔다 —
 * 묶음 끝 번호까지 기준 번호를 올릴 때 같은 번호의 단지가 다음 묶음에 남아 건너뛰어지지 않게.
 */
export function planRefreshBatches<T extends { seq: number }>(sorted: readonly T[], batchSize: number): T[][] {
  const size = Math.max(1, Math.floor(batchSize) || 1);
  const out: T[][] = [];
  let cur: T[] = [];
  for (const item of sorted) {
    if (cur.length >= size && cur[cur.length - 1].seq !== item.seq) {
      out.push(cur);
      cur = [];
    }
    cur.push(item);
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * 일일 sync 끝(또는 스크립트)에서: 기준 번호 뒤에 바뀐 단지만 다시 만든다. 커서 방식.
 * - 초기 적재 전(기준 번호 없음)이면 건너뛴다 — 요청 경로는 단지 번호로 거르므로 여전히 안전.
 * - 트리거 4개가 없으면 에러(번호가 변경을 놓치므로 믿을 수 없다).
 * - 바뀐 단지를 번호 오름차순으로 묶음(batchSize)마다 빌드하고, 묶음이 다 끝나면 기준 번호를
 *   그 묶음의 마지막 번호로 올린다. 한도(maxComplexes·deadline)에 걸리면 거기서 멈추고
 *   다음 실행이 그 번호부터 이어서 한다 — 바뀐 단지가 한도보다 많아도 같은 앞부분만 되풀이하지 않는다.
 * - 묶음 안에서 실패한 lawd 가 있으면: 실패(또는 멈춤으로 못 돈) 단지 중 가장 작은 번호 - 1 까지만 올리고 멈춘다.
 *   그보다 작은 번호의 단지는 모두 끝났으므로 안전하다.
 * - 목록을 다 끝내면 max(마지막 번호, 시작 때 읽은 전역 번호)로 올린다.
 * - 번호를 올려도 되는 이유: 목록 뒤의 변경·도중 경합(raced)은 목록의 어떤 번호보다 큰 새 번호를 받아
 *   다음 목록에 다시 나온다.
 * - 번호 표(tx_change_marks)는 seq 인덱스가 없어 표 전체(단지 수만큼)를 한 번 읽는다.
 */
export async function refreshAptTxSnapshots(db: Client, opts: RefreshOptions = {}): Promise<RefreshResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const dryRun = opts.dryRun === true;
  const maxComplexes = opts.maxComplexes ?? 5000;
  const batchSize = opts.batchSize ?? 500;

  const from = await readAptTxSnapshotWatermark(db);
  if (from == null) {
    return {
      skipped: "no watermark (초기 적재 전)",
      changed: 0,
      processed: 0,
      batches: 0,
      lawds: 0,
      failedLawds: [],
      deferred: 0,
      watermark: { from: -1, cursor: -1, to: null },
      stats: [],
    };
  }
  await assertTxChangeTriggers(db);
  const seqNow = await readGlobalChangeSeq(db);
  if (seqNow === from) {
    return {
      changed: 0,
      processed: 0,
      batches: 0,
      lawds: 0,
      failedLawds: [],
      deferred: 0,
      watermark: { from, cursor: from, to: null },
      stats: [],
    };
  }
  const changed = (await listChangedComplexesSince(db, from)).sort((a, b) => a.seq - b.seq);
  const batches = planRefreshBatches(changed, batchSize);

  let cursor = from;
  let written: number | null = null;
  let processed = 0;
  let batchesRun = 0;
  let stopped = false;
  const lawdsSeen = new Set<string>();
  const stats: LawdBuildStats[] = [];
  const failedLawds: string[] = [];

  const advance = async (to: number) => {
    if (!Number.isSafeInteger(to) || to <= cursor) return;
    cursor = to;
    if (!dryRun) {
      await writeAptTxSnapshotWatermark(db, to);
      written = to;
    }
  };

  for (const batch of batches) {
    // 한도: 첫 묶음은 항상 돈다(묶음 하나가 한도보다 커도 진행은 해야 하므로)
    if (batchesRun > 0 && processed + batch.length > maxComplexes) break;
    if (batchesRun > 0 && opts.deadlineAt != null && Date.now() >= opts.deadlineAt) break;
    batchesRun += 1;

    const byLawd = new Map<string, string[]>();
    for (const c of batch) {
      let list = byLawd.get(c.lawdCd);
      if (!list) byLawd.set(c.lawdCd, (list = []));
      list.push(c.aptNameNorm);
    }
    const notDone = new Set<string>(byLawd.keys());
    let halt = false;
    for (const [lawd, norms] of byLawd) {
      lawdsSeen.add(lawd);
      try {
        stats.push(
          await buildAptTxSnapshotsForLawd(db, lawd, { aptNorms: norms, dryRun, pauseMs: opts.pauseMs, log }),
        );
        notDone.delete(lawd);
      } catch (err) {
        failedLawds.push(lawd);
        log(
          `[apt-tx-snapshot] refresh ${lawd} failed (요청 경로는 라이브 폴백): ${err instanceof Error ? err.message : String(err)}`,
        );
        if (err instanceof AptTxSnapshotAnomaly && /멈춤/.test(err.message)) {
          halt = true;
          break;
        }
      }
    }

    if (notDone.size === 0) {
      processed += batch.length;
      await advance(batch[batch.length - 1].seq);
      log(`[apt-tx-snapshot] refresh batch ${batchesRun}/${batches.length} ok — cursor ${cursor}`);
      continue;
    }
    // 실패·못 돈 lawd 단지 중 가장 작은 번호 앞까지만 (그보다 작은 번호는 전부 끝남)
    let minPending = Number.POSITIVE_INFINITY;
    for (const c of batch) {
      if (notDone.has(c.lawdCd)) minPending = Math.min(minPending, c.seq);
      else processed += 1;
    }
    await advance(minPending - 1);
    stopped = true;
    log(`[apt-tx-snapshot] refresh stopped${halt ? " (쓰기 느림)" : ""} — cursor ${cursor}`);
    break;
  }

  if (!stopped && batchesRun === batches.length) await advance(Math.max(cursor, seqNow));
  const deferred = stopped ? 0 : batches.slice(batchesRun).reduce((acc, b) => acc + b.length, 0);
  return {
    changed: changed.length,
    processed,
    batches: batchesRun,
    lawds: lawdsSeen.size,
    failedLawds,
    deferred,
    watermark: { from, cursor, to: written },
    stats,
  };
}

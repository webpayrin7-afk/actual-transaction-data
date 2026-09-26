/**
 * 단지 비교 후보(complex-compare-peers) 2단계 — 후보 단지별 매매 (면적, 준공연도, 건수) 집계 스냅샷.
 *
 * 라이브 쿼리(select-compare-peers)는 후보 30개 단지의 매매 행 수천 개를 콜드로 흩어 읽는다
 * (로컬 콜드 1~3s). 같은 집계를 apt_trade_area_stats 에 (lawd_cd, apt_name_norm, gu) 한 행씩
 * JSON 으로 둔다. 읽는 쪽은 라이브와 같은 범위(lawd_cd IN 구 코드 · apt_name_norm IN 후보 · gu = ?)
 * 로 읽고 JS 에서 라이브 쿼리와 같은 순서(GROUP BY 키 순 → c DESC 안정 정렬)로 400개를 자른다.
 *
 * 신선도(법정동코드별): apt_trade_area_stats_marks.seq = 그 코드의 스냅샷을 다 맞춘 때의
 * 거래 변경 번호(src/lib/db/snapshot-freshness.ts, transactions 트리거가 올림).
 * 읽을 때 구의 모든 코드에 대해 저장 번호 = 현재 번호일 때만 스냅샷을 쓴다. 하나라도 다르거나,
 * 번호 행이 없거나(갱신 중엔 seq 를 NULL 로 둔다), 표가 없어 읽기 에러면 라이브로 간다.
 * 스냅샷 행·번호·현재 번호는 한 문장(UNION ALL)으로 읽어 같은 시점을 본다.
 * 갱신은 peer-area-stats-refresh.ts (동기화 뒤 sync-molit 이 부른다).
 */
import type { InStatement, InValue, Row } from "@libsql/client";
import { changeMarkSubquery, isMarkCurrent } from "@/lib/db/snapshot-freshness";

/** 라이브 쿼리의 LIMIT 과 같아야 한다. */
export const PEER_AREA_ROW_LIMIT = 400;

export const PEER_AREA_STATS_DDL = `
CREATE TABLE IF NOT EXISTS apt_trade_area_stats (
  lawd_cd TEXT NOT NULL,
  apt_name_norm TEXT NOT NULL,
  gu TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  built_at TEXT NOT NULL,
  stats_json TEXT NOT NULL,
  PRIMARY KEY (lawd_cd, apt_name_norm, gu)
);
CREATE TABLE IF NOT EXISTS apt_trade_area_stats_marks (
  lawd_cd TEXT PRIMARY KEY,
  seq INTEGER,
  base_seq INTEGER NOT NULL,
  built_at TEXT NOT NULL
);
`;

/** [exclusive_area, build_year, c] — build_year 는 DB 값 그대로(NULL 포함). */
export type AreaStatTuple = [number, number | string | null, number];

/** 라이브 쿼리 한 행과 같은 모양. */
export type PeerAreaRow = {
  aptNameNorm: string;
  exclusiveArea: number;
  buildYear: number | string | null;
  c: number;
};

// ---------------------------------------------------------------------------
// SQLite 정렬 규칙 흉내 — NULL < 숫자 < 문자열(BINARY)
// ---------------------------------------------------------------------------

function typeRank(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === "number" || typeof v === "bigint") return 1;
  return 2;
}

function compareBinary(a: string, b: string): number {
  // BINARY collation = UTF-8 바이트 순 = 코드포인트 순(UTF-16 단위 비교는 서로게이트에서 어긋남).
  if (a === b) return 0;
  const ai = a[Symbol.iterator]();
  const bi = b[Symbol.iterator]();
  for (;;) {
    const x = ai.next();
    const y = bi.next();
    if (x.done && y.done) return 0;
    if (x.done) return -1;
    if (y.done) return 1;
    const cx = x.value.codePointAt(0)!;
    const cy = y.value.codePointAt(0)!;
    if (cx !== cy) return cx < cy ? -1 : 1;
  }
}

export function compareSqlValue(a: unknown, b: unknown): number {
  const ra = typeRank(a);
  const rb = typeRank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) return 0;
  if (ra === 1) {
    const na = Number(a);
    const nb = Number(b);
    return na === nb ? 0 : na < nb ? -1 : 1;
  }
  return compareBinary(String(a), String(b));
}

/**
 * 라이브 쿼리
 *   GROUP BY apt_name_norm, exclusive_area, build_year ORDER BY c DESC LIMIT 400
 * 와 같은 행·같은 순서. SQLite 는 GROUP BY 결과를 그룹 키 순으로 내고, ORDER BY … LIMIT 정렬은
 * 삽입 순서를 동률 판정에 쓴다(안정). 여러 lawd_cd 행은 (단지, 면적, 준공연도)로 건수를 합친다.
 */
export function rankPeerAreaRows(
  stored: Array<{ aptNameNorm: string; tuples: AreaStatTuple[] }>,
  limit = PEER_AREA_ROW_LIMIT,
): PeerAreaRow[] {
  const merged = new Map<string, PeerAreaRow>();
  for (const { aptNameNorm, tuples } of stored) {
    for (const [area, by, c] of tuples) {
      const key = JSON.stringify([aptNameNorm, area, by]);
      const prev = merged.get(key);
      if (prev) prev.c += c;
      else merged.set(key, { aptNameNorm, exclusiveArea: area, buildYear: by, c });
    }
  }
  const rows = [...merged.values()];
  rows.sort(
    (a, b) =>
      compareBinary(a.aptNameNorm, b.aptNameNorm) ||
      compareSqlValue(a.exclusiveArea, b.exclusiveArea) ||
      compareSqlValue(a.buildYear, b.buildYear),
  );
  // Array.prototype.sort 는 안정 정렬(ES2019+)
  rows.sort((a, b) => b.c - a.c);
  return rows.slice(0, limit);
}

export function parseStatsJson(raw: unknown): AreaStatTuple[] | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return null;
    const out: AreaStatTuple[] = [];
    for (const t of v) {
      if (!Array.isArray(t) || t.length !== 3) return null;
      const [area, by, c] = t as unknown[];
      if (typeof area !== "number" || typeof c !== "number") return null;
      if (by != null && typeof by !== "number" && typeof by !== "string") return null;
      out.push([area, (by ?? null) as number | string | null, c]);
    }
    return out;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 읽기
// ---------------------------------------------------------------------------

/**
 * 스냅샷 한 문장. 행 종류(kind):
 * - 's' 스냅샷 행 (apt_name_norm, stats_json)
 * - 'n' 이 문장이 본 후보 단지명 (normsSql 결과) — 카탈로그 쿼리와 동률 순서가 달라 빠진 후보를 가려낸다
 * - 'm' 법정동코드별 [저장 번호, 현재 번호]
 * norms: 후보 단지명을 내는 서브쿼리(이때만 'n' 행이 붙는다) 또는 단지명 목록.
 */
export type PeerNormsSource =
  | { subquery: string; args: InValue[] }
  | { list: string[] };

export function peerAreaSnapshotStatement(
  lawdCodes: string[],
  gu: string,
  norms: PeerNormsSource,
): InStatement {
  if (lawdCodes.length === 0) throw new Error("peerAreaSnapshotStatement: no lawd codes");
  const codePh = lawdCodes.map(() => "?").join(",");
  const normsSql =
    "subquery" in norms ? norms.subquery : norms.list.map(() => "?").join(",");
  const normsArgs: InValue[] = "subquery" in norms ? norms.args : norms.list;
  if (normsArgs.length === 0 && !("subquery" in norms)) {
    throw new Error("peerAreaSnapshotStatement: empty norms");
  }
  const seenPart =
    "subquery" in norms
      ? `SELECT 'n', apt_name_norm, NULL, NULL, NULL, NULL FROM (${norms.subquery})
          UNION ALL
          `
      : "";
  const seenArgs: InValue[] = "subquery" in norms ? norms.args : [];
  const markParts: string[] = [];
  const markArgs: InValue[] = [];
  for (const code of lawdCodes) {
    const cur = changeMarkSubquery({ lawds: [code] });
    markParts.push(
      `SELECT 'm', NULL, NULL, ?,
         (SELECT seq FROM apt_trade_area_stats_marks WHERE lawd_cd = ?),
         ${cur.sql}`,
    );
    markArgs.push(code, code, ...cur.args);
  }
  return {
    sql: `SELECT 's' AS kind, apt_name_norm, stats_json, NULL AS lawd_cd,
                 NULL AS stored_seq, NULL AS cur_seq
          FROM apt_trade_area_stats
          WHERE lawd_cd IN (${codePh})
            AND gu = ?
            AND apt_name_norm IN (${normsSql})
          UNION ALL
          ${seenPart}${markParts.join("\n          UNION ALL\n          ")}`,
    args: [...lawdCodes, gu, ...normsArgs, ...seenArgs, ...markArgs],
  };
}

export type PeerAreaSnapshotRead = {
  /** 모든 코드가 저장 번호 = 현재 번호 */
  fresh: boolean;
  /** 코드별 저장 번호(비교용) — fresh 일 때만 의미 있음 */
  marks: Map<string, number>;
  statRows: Row[];
  /** 'n' 행: 문장의 서브쿼리가 본 후보 단지명 */
  seenNorms: Set<string>;
};

/** 문장 결과를 나눈다. 번호가 없거나 이상하면 fresh=false. */
export function splitPeerAreaSnapshot(
  rows: Row[],
  lawdCodes: string[],
): PeerAreaSnapshotRead {
  const marks = new Map<string, number>();
  const statRows: Row[] = [];
  const seenNorms = new Set<string>();
  let fresh = true;
  const seenCodes = new Set<string>();
  for (const row of rows) {
    const kind = row.kind;
    if (kind === "s") {
      statRows.push(row);
    } else if (kind === "n") {
      if (row.apt_name_norm != null) seenNorms.add(String(row.apt_name_norm));
    } else if (kind === "m") {
      const code = String(row.lawd_cd ?? "");
      seenCodes.add(code);
      if (row.stored_seq == null || !isMarkCurrent(row.stored_seq, row.cur_seq)) {
        fresh = false;
        continue;
      }
      marks.set(code, Number(row.stored_seq));
    }
  }
  for (const code of lawdCodes) if (!seenCodes.has(code)) fresh = false;
  return { fresh, marks, statRows, seenNorms };
}

/** 두 번 읽은 번호가 같은가(두 번째 읽기가 갱신 뒤 행을 섞지 않게). */
export function sameMarks(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

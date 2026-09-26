/**
 * 지도 단지 최근 거래 스냅샷 — map_complex_recent.
 *
 * 지도 단지 마커는 단지마다 최근 18개월 매매·전월세 거래를 읽는다. 13M 행 거래 표에서 수백 단지의 흩어진 행을
 * 콜드로 읽으면 느려서, 단지별 최근 거래(반년 단위로 끊은 18~24개월, 모든 유형·면적)를 한 행(JSON)으로 미리 모아 둔다.
 * 지도는 이 행을 읽어 예전 쿼리와 똑같은 조건(year_month ≥ since, 유형·cut12, 면적 범위, 금액 > 0)을 JS 에서 건다.
 * 저장분이 더 길어도 읽을 때 걸러지므로 결과는 같다. 행 안 순서도 예전 쿼리(인덱스) 순서 — (year_month, rowid).
 *
 * 신선도: transactions 변경 표시(tx_change_marks, src/lib/db/snapshot-freshness.ts).
 * - 단지 행마다 만들 때 본 그 단지의 변경 번호(tx_mark)를 적는다. 번호는 거래를 읽기 전에 읽고,
 *   저장은 "번호가 아직 같을 때만" 조건부 쓰기 — 계산 도중 바뀌었으면 저장되지 않는다.
 * - 읽을 때 같은 SELECT 에서 현재 번호를 같이 읽어(1왕복) 저장 번호와 같은 단지만 스냅샷을 쓴다.
 *   다르거나, 행이 없거나, 형식·창이 맞지 않거나, 읽기 에러(변경 표시 표가 아직 없음 포함)면 그 단지는 예전 쿼리.
 * 갱신: 거래 동기화 끝에 refreshMapComplexRecent({ mode: "stale" }) — 바뀐 시군구의 바뀐 단지만 다시 읽고,
 *   내용이 같으면 번호만, 달라졌으면 행을 쓴다.
 */
import { createHash } from "node:crypto";
import type { Client, InStatement } from "@libsql/client";
import { isMarkCurrent, markUnchangedCondition } from "@/lib/db/snapshot-freshness";

export const MAP_RECENT_TABLE = "map_complex_recent";
export const MAP_RECENT_STATE_TABLE = "map_complex_recent_state";
/** 저장 형식 버전 — 바꾸면 행이 맞지 않아 예전 쿼리로 읽고, 다음 갱신 때 다시 만든다 */
export const MAP_RECENT_FORMAT = 1;

/** 표 만들기 + 더하기만 하는 열 추가 (이미 있으면 건너뜀). 표를 지우거나 열을 바꾸지 않는다. */
const MAP_RECENT_DDL = [
  `CREATE TABLE IF NOT EXISTS ${MAP_RECENT_TABLE} (
    lawd_cd TEXT NOT NULL,
    apt_name_norm TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    built_at TEXT NOT NULL,
    deals_json TEXT NOT NULL,
    PRIMARY KEY (lawd_cd, apt_name_norm)
  )`,
  `CREATE TABLE IF NOT EXISTS ${MAP_RECENT_STATE_TABLE} (
    lawd_cd TEXT PRIMARY KEY,
    format INTEGER NOT NULL,
    window_from TEXT NOT NULL,
    synced_max TEXT,
    built_at TEXT NOT NULL,
    row_count INTEGER NOT NULL
  )`,
];
const MAP_RECENT_ADD_COLUMNS: Array<[table: string, column: string, type: string]> = [
  [MAP_RECENT_TABLE, "tx_mark", "INTEGER"],
  [MAP_RECENT_TABLE, "window_from", "TEXT"],
  [MAP_RECENT_TABLE, "format", "INTEGER"],
  [MAP_RECENT_STATE_TABLE, "tx_mark", "INTEGER"],
];

/** 스냅샷에서 읽은 거래 한 건 — 예전 쿼리 행과 같은 값 */
export type RecentDeal = {
  dealType: "trade" | "rent";
  yearMonth: string;
  amount: number;
  rent: number;
  date: string;
  area: number;
  buildYear: number | null;
  floor: number | null;
  gbn: string | null;
};

/**
 * 저장 형식 — {"g":[거래구분 사전],"d":[[유형(0매매,1전월세), 금액, 월세, 계약일, 전용면적, 건축년도|null, 층|null, 구분 번호|-1, (계약일 월과 다를 때만) year_month]]}
 */
type Packed = { g: string[]; d: Array<[0 | 1, number, number, string, number, number | null, number | null, number, string?]> };

/** 저장 창 시작 — 18개월 전 달을 1월·7월로 내림. 반년에 한 번만 바뀌어 달이 바뀔 때마다 모든 행을 다시 쓰지 않는다. */
export function mapRecentWindowFrom(now = new Date()): string {
  const d = new Date(now);
  d.setMonth(d.getMonth() - 18);
  const m = d.getMonth() + 1 >= 7 ? 7 : 1;
  return `${d.getFullYear()}${String(m).padStart(2, "0")}`;
}

function decode(json: string): RecentDeal[] {
  const p = JSON.parse(json) as Packed;
  return p.d.map((t) => ({
    dealType: t[0] === 0 ? "trade" : "rent",
    yearMonth: t[8] ?? `${t[3].slice(0, 4)}${t[3].slice(5, 7)}`,
    amount: t[1],
    rent: t[2],
    date: t[3],
    area: t[4],
    buildYear: t[5],
    floor: t[6],
    gbn: t[7] >= 0 ? p.g[t[7]]! : null,
  }));
}

/**
 * 한 시군구 단지들의 스냅샷 (1왕복, PK + 변경 표시 PK 조인).
 * 결과에 있는 이름 = 지금도 최신인 단지. 없는 이름은 호출하는 쪽이 예전 쿼리로 읽는다.
 * 에러(표 없음 포함)는 그대로 던진다 — 호출하는 쪽이 예전 쿼리로.
 * ignoreMarks 는 검증 스크립트 전용(저장 내용과 예전 쿼리 비교) — 형식·창·번호를 보지 않고 저장 내용을 그대로 쓴다.
 * 요청 경로에서 쓰지 않는다.
 */
export async function readMapRecentDeals(
  db: Client,
  lawd: string,
  names: string[],
  since: string,
  opts: { ignoreMarks?: boolean } = {},
): Promise<Map<string, RecentDeal[]>> {
  const out = new Map<string, RecentDeal[]>();
  if (!names.length) return out;
  const res = await db.execute({
    sql: opts.ignoreMarks
      ? `SELECT r.apt_name_norm, r.deals_json FROM ${MAP_RECENT_TABLE} r
         WHERE r.lawd_cd = ? AND r.apt_name_norm IN (${names.map(() => "?").join(",")})`
      : `SELECT r.apt_name_norm, r.deals_json, r.tx_mark, r.window_from, r.format, COALESCE(c.seq, 0) AS cur_mark
          FROM ${MAP_RECENT_TABLE} r
          LEFT JOIN tx_change_marks c ON c.lawd_cd = r.lawd_cd AND c.apt_name_norm = r.apt_name_norm
          WHERE r.lawd_cd = ? AND r.apt_name_norm IN (${names.map(() => "?").join(",")})`,
    args: [lawd, ...names],
  });
  for (const r of res.rows) {
    if (!opts.ignoreMarks) {
      if (r.format == null || Number(r.format) !== MAP_RECENT_FORMAT) continue;
      if (r.window_from == null || String(r.window_from) > since) continue;
      if (!isMarkCurrent(r.tx_mark, r.cur_mark)) continue;
    }
    out.set(String(r.apt_name_norm), decode(String(r.deals_json)));
  }
  return out;
}

/* ───────────── 만들기·갱신 (동기화·수동 스크립트 전용) ───────────── */

function pack(rows: Array<Record<string, unknown>>): string {
  const g: string[] = [];
  const gi = new Map<string, number>();
  const d: Packed["d"] = [];
  for (const r of rows) {
    const amount = Number(r.deal_amount);
    if (!(amount > 0)) continue; // 지도는 금액 0 이하 거래를 쓰지 않는다
    const date = String(r.deal_date);
    const ym = String(r.year_month);
    let idx = -1;
    if (r.dealing_gbn != null) {
      const s = String(r.dealing_gbn);
      idx = gi.get(s) ?? -1;
      if (idx < 0) {
        idx = g.length;
        g.push(s);
        gi.set(s, idx);
      }
    }
    const by = r.build_year == null ? null : Number(r.build_year);
    const t: Packed["d"][number] = [
      r.deal_type === "trade" ? 0 : 1,
      amount,
      Number(r.monthly_rent) || 0,
      date,
      Number(r.exclusive_area),
      by,
      r.floor == null ? null : Number(r.floor),
      idx,
    ];
    if (`${date.slice(0, 4)}${date.slice(5, 7)}` !== ym) t.push(ym);
    d.push(t);
  }
  return JSON.stringify({ g, d });
}

const NAMES_PER_READ = 40;
const READ_CONCURRENCY = 4;
const WRITE_CONCURRENCY = 4;
/** 쓰기 N개마다 잠깐 쉰다 — 같은 DB 를 쓰는 다른 작업에 양보 */
const WRITES_PER_PAUSE = 200;
const PAUSE_MS = 1000;
/** 한 문장이 이보다 오래 걸리면 멈춘다 (DB 가 바쁨) */
const SLOW_STATEMENT_MS = 5000;

export class MapRecentSlowWriteError extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type MapRecentLawdResult = {
  lawd: string;
  names: number;
  /** 다시 읽은 단지 (행 없음·형식/창 다름·번호 다름) */
  targets: number;
  written: number;
  markOnly: number;
  skippedChanged: number;
  deleted: number;
  unchanged: number;
  bytes: number;
};

type WriteCounter = { n: number };

async function runWrites(db: Client, writes: InStatement[], counter: WriteCounter): Promise<number[]> {
  const affected: number[] = [];
  for (let i = 0; i < writes.length; i += WRITE_CONCURRENCY) {
    const slice = writes.slice(i, i + WRITE_CONCURRENCY);
    const results = await Promise.all(
      slice.map(async (w) => {
        const t = Date.now();
        const r = await db.execute(w);
        const ms = Date.now() - t;
        if (ms > SLOW_STATEMENT_MS) throw new MapRecentSlowWriteError(`map_complex_recent write took ${ms}ms — stop`);
        return r.rowsAffected;
      }),
    );
    affected.push(...results);
    const before = counter.n;
    counter.n += slice.length;
    if (Math.floor(counter.n / WRITES_PER_PAUSE) > Math.floor(before / WRITES_PER_PAUSE)) await sleep(PAUSE_MS);
  }
  return affected;
}

/**
 * 시군구 하나 — 번호가 달라진(또는 행이 없는) 단지만 거래를 다시 읽는다.
 * 내용 해시가 같으면 번호만 고치고, 다르면 행을 쓴다. 둘 다 "번호가 아직 같을 때만" 조건부.
 * 읽기 에러는 그대로 던진다 — 부분 결과를 저장하지 않는다.
 */
export async function rebuildMapRecentLawd(
  db: Client,
  lawd: string,
  opts: { dryRun?: boolean; now?: Date; counter?: WriteCounter } = {},
): Promise<MapRecentLawdResult> {
  const windowFrom = mapRecentWindowFrom(opts.now);
  const counter = opts.counter ?? { n: 0 };
  // 변경 번호를 거래보다 먼저 읽는다 — 표가 없으면 여기서 에러(스냅샷을 만들지 않는다).
  const [marksRes, masterRes, existingRes] = await Promise.all([
    db.execute({ sql: "SELECT apt_name_norm, seq FROM tx_change_marks WHERE lawd_cd = ?", args: [lawd] }),
    db.execute({ sql: "SELECT DISTINCT apt_name_norm FROM apt_complex_master WHERE lawd_cd = ?", args: [lawd] }),
    db
      .execute({
        sql: `SELECT apt_name_norm, content_hash, tx_mark, window_from, format FROM ${MAP_RECENT_TABLE} WHERE lawd_cd = ?`,
        args: [lawd],
      })
      .catch((error: unknown) => {
        // dry-run 은 표·열을 만들지 않는다 — 아직 없으면 모두 새로 쓸 행
        if (opts.dryRun && /no such (table|column)/i.test(String(error))) return { rows: [] as Array<Record<string, unknown>> };
        throw error;
      }),
  ]);
  const marks = new Map(marksRes.rows.map((r) => [String(r.apt_name_norm), Number(r.seq)]));
  const lawdMark = marksRes.rows.reduce((m, r) => Math.max(m, Number(r.seq)), 0);
  const markOf = (name: string) => marks.get(name) ?? 0;
  const names = masterRes.rows.map((r) => String(r.apt_name_norm)).sort();
  const existing = new Map(existingRes.rows.map((r) => [String(r.apt_name_norm), r]));

  const targets = names.filter((n) => {
    const e = existing.get(n);
    if (!e) return true;
    if (e.format == null || Number(e.format) !== MAP_RECENT_FORMAT) return true;
    if (e.window_from == null || String(e.window_from) !== windowFrom) return true;
    return !isMarkCurrent(e.tx_mark, markOf(n));
  });

  // 지도 쿼리와 같은 인덱스(idx_tx_lawd_apt_ym)로 — 단지별 (year_month, rowid) 순서가 지도 쿼리와 같다.
  const byName = new Map<string, Array<Record<string, unknown>>>();
  const reads: Array<Promise<void>> = [];
  for (let i = 0; i < targets.length; i += NAMES_PER_READ) {
    const slice = targets.slice(i, i + NAMES_PER_READ);
    reads.push(
      db
        .execute({
          sql: `SELECT rowid AS rid, apt_name_norm, deal_type, deal_amount, monthly_rent, deal_date, year_month,
                       exclusive_area, build_year, dealing_gbn, floor
                FROM transactions
                WHERE lawd_cd = ? AND apt_name_norm IN (${slice.map(() => "?").join(",")}) AND year_month >= ?`,
          args: [lawd, ...slice, windowFrom],
        })
        .then((res) => {
          for (const r of res.rows) {
            const k = String(r.apt_name_norm);
            const list = byName.get(k) ?? [];
            list.push(r as unknown as Record<string, unknown>);
            byName.set(k, list);
          }
        }),
    );
    if (reads.length >= READ_CONCURRENCY) await Promise.all(reads.splice(0));
  }
  await Promise.all(reads);

  const builtAt = new Date().toISOString();
  const writes: InStatement[] = [];
  let written = 0;
  let markOnly = 0;
  let bytes = 0;
  for (const name of targets) {
    const rows = (byName.get(name) ?? []).sort((a, b) => {
      const ya = String(a.year_month);
      const yb = String(b.year_month);
      return ya < yb ? -1 : ya > yb ? 1 : Number(a.rid) - Number(b.rid);
    });
    const json = pack(rows);
    const hash = createHash("sha1").update(json).digest("hex");
    const mark = markOf(name);
    const cond = markUnchangedCondition({ complexes: [{ lawdCd: lawd, aptNameNorm: name }] }, mark);
    const e = existing.get(name);
    if (e && String(e.content_hash) === hash) {
      markOnly += 1;
      writes.push({
        sql: `UPDATE ${MAP_RECENT_TABLE} SET tx_mark = ?, window_from = ?, format = ?, built_at = ?
              WHERE lawd_cd = ? AND apt_name_norm = ? AND ${cond.sql}`,
        args: [mark, windowFrom, MAP_RECENT_FORMAT, builtAt, lawd, name, ...cond.args],
      });
      continue;
    }
    written += 1;
    bytes += json.length;
    writes.push({
      sql: `INSERT INTO ${MAP_RECENT_TABLE} (lawd_cd, apt_name_norm, content_hash, built_at, deals_json, tx_mark, window_from, format)
            SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${cond.sql}
            ON CONFLICT(lawd_cd, apt_name_norm) DO UPDATE SET
              content_hash = excluded.content_hash, built_at = excluded.built_at, deals_json = excluded.deals_json,
              tx_mark = excluded.tx_mark, window_from = excluded.window_from, format = excluded.format`,
      args: [lawd, name, hash, builtAt, json, mark, windowFrom, MAP_RECENT_FORMAT, ...cond.args],
    });
  }
  const keep = new Set(names);
  const stale = [...existing.keys()].filter((n) => !keep.has(n));
  for (const n of stale) {
    writes.push({ sql: `DELETE FROM ${MAP_RECENT_TABLE} WHERE lawd_cd = ? AND apt_name_norm = ?`, args: [lawd, n] });
  }
  const result: MapRecentLawdResult = {
    lawd,
    names: names.length,
    targets: targets.length,
    written,
    markOnly,
    skippedChanged: 0,
    deleted: stale.length,
    unchanged: names.length - targets.length,
    bytes,
  };
  if (opts.dryRun) return result;
  const affected = await runWrites(db, writes, counter);
  // 조건부 쓰기가 0행 = 계산 도중 그 단지 거래가 바뀜 — 예전 행(낡은 번호)이 남아 지도는 예전 쿼리로 읽는다.
  result.skippedChanged = affected.slice(0, targets.length).filter((n) => n === 0).length;
  // 시군구 상태는 단지 행을 다 쓴 뒤에 — 읽기 전에 본 시군구 번호. 그 뒤 바뀐 단지는 번호가 더 커서 다음 갱신이 잡는다.
  await db.execute({
    sql: `INSERT INTO ${MAP_RECENT_STATE_TABLE} (lawd_cd, format, window_from, synced_max, built_at, row_count, tx_mark)
          VALUES (?, ?, ?, NULL, ?, ?, ?)
          ON CONFLICT(lawd_cd) DO UPDATE SET
            format = excluded.format, window_from = excluded.window_from, synced_max = NULL,
            built_at = excluded.built_at, row_count = excluded.row_count, tx_mark = excluded.tx_mark`,
    args: [lawd, MAP_RECENT_FORMAT, windowFrom, builtAt, names.length, lawdMark],
  });
  return result;
}

/**
 * 다시 볼 시군구 — mode "stale": 상태가 없거나, 형식·창이 바뀌었거나, 시군구 변경 번호가 상태 번호보다 큰 곳.
 * mode "all": 단지 표가 있는 모든 시군구 (그래도 번호가 같은 단지는 거래를 읽지 않는다).
 * 변경 표시 표가 없으면 에러.
 */
export async function mapRecentLawdsToRefresh(db: Client, mode: "stale" | "all", now = new Date()): Promise<string[]> {
  const windowFrom = mapRecentWindowFrom(now);
  const [lawdRes, stateRes, markRes] = await Promise.all([
    db.execute("SELECT DISTINCT lawd_cd FROM apt_complex_master"),
    db.execute(`SELECT lawd_cd, format, window_from, tx_mark, built_at FROM ${MAP_RECENT_STATE_TABLE}`).catch((error: unknown) => {
      if (/no such (table|column)/i.test(String(error))) return { rows: [] as Array<Record<string, unknown>> };
      throw error;
    }),
    db.execute("SELECT lawd_cd, MAX(seq) AS m FROM tx_change_marks GROUP BY lawd_cd"),
  ]);
  const lawds = lawdRes.rows.map((r) => String(r.lawd_cd)).sort();
  if (mode === "all") return lawds;
  const state = new Map(stateRes.rows.map((r) => [String(r.lawd_cd), r]));
  const cur = new Map(markRes.rows.map((r) => [String(r.lawd_cd), Number(r.m)]));
  const builtAt = (l: string) => {
    const s = state.get(l);
    return s?.tx_mark == null ? "" : String(s.built_at ?? "");
  };
  // 오래 전에 만든(또는 번호 없는) 시군구부터 — 상한(maxLawds)으로 잘라도 자주 바뀌는 곳만 계속 돌지 않게.
  return lawds
    .filter((l) => {
      const s = state.get(l);
      if (!s || s.tx_mark == null) return true;
      if (Number(s.format) !== MAP_RECENT_FORMAT || String(s.window_from) !== windowFrom) return true;
      return !isMarkCurrent(s.tx_mark, cur.get(l) ?? 0);
    })
    .sort((a, b) => (builtAt(a) < builtAt(b) ? -1 : builtAt(a) > builtAt(b) ? 1 : a < b ? -1 : 1));
}

export async function ensureMapRecentTables(db: Client): Promise<void> {
  for (const sql of MAP_RECENT_DDL) await db.execute(sql);
  for (const [table, column, type] of MAP_RECENT_ADD_COLUMNS) {
    const info = await db.execute(`PRAGMA table_info(${table})`);
    if (info.rows.some((r) => String(r.name) === column)) continue;
    await db.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

export type MapRecentTotals = {
  lawds: number;
  targets: number;
  written: number;
  markOnly: number;
  skippedChanged: number;
  deleted: number;
  unchanged: number;
  bytes: number;
};

/** 동기화 끝·수동 스크립트에서 부른다 — 바뀐 시군구의 바뀐 단지만 다시 만든다. */
export async function refreshMapComplexRecent(
  db: Client,
  opts: {
    mode?: "stale" | "all";
    lawds?: string[];
    /** 한 번에 볼 시군구 수 상한 — 나머지는 다음 갱신이 이어서 (동기화에서 한 번에 오래 걸리지 않게) */
    maxLawds?: number;
    dryRun?: boolean;
    concurrency?: number;
    log?: (s: string) => void;
  } = {},
): Promise<MapRecentTotals> {
  const log = opts.log ?? (() => {});
  if (!opts.dryRun) await ensureMapRecentTables(db);
  const found = opts.lawds ?? (await mapRecentLawdsToRefresh(db, opts.mode ?? "stale"));
  const lawds = opts.maxLawds != null ? found.slice(0, opts.maxLawds) : found;
  if (lawds.length < found.length) log(`[map-recent] ${found.length} lawds pending — this run ${lawds.length}`);
  let next = 0;
  const counter: WriteCounter = { n: 0 };
  const total: MapRecentTotals = { lawds: lawds.length, targets: 0, written: 0, markOnly: 0, skippedChanged: 0, deleted: 0, unchanged: 0, bytes: 0 };
  const worker = async () => {
    while (next < lawds.length) {
      const lawd = lawds[next++]!;
      const r = await rebuildMapRecentLawd(db, lawd, { dryRun: opts.dryRun, counter });
      total.targets += r.targets;
      total.written += r.written;
      total.markOnly += r.markOnly;
      total.skippedChanged += r.skippedChanged;
      total.deleted += r.deleted;
      total.unchanged += r.unchanged;
      total.bytes += r.bytes;
      if (r.targets || r.deleted) {
        log(
          `[map-recent] ${lawd} names=${r.names} targets=${r.targets} written=${r.written} markOnly=${r.markOnly} skippedChanged=${r.skippedChanged} deleted=${r.deleted} kb=${Math.round(r.bytes / 1024)}`,
        );
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 2, lawds.length)) }, worker));
  return total;
}

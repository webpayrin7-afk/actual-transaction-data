/**
 * 단지 비교 후보 면적 집계 스냅샷(apt_trade_area_stats) 갱신 — 법정동코드별.
 * 동기화(scripts/sync-molit.ts) 끝에서 부르고, scripts/build-peer-area-stats.ts 로도 돌린다.
 * 요청 경로에서 import 하지 않는다.
 *
 * 코드 L 하나:
 * 1) 현재 변경 번호 m = readChangeMark({ lawds: [L] }). 저장 번호(seq)가 m 과 같으면 건너뜀.
 * 2) 다시 집계할 단지: 번호 행이 있으면 base_seq 뒤에 바뀐 단지만(listChangedComplexesSince),
 *    없거나 --full 이면 코드 전체.
 * 3) 집계를 모두 읽은 뒤(읽기 에러면 이 코드는 멈춤 — 아무것도 쓰지 않음) 해시가 다른 행만 UPSERT,
 *    사라진 행은 DELETE. 쓰기 전에 번호 행 seq 를 NULL 로 내려 읽는 쪽이 쓰는 도중 행을 쓰지 않게 한다.
 * 4) 게시: 현재 번호가 아직 m 일 때만(markUnchangedCondition) seq = base_seq = m.
 *    도중에 거래가 바뀌었으면 게시하지 않는다(seq NULL/옛 값 → 읽는 쪽은 라이브, 다음 갱신이 다시 함).
 * 코드마다 따로 게시하므로 한 코드가 실패해도 다른 코드는 맞고, 실패한 코드는 라이브로 남는다.
 */
import { createHash } from "node:crypto";
import type { Client, InStatement } from "@libsql/client";
import { ALL_REGIONS } from "@/lib/constants/regions";
import {
  listChangedComplexesSince,
  markUnchangedCondition,
  readChangeMark,
} from "@/lib/db/snapshot-freshness";
import {
  compareSqlValue,
  PEER_AREA_STATS_DDL,
  type AreaStatTuple,
} from "@/lib/complex-detail/peer-area-stats";

export type RefreshPeerAreaStatsOptions = {
  /** 이 법정동코드만 (기본: 모든 지역 코드) */
  lawdCodes?: string[];
  /** 번호와 상관없이 코드 전체를 다시 집계(바뀐 행만 씀) */
  full?: boolean;
  dryRun?: boolean;
  /** 쓰기 묶음 사이 쉬는 시간(ms) */
  pauseMs?: number;
  log?: (msg: string) => void;
};

export type RefreshPeerAreaStatsResult = {
  lawdChecked: number;
  lawdRebuilt: number;
  lawdPublished: number;
  /** 집계 도중 거래가 바뀌어 게시하지 않은 코드 (다음 갱신에서 다시) */
  changedDuringBuild: string[];
  failures: string[];
  keysSeen: number;
  upserted: number;
  deleted: number;
  unchanged: number;
  ms: number;
};

const WRITE_CHUNK = 200;
const NORM_CHUNK = 200;
const SLOW_WRITE_MS = 5000;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export function allPeerAreaLawdCodes(): string[] {
  const set = new Set<string>();
  for (const r of ALL_REGIONS) for (const d of r.districts) set.add(d.code);
  return [...set].sort();
}

function hashStats(json: string): string {
  return createHash("sha1").update(json).digest("hex");
}

type Group = { aptNameNorm: string; gu: string; tuples: AreaStatTuple[] };

function groupKey(norm: string, gu: string): string {
  return `${norm}\u0000${gu}`;
}

/** 라이브 쿼리와 같은 조건(매매·exclusive_area > 0). gu 가 빈 행은 어떤 gu = ? 에도 걸리지 않는다. */
export async function computePeerAreaGroups(
  db: Client,
  lawdCd: string,
  norms?: string[],
): Promise<Map<string, Group>> {
  const normFilter =
    norms && norms.length > 0
      ? ` AND apt_name_norm IN (${norms.map(() => "?").join(",")})`
      : "";
  const res = await db.execute({
    sql: `SELECT apt_name_norm, gu, exclusive_area, build_year, COUNT(*) AS c
          FROM transactions INDEXED BY idx_tx_trade_lawd_apt_ym
          WHERE lawd_cd = ? AND deal_type = 'trade' AND exclusive_area > 0
            AND gu != ''${normFilter}
          GROUP BY apt_name_norm, gu, exclusive_area, build_year`,
    args: [lawdCd, ...(norms ?? [])],
  });
  const out = new Map<string, Group>();
  for (const row of res.rows) {
    const norm = String(row.apt_name_norm ?? "");
    const gu = String(row.gu ?? "");
    if (!norm || !gu) continue;
    const area = Number(row.exclusive_area);
    const byRaw = row.build_year;
    const by: number | string | null =
      byRaw == null
        ? null
        : typeof byRaw === "bigint"
          ? Number(byRaw)
          : (byRaw as number | string);
    const c = Number(row.c);
    if (!Number.isFinite(area) || !Number.isFinite(c)) {
      throw new Error(`peer-area: bad aggregate row ${lawdCd}/${norm}`);
    }
    const key = groupKey(norm, gu);
    const g = out.get(key) ?? { aptNameNorm: norm, gu, tuples: [] };
    g.tuples.push([area, by, c]);
    out.set(key, g);
  }
  for (const g of out.values()) {
    g.tuples.sort((a, b) => compareSqlValue(a[0], b[0]) || compareSqlValue(a[1], b[1]));
  }
  return out;
}

async function readExistingHashes(
  db: Client,
  lawdCd: string,
  norms?: string[],
): Promise<Map<string, string>> {
  const normFilter =
    norms && norms.length > 0
      ? ` AND apt_name_norm IN (${norms.map(() => "?").join(",")})`
      : "";
  const res = await db.execute({
    sql: `SELECT apt_name_norm, gu, content_hash FROM apt_trade_area_stats
          WHERE lawd_cd = ?${normFilter}`,
    args: [lawdCd, ...(norms ?? [])],
  });
  const out = new Map<string, string>();
  for (const row of res.rows) {
    out.set(groupKey(String(row.apt_name_norm), String(row.gu)), String(row.content_hash));
  }
  return out;
}

type StoredMark = { seq: number | null; baseSeq: number };

async function readStoredMarks(db: Client): Promise<Map<string, StoredMark>> {
  const res = await db.execute(
    `SELECT lawd_cd, seq, base_seq FROM apt_trade_area_stats_marks`,
  );
  const out = new Map<string, StoredMark>();
  for (const row of res.rows) {
    out.set(String(row.lawd_cd), {
      seq: row.seq == null ? null : Number(row.seq),
      baseSeq: Number(row.base_seq),
    });
  }
  return out;
}

/** 코드별 현재 번호 — tx_change_marks 전체(단지 수만큼)를 한 번 읽는다. 없는 코드 = 0. */
async function readCurrentLawdMarks(db: Client): Promise<Map<string, number>> {
  const res = await db.execute(
    `SELECT lawd_cd, MAX(seq) AS s FROM tx_change_marks GROUP BY lawd_cd`,
  );
  const out = new Map<string, number>();
  for (const row of res.rows) out.set(String(row.lawd_cd), Number(row.s));
  return out;
}

async function writeChunked(
  db: Client,
  writes: InStatement[],
  pauseMs: number,
): Promise<void> {
  for (let i = 0; i < writes.length; i += WRITE_CHUNK) {
    if (i > 0 && pauseMs > 0) await sleep(pauseMs);
    const t0 = Date.now();
    await db.batch(writes.slice(i, i + WRITE_CHUNK), "write");
    const ms = Date.now() - t0;
    if (ms > SLOW_WRITE_MS) {
      throw new Error(`peer-area: write chunk took ${ms}ms — stopping`);
    }
  }
}

type LawdOutcome = {
  rebuilt: boolean;
  published: boolean;
  changedDuringBuild: boolean;
  keysSeen: number;
  upserted: number;
  deleted: number;
  unchanged: number;
};

async function refreshOneLawd(
  db: Client,
  lawdCd: string,
  stored: StoredMark | undefined,
  opts: { full: boolean; dryRun: boolean; pauseMs: number; builtAt: string },
): Promise<LawdOutcome> {
  const out: LawdOutcome = {
    rebuilt: false,
    published: false,
    changedDuringBuild: false,
    keysSeen: 0,
    upserted: 0,
    deleted: 0,
    unchanged: 0,
  };
  const mark = await readChangeMark(db, { lawds: [lawdCd] });
  if (!opts.full && stored?.seq != null && stored.seq === mark) return out;

  // 다시 집계할 단지 (undefined = 코드 전체)
  let norms: string[] | undefined;
  if (!opts.full && stored) {
    const changed = await listChangedComplexesSince(db, stored.baseSeq, { lawds: [lawdCd] });
    norms = [...new Set(changed.map((c) => c.aptNameNorm))].sort();
  }
  out.rebuilt = true;

  // 1) 읽기 — 전부 끝난 뒤에만 쓴다(읽기 에러는 그대로 던짐 → 이 코드는 아무것도 안 씀)
  const writes: InStatement[] = [];
  const chunks: Array<string[] | undefined> = norms
    ? Array.from({ length: Math.ceil(norms.length / NORM_CHUNK) }, (_, i) =>
        norms!.slice(i * NORM_CHUNK, (i + 1) * NORM_CHUNK),
      )
    : [undefined];
  for (const chunk of chunks) {
    const [groups, existing] = await Promise.all([
      computePeerAreaGroups(db, lawdCd, chunk),
      readExistingHashes(db, lawdCd, chunk),
    ]);
    for (const [key, g] of groups) {
      out.keysSeen += 1;
      const json = JSON.stringify(g.tuples);
      const hash = hashStats(json);
      if (existing.get(key) === hash) {
        out.unchanged += 1;
        continue;
      }
      out.upserted += 1;
      writes.push({
        sql: `INSERT INTO apt_trade_area_stats
                (lawd_cd, apt_name_norm, gu, content_hash, built_at, stats_json)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(lawd_cd, apt_name_norm, gu) DO UPDATE SET
                content_hash = excluded.content_hash,
                built_at = excluded.built_at,
                stats_json = excluded.stats_json`,
        args: [lawdCd, g.aptNameNorm, g.gu, hash, opts.builtAt, json],
      });
    }
    for (const key of existing.keys()) {
      if (groups.has(key)) continue;
      out.deleted += 1;
      const [norm, gu] = key.split("\u0000");
      writes.push({
        sql: `DELETE FROM apt_trade_area_stats
              WHERE lawd_cd = ? AND apt_name_norm = ? AND gu = ?`,
        args: [lawdCd, norm!, gu!],
      });
    }
  }
  if (opts.dryRun) return out;

  // 2) 쓰기 — 먼저 게시 번호를 내려 쓰는 도중 행을 읽는 쪽이 쓰지 않게
  if (writes.length > 0) {
    if (stored?.seq != null) {
      await db.execute({
        sql: `UPDATE apt_trade_area_stats_marks SET seq = NULL WHERE lawd_cd = ?`,
        args: [lawdCd],
      });
    }
    await writeChunked(db, writes, opts.pauseMs);
  }

  // 3) 게시 — 집계 시작 전 번호가 아직 현재일 때만
  const cond = markUnchangedCondition({ lawds: [lawdCd] }, mark);
  const res = await db.execute({
    sql: `INSERT INTO apt_trade_area_stats_marks (lawd_cd, seq, base_seq, built_at)
          SELECT ?, ?, ?, ? WHERE ${cond.sql}
          ON CONFLICT(lawd_cd) DO UPDATE SET
            seq = excluded.seq,
            base_seq = excluded.base_seq,
            built_at = excluded.built_at`,
    args: [lawdCd, mark, mark, opts.builtAt, ...cond.args],
  });
  if (res.rowsAffected > 0) out.published = true;
  else out.changedDuringBuild = true;
  return out;
}

export async function ensurePeerAreaStatsSchema(db: Client): Promise<void> {
  for (const sql of PEER_AREA_STATS_DDL.split(";").map((s) => s.trim()).filter(Boolean)) {
    await db.execute(sql);
  }
}

/**
 * 번호가 바뀐 코드만 다시 집계·게시한다. 변경 표시 표(tx_change_marks)가 없으면 에러를 던진다
 * (스냅샷을 쓰지 않음 — 읽는 쪽은 번호를 못 읽어 라이브).
 */
export async function refreshPeerAreaStats(
  db: Client,
  opts: RefreshPeerAreaStatsOptions = {},
): Promise<RefreshPeerAreaStatsResult> {
  const started = Date.now();
  const log = opts.log ?? (() => {});
  const dryRun = opts.dryRun === true;
  const full = opts.full === true;
  const pauseMs = Math.max(0, opts.pauseMs ?? 1000);
  if (!dryRun) await ensurePeerAreaStatsSchema(db);

  const codes = [...new Set(opts.lawdCodes?.length ? opts.lawdCodes : allPeerAreaLawdCodes())];
  const [storedMarks, currentMarks] = await Promise.all([
    readStoredMarks(db).catch((err) => {
      if (dryRun) return new Map<string, StoredMark>(); // 드라이런: 표가 아직 없을 수 있음
      throw err;
    }),
    readCurrentLawdMarks(db),
  ]);
  const jobs = codes.filter((code) => {
    if (full) return true;
    const s = storedMarks.get(code);
    return !(s?.seq != null && s.seq === (currentMarks.get(code) ?? 0));
  });

  const result: RefreshPeerAreaStatsResult = {
    lawdChecked: codes.length,
    lawdRebuilt: 0,
    lawdPublished: 0,
    changedDuringBuild: [],
    failures: [],
    keysSeen: 0,
    upserted: 0,
    deleted: 0,
    unchanged: 0,
    ms: 0,
  };
  log(`[peer-area] codes=${codes.length} toRefresh=${jobs.length}${full ? " full" : ""}${dryRun ? " DRY-RUN" : ""}`);

  const builtAt = new Date().toISOString();
  for (let i = 0; i < jobs.length; i += 1) {
    const code = jobs[i]!;
    try {
      const r = await refreshOneLawd(db, code, storedMarks.get(code), {
        full,
        dryRun,
        pauseMs,
        builtAt,
      });
      if (r.rebuilt) result.lawdRebuilt += 1;
      if (r.published) result.lawdPublished += 1;
      if (r.changedDuringBuild) result.changedDuringBuild.push(code);
      result.keysSeen += r.keysSeen;
      result.upserted += r.upserted;
      result.deleted += r.deleted;
      result.unchanged += r.unchanged;
    } catch (err) {
      result.failures.push(code);
      log(`[peer-area] fail ${code}: ${err instanceof Error ? err.message : String(err)}`);
      if (err instanceof Error && /stopping/.test(err.message)) break; // 느린 쓰기 — 전체 멈춤
    }
    if ((i + 1) % 25 === 0 || i + 1 === jobs.length) {
      log(
        `[peer-area] ${i + 1}/${jobs.length} published=${result.lawdPublished} keys=${result.keysSeen} upsert=${result.upserted} del=${result.deleted} same=${result.unchanged}`,
      );
    }
  }
  result.ms = Date.now() - started;
  return result;
}

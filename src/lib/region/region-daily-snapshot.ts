/**
 * 지역 "새로 확인된 거래"(/api/region-daily) 첫 화면 스냅샷 — part=latest·history·days, 이번 달.
 *
 * 첫 방문(콜드)에 지역 전체의 확인 거래·월 거래·단지 이력을 여러 번 왕복으로 읽는다
 * (지역당 수백 ms~수 s). 동기화 뒤 빌더(scripts/build-region-daily-snapshot.ts)가
 * 같은 계산(computeRegionDaily, strict)으로 결과를 저장해 두고, 읽기는 1행 1왕복으로 끝낸다.
 *
 * 정확성 — 저장된 결과는 아래가 모두 맞을 때만 쓴다 (아니면 null → 라이브 계산):
 * 1) 거래 변경 번호: 저장 때 번호(tx_mark) = 지금 그 지역 시군구들 번호
 *    (tx_change_marks, transactions 트리거가 채움 — sync 밖 직접 UPDATE 도 잡힌다).
 *    계산이 읽는 transactions 는 모두 그 지역 lawd_cd 안이다.
 * 2) 날짜: 결과가 오늘에 기대는 곳은 "오늘 확인된 날" 고르기(pickHeroSeenDate) 하나뿐이다.
 *    같은 날이면 그대로. 뒷날이면 저장 때 오늘이 확인된 날이 아니었고(hero_is_today=0)
 *    골라 둔 날(hero_date = 확인된 날 중 가장 늦은 날)이 오늘보다 앞일 때만 — 그러면 오늘은
 *    확인된 날이 아니므로 같은 날을 고른다. 달이 바뀌면 행 키(year_month)가 달라 안 맞는다.
 * 3) 달 목록(contractMonthOptions·activityYearMonths)은 sync_months 에서 온다(거래 번호로 안 잡힘).
 *    같은 SELECT 에서 지금 달 목록을 같이 읽어 그 두 필드를 라이브와 같은 함수로 다시 만든다.
 *    지금 sync_months 가 비었으면(라이브는 transactions 로 대신 셈) 저장 때도 비었을 때만 쓴다.
 * 표가 없거나(트리거 미적용 포함) 읽기가 실패하면 null. ZIPLAB_REGION_DAILY_SNAPSHOT=0 이면 읽지 않는다.
 *
 * 쓰는 쪽 규칙(빌더): strict 계산(DB 에러를 던짐)만 저장하고, 저장은 계산 전에 읽은 번호가
 * 그대로일 때만 되는 조건부 쓰기(markUnchangedCondition)로 한다.
 */
import type { Client, InStatement } from "@libsql/client";
import type { RegionDef } from "@/lib/constants/regions";
import { getDb } from "@/lib/db/client";
import { noteDbQuery } from "@/lib/db/query-stats";
import {
  changeMarkSubquery,
  isMarkCurrent,
  markUnchangedCondition,
} from "@/lib/db/snapshot-freshness";
import { yearMonthFromSeoulDate } from "@/lib/market/time";
import { monthSelectorOptions } from "@/lib/region/market-insight";

export const REGION_DAILY_SNAPSHOT_PARTS = ["latest", "history", "days"] as const;
export type RegionDailySnapshotPart = (typeof REGION_DAILY_SNAPSHOT_PARTS)[number];

export function regionDailySnapshotEnabled(): boolean {
  return process.env.ZIPLAB_REGION_DAILY_SNAPSHOT !== "0";
}

type SqlPart = { sql: string; args: Array<string | number> };

/**
 * 지금 달 목록 — queryAvailableTradeMonths 의 sync_months 쿼리와 같은 조건, 쉼표로 이은 문자열.
 * 없으면 ''.
 */
export function regionMonthsKeySubquery(lawdCodes: readonly string[]): SqlPart {
  const lawds = [...lawdCodes];
  if (lawds.length === 0) throw new Error("regionMonthsKeySubquery: empty lawds");
  return {
    sql: `(SELECT COALESCE(group_concat(ym, ','), '') FROM (
             SELECT year_month AS ym FROM sync_months
              WHERE lawd_cd IN (${lawds.map(() => "?").join(",")}) AND deal_kind = 'trade'
              GROUP BY year_month HAVING SUM(row_count) > 0
              ORDER BY year_month DESC))`,
    args: lawds,
  };
}

/** 저장된 행이 오늘(today, KST) 읽기에 맞는가 — 날짜 규칙만 (번호·달 목록은 따로). */
export function snapshotDateUsable(
  row: {
    yearMonth: string;
    seoulDate: string;
    heroDate: string | null;
    heroIsToday: boolean;
  },
  today: string,
): boolean {
  if (yearMonthFromSeoulDate(today) !== row.yearMonth) return false;
  if (yearMonthFromSeoulDate(row.seoulDate) !== row.yearMonth) return false;
  if (today === row.seoulDate) return true;
  if (today < row.seoulDate) return false;
  if (row.heroIsToday) return false;
  return row.heroDate == null || row.heroDate < today;
}

function splitMonthsKey(key: string): string[] {
  return key ? key.split(",").filter((ym) => ym.length === 6) : [];
}

type MonthOptionFields = {
  contractMonthOptions: string[];
  activityYearMonths: string[];
};

let readFailWarned = false;

/**
 * 스냅샷 1행 + 그 지역 지금 거래 번호·달 목록을 한 왕복으로. 쓸 수 없으면 null(라이브로).
 */
export async function readRegionDailySnapshot<T extends MonthOptionFields>(params: {
  region: RegionDef;
  part: RegionDailySnapshotPart;
  yearMonth: string;
  seoulDate: string;
}): Promise<T | null> {
  if (!regionDailySnapshotEnabled()) return null;
  const db = getDb();
  if (!db) return null;
  const lawdCodes = [...params.region.lawdCodes];
  if (lawdCodes.length === 0) return null;
  try {
    const mark = changeMarkSubquery({ lawds: lawdCodes });
    const months = regionMonthsKeySubquery(lawdCodes);
    noteDbQuery();
    const res = await db.execute({
      sql: `SELECT s.payload AS payload, s.seoul_date AS seoul_date, s.tx_mark AS tx_mark,
                   s.months_key AS months_key, s.hero_date AS hero_date,
                   s.hero_is_today AS hero_is_today,
                   ${mark.sql} AS cur_mark, ${months.sql} AS cur_months
              FROM region_daily_snapshot s
             WHERE s.region_slug = ? AND s.part = ? AND s.year_month = ?`,
      args: [...mark.args, ...months.args, params.region.slug, params.part, params.yearMonth],
    });
    const row = res.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    if (!isMarkCurrent(row.tx_mark, row.cur_mark)) return null;
    if (
      !snapshotDateUsable(
        {
          yearMonth: params.yearMonth,
          seoulDate: String(row.seoul_date ?? ""),
          heroDate: row.hero_date == null ? null : String(row.hero_date),
          heroIsToday: Number(row.hero_is_today) === 1,
        },
        params.seoulDate,
      )
    ) {
      return null;
    }
    const curMonths = String(row.cur_months ?? "");
    if (row.months_key == null) return null;
    if (curMonths === "" && String(row.months_key) !== "") return null;
    const payload = JSON.parse(String(row.payload)) as T;
    if (curMonths !== "") {
      // 라이브: monthSelectorOptions(queryAvailableTradeMonths(sync_months), 이번 달)
      const options = monthSelectorOptions(splitMonthsKey(curMonths), params.yearMonth);
      payload.contractMonthOptions = options;
      payload.activityYearMonths = options;
    }
    return payload;
  } catch (error) {
    if (!readFailWarned) {
      readFailWarned = true;
      console.warn(
        "[region-daily] snapshot read failed, live fallback:",
        error instanceof Error ? error.message : error,
      );
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// 빌더 (스크립트 전용 — 요청 경로에서 부르지 않는다)
// ---------------------------------------------------------------------------

export type ExistingSnapshotRow = {
  seoulDate: string;
  txMark: number | null;
  buildSeq: number | null;
  heroDate: string | null;
  heroIsToday: boolean;
  builtAt: string;
};

function intOrNull(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

export async function readExistingSnapshotRows(
  db: Client,
  yearMonth: string,
): Promise<Map<string, ExistingSnapshotRow>> {
  const res = await db.execute({
    sql: `SELECT region_slug, part, seoul_date, tx_mark, build_seq, hero_date, hero_is_today, built_at
            FROM region_daily_snapshot WHERE year_month = ?`,
    args: [yearMonth],
  });
  const out = new Map<string, ExistingSnapshotRow>();
  for (const row of res.rows) {
    out.set(`${row.region_slug}|${row.part}`, {
      seoulDate: String(row.seoul_date ?? ""),
      txMark: intOrNull(row.tx_mark),
      buildSeq: intOrNull(row.build_seq),
      heroDate: row.hero_date == null ? null : String(row.hero_date),
      heroIsToday: Number(row.hero_is_today) === 1,
      builtAt: String(row.built_at ?? ""),
    });
  }
  return out;
}

/** 시군구별 지금 번호 (표시 없는 시군구 = 0). 에러는 던진다. */
export async function readLawdMarks(
  db: Client,
  lawdCodes: readonly string[],
): Promise<Map<string, number>> {
  const lawds = [...new Set(lawdCodes)];
  const out = new Map<string, number>();
  for (const code of lawds) out.set(code, 0);
  const CHUNK = 60;
  for (let i = 0; i < lawds.length; i += CHUNK) {
    const chunk = lawds.slice(i, i + CHUNK);
    const res = await db.execute({
      sql: `SELECT lawd_cd, MAX(seq) AS s FROM tx_change_marks
             WHERE lawd_cd IN (${chunk.map(() => "?").join(",")}) GROUP BY lawd_cd`,
      args: chunk,
    });
    for (const row of res.rows) {
      const n = intOrNull(row.s);
      if (n == null) throw new Error(`tx_change_marks: unexpected seq ${String(row.s)}`);
      out.set(String(row.lawd_cd), n);
    }
  }
  return out;
}

export type RegionBuildBasis = { globalSeq: number; mark: number; monthsKey: string };

/** 계산 직전 한 문장으로: 전역 번호, 지역 번호, 달 목록. 에러는 던진다. */
export async function readRegionBuildBasis(
  db: Client,
  region: RegionDef,
): Promise<RegionBuildBasis> {
  const globalSub = changeMarkSubquery({ global: true });
  const mark = changeMarkSubquery({ lawds: region.lawdCodes });
  const months = regionMonthsKeySubquery(region.lawdCodes);
  const res = await db.execute({
    sql: `SELECT ${globalSub.sql} AS g, ${mark.sql} AS m, ${months.sql} AS k`,
    args: [...globalSub.args, ...mark.args, ...months.args],
  });
  const row = res.rows[0];
  const g = intOrNull(row?.g);
  const m = intOrNull(row?.m);
  if (g == null || m == null || row?.k == null) {
    throw new Error(`region build basis: unexpected row ${JSON.stringify(row)}`);
  }
  return { globalSeq: g, mark: m, monthsKey: String(row.k) };
}

export type SnapshotWrite = {
  region: RegionDef;
  part: RegionDailySnapshotPart;
  yearMonth: string;
  seoulDate: string;
  basis: RegionBuildBasis;
  heroDate: string | null;
  heroIsToday: boolean;
  contentHash: string;
  builtAt: string;
  payload: string;
};

/**
 * 조건부 upsert: 지역 번호와 달 목록이 계산 전에 읽은 값 그대로일 때만 쓴다
 * (rowsAffected 0 = 계산 도중 바뀜 → 저장 안 됨).
 */
export function snapshotWriteStatement(w: SnapshotWrite): InStatement {
  const unchanged = markUnchangedCondition({ lawds: w.region.lawdCodes }, w.basis.mark);
  const months = regionMonthsKeySubquery(w.region.lawdCodes);
  return {
    sql: `INSERT INTO region_daily_snapshot
            (region_slug, part, year_month, seoul_date, source_sync, content_hash, built_at, payload,
             tx_mark, build_seq, months_key, hero_date, hero_is_today)
          SELECT ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?
           WHERE ${unchanged.sql} AND ${months.sql} = ?
          ON CONFLICT(region_slug, part, year_month) DO UPDATE SET
            seoul_date = excluded.seoul_date,
            source_sync = excluded.source_sync,
            content_hash = excluded.content_hash,
            built_at = excluded.built_at,
            payload = excluded.payload,
            tx_mark = excluded.tx_mark,
            build_seq = excluded.build_seq,
            months_key = excluded.months_key,
            hero_date = excluded.hero_date,
            hero_is_today = excluded.hero_is_today`,
    args: [
      w.region.slug,
      w.part,
      w.yearMonth,
      w.seoulDate,
      w.contentHash,
      w.builtAt,
      w.payload,
      w.basis.mark,
      w.basis.globalSeq,
      w.basis.monthsKey,
      w.heroDate,
      w.heroIsToday ? 1 : 0,
      ...unchanged.args,
      ...months.args,
      w.basis.monthsKey,
    ],
  };
}

export type RegionDailySnapshotCompute = (params: {
  region: RegionDef;
  part: RegionDailySnapshotPart;
  yearMonth: string;
  seoulDate: string;
}) => Promise<{ source: string; selectedDate: string | null; latestIsToday: boolean }>;

export type StaleReason = "missing" | "date" | "mark";

export type RegionDailySnapshotRefreshSummary = {
  seoulDate: string;
  yearMonth: string;
  globalSeq: number;
  regions: number;
  fresh: number;
  stale: number;
  staleByReason: Record<StaleReason, number>;
  skippedRecent: number;
  skippedCap: number;
  built: number;
  rowsWritten: number;
  raced: number;
  failures: string[];
  deletedOldMonths: number;
  readMs: number;
  ms: number;
};

/**
 * 바뀐 지역만 다시 만든다.
 * - 오래된 지역 = 이번 달 행이 없음 / 날짜 규칙 불합격 / 지역 번호가 저장 번호와 다름.
 *   (행의 build_seq 가 지금 전역 번호와 같으면 그 뒤로 아무 거래도 안 바뀐 것 — 번호 확인 생략)
 * - 한 지역은 minRebuildMs(기본 1시간) 안에 다시 만들지 않는다 (그동안 그 지역 읽기는 라이브).
 * - 한 번에 maxRegions 지역, maxMs 시간까지만 — 남은 지역은 다음 실행에서.
 * - 계산은 strict(에러를 던짐). 에러·날짜 넘어감·도중 변경이면 그 지역은 저장하지 않는다.
 */
export async function refreshRegionDailySnapshots(params: {
  db: Client;
  regions: RegionDef[];
  compute: RegionDailySnapshotCompute;
  seoulDate: string;
  yearMonth: string;
  /** 지금 KST 날짜 (계산 뒤 날짜가 넘어갔는지 확인) */
  currentSeoulDate: () => string;
  apply: boolean;
  maxRegions: number;
  maxMs: number;
  minRebuildMs: number;
  pauseMs?: number;
  force?: boolean;
  log?: (line: string) => void;
}): Promise<RegionDailySnapshotRefreshSummary> {
  const { db, regions, compute, seoulDate, yearMonth, apply } = params;
  const log = params.log ?? (() => {});
  const { createHash } = await import("node:crypto");
  const t0 = Date.now();

  // 표·트리거가 없으면 여기서 던진다 — 번호 없이는 저장하지 않는다.
  const globalRes = await db.execute(
    `SELECT ${changeMarkSubquery({ global: true }).sql} AS g`,
  );
  const globalSeq = intOrNull(globalRes.rows[0]?.g);
  if (globalSeq == null) throw new Error("tx_change_seq: unexpected value");
  const existing = await readExistingSnapshotRows(db, yearMonth);

  const summary: RegionDailySnapshotRefreshSummary = {
    seoulDate,
    yearMonth,
    globalSeq,
    regions: regions.length,
    fresh: 0,
    stale: 0,
    staleByReason: { missing: 0, date: 0, mark: 0 },
    skippedRecent: 0,
    skippedCap: 0,
    built: 0,
    rowsWritten: 0,
    raced: 0,
    failures: [],
    deletedOldMonths: 0,
    readMs: 0,
    ms: 0,
  };

  // 1) 번호 확인이 필요한 지역의 시군구 번호만 읽는다
  const needMark: RegionDef[] = [];
  const reasonBySlug = new Map<string, StaleReason>();
  for (const region of regions) {
    const rows = REGION_DAILY_SNAPSHOT_PARTS.map((part) =>
      existing.get(`${region.slug}|${part}`),
    );
    if (rows.some((r) => r == null || r.txMark == null)) {
      reasonBySlug.set(region.slug, "missing");
      continue;
    }
    const dateOk = rows.every((r) =>
      snapshotDateUsable(
        {
          yearMonth,
          seoulDate: r!.seoulDate,
          heroDate: r!.heroDate,
          heroIsToday: r!.heroIsToday,
        },
        seoulDate,
      ),
    );
    if (!dateOk) {
      reasonBySlug.set(region.slug, "date");
      continue;
    }
    if (rows.every((r) => r!.buildSeq === globalSeq)) continue;
    needMark.push(region);
  }
  if (needMark.length > 0) {
    const marks = await readLawdMarks(
      db,
      needMark.flatMap((r) => [...r.lawdCodes]),
    );
    for (const region of needMark) {
      let mark = 0;
      for (const code of region.lawdCodes) mark = Math.max(mark, marks.get(code) ?? 0);
      const stale = REGION_DAILY_SNAPSHOT_PARTS.some(
        (part) => existing.get(`${region.slug}|${part}`)?.txMark !== mark,
      );
      if (stale) reasonBySlug.set(region.slug, "mark");
    }
  }
  summary.readMs = Date.now() - t0;

  // 2) 대상 고르기: 행 없음 먼저, 그다음 오래 전에 만든 지역부터
  const nowMs = Date.now();
  const candidates: Array<{ region: RegionDef; reason: StaleReason; oldest: string }> = [];
  for (const region of regions) {
    const reason = reasonBySlug.get(region.slug);
    if (!reason) {
      summary.fresh += 1;
      continue;
    }
    summary.stale += 1;
    summary.staleByReason[reason] += 1;
    const builtTimes = REGION_DAILY_SNAPSHOT_PARTS.map(
      (part) => existing.get(`${region.slug}|${part}`)?.builtAt ?? "",
    ).filter(Boolean);
    const newest = builtTimes.reduce((a, b) => (b > a ? b : a), "");
    const newestMs = newest ? Date.parse(newest) : Number.NaN;
    if (
      !params.force &&
      Number.isFinite(newestMs) &&
      nowMs - newestMs < params.minRebuildMs
    ) {
      summary.skippedRecent += 1;
      continue;
    }
    const oldest = builtTimes.reduce((a, b) => (a === "" || b < a ? b : a), "");
    candidates.push({ region, reason, oldest });
  }
  candidates.sort((a, b) => {
    const ra = a.reason === "missing" ? 0 : 1;
    const rb = b.reason === "missing" ? 0 : 1;
    if (ra !== rb) return ra - rb;
    return a.oldest.localeCompare(b.oldest);
  });

  // 3) 한 지역씩 (순차) — 계산 전 기준 읽기 → strict 계산 3개 → 조건부 쓰기
  let started = 0;
  for (const { region } of candidates) {
    if (started >= params.maxRegions || Date.now() - t0 > params.maxMs) {
      summary.skippedCap += 1;
      continue;
    }
    started += 1;
    const tRegion = Date.now();
    try {
      const basis = await readRegionBuildBasis(db, region);
      const writes: SnapshotWrite[] = [];
      for (const part of REGION_DAILY_SNAPSHOT_PARTS) {
        const result = await compute({ region, part, yearMonth, seoulDate });
        if (result.source !== "db") {
          throw new Error(`source=${result.source} — DB 결과가 아님`);
        }
        const payload = JSON.stringify(result);
        writes.push({
          region,
          part,
          yearMonth,
          seoulDate,
          basis,
          heroDate: result.selectedDate ?? null,
          heroIsToday: result.latestIsToday === true,
          contentHash: createHash("sha256").update(payload).digest("hex"),
          builtAt: new Date().toISOString(),
          payload,
        });
      }
      if (params.currentSeoulDate() !== seoulDate) {
        throw new Error("계산 도중 날짜가 바뀜 — 저장하지 않음");
      }
      summary.built += 1;
      if (apply) {
        for (const w of writes) {
          const tw = Date.now();
          const res = await db.execute(snapshotWriteStatement(w));
          const wms = Date.now() - tw;
          if (res.rowsAffected === 0) {
            summary.raced += 1;
            log(`[region-daily-snapshot] ${region.slug} 계산 도중 거래가 바뀌어 저장 안 함`);
            break;
          }
          summary.rowsWritten += res.rowsAffected;
          if (wms > 5000) {
            throw new Error(`write took ${wms}ms — stopping`);
          }
        }
      }
    } catch (error) {
      summary.failures.push(region.slug);
      console.warn(
        `[region-daily-snapshot] ${region.slug} failed (저장 안 함):`,
        error instanceof Error ? error.message : error,
      );
      if (error instanceof Error && error.message.includes("stopping")) throw error;
    }
    const regionMs = Date.now() - tRegion;
    log(
      `[region-daily-snapshot] ${region.slug} ${regionMs}ms (${started}/${Math.min(candidates.length, params.maxRegions)})`,
    );
    if (params.pauseMs) await new Promise((r) => setTimeout(r, params.pauseMs));
  }

  // 4) 지난 달 행은 읽히지 않는다 — 있을 때만 지역 묶음으로 지운다
  if (apply) {
    const old = await db.execute({
      sql: `SELECT DISTINCT region_slug FROM region_daily_snapshot WHERE year_month < ?`,
      args: [yearMonth],
    });
    const slugs = old.rows.map((r) => String(r.region_slug));
    for (let i = 0; i < slugs.length; i += 50) {
      const chunk = slugs.slice(i, i + 50);
      const del = await db.execute({
        sql: `DELETE FROM region_daily_snapshot
               WHERE year_month < ? AND region_slug IN (${chunk.map(() => "?").join(",")})`,
        args: [yearMonth, ...chunk],
      });
      summary.deletedOldMonths += del.rowsAffected;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  summary.ms = Date.now() - t0;
  return summary;
}

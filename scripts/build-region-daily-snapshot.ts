/**
 * 지역 "새로 확인된 거래" 첫 화면 스냅샷(region_daily_snapshot) — 바뀐 지역만 다시 만든다.
 * 이 표 외에는 쓰지 않는다 (transactions·sync_months·tx_change_* 는 읽기만).
 * 거래 변경 표시(scripts/apply-tx-change-marks.ts — 표 2개 + transactions 트리거 4개)가 적용돼 있어야 한다.
 * sqlite_master 로 트리거까지 확인하고, 없으면 아무것도 하지 않는다(쓰기 없음).
 *
 *   npx tsx scripts/build-region-daily-snapshot.ts                     # 드라이런: 오래된 지역 고르고 계산만, 쓰기 없음
 *   npx tsx scripts/build-region-daily-snapshot.ts --apply             # 표/열 준비 + 바뀐 지역 저장 (기본 40지역·10분)
 *   npx tsx scripts/build-region-daily-snapshot.ts --apply --max-regions=80 --max-minutes=20
 *   npx tsx scripts/build-region-daily-snapshot.ts --regions=seoul-mapo,gyeonggi-suwon --apply --force
 *   npx tsx scripts/build-region-daily-snapshot.ts --verify=20        # 저장 행 20개: 스냅샷 읽기 = 라이브 계산? (읽기만)
 *   npx tsx scripts/build-region-daily-snapshot.ts --compare=12       # strict 계산 = 라이브 계산? + 지역당 Turso rows_read (읽기만, 표 불필요)
 *   npx tsx scripts/build-region-daily-snapshot.ts --compare=3 --regions=gyeonggi-suwon,gyeonggi-hwaseong,seoul-mapo --no-live
 *
 * 동기화 워크플로(.github/workflows/sync-molit.yml)가 sync 뒤에 --apply 로 부른다.
 * 끄기: REGION_DAILY_SNAPSHOT_REFRESH=0
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { ALL_REGIONS, getRegion, type RegionDef } from "../src/lib/constants/regions";
import { getDb } from "../src/lib/db/client";
import { seoulToday, yearMonthFromSeoulDate } from "../src/lib/market/time";
import {
  clearRegionDailyCaches,
  computeRegionDailyLiveUncached,
  computeRegionDailyStrict,
} from "../src/lib/molit/service";
import {
  REGION_DAILY_SNAPSHOT_PARTS,
  readRegionBuildBasis,
  readRegionDailySnapshot,
  readRegionDailySnapshotSchemaStatus,
  refreshRegionDailySnapshots,
  regionMonthsKeySubquery,
  type RegionDailySnapshotPart,
} from "../src/lib/region/region-daily-snapshot";
import { ensureRegionDailySnapshotTable } from "../src/lib/region/region-daily-snapshot-schema";

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function pickRegions(): RegionDef[] {
  const slugs = (arg("regions") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (slugs.length === 0) return ALL_REGIONS;
  return slugs.map((slug) => {
    const region = getRegion(slug);
    if (!region) throw new Error(`알 수 없는 지역: ${slug}`);
    return region;
  });
}

async function refresh(apply: boolean): Promise<void> {
  const db = getDb();
  if (!db) throw new Error("DB가 설정되지 않았습니다.");
  // 거래 변경 표시(표 + transactions 트리거 4개)가 없으면 아무것도 하지 않는다 (표·열도 건드리지 않음).
  // 표만 있고 트리거가 없으면 번호가 안 바뀌어 스냅샷을 믿을 수 없다 — 트리거까지 sqlite_master 로 본다.
  const tracking = await readRegionDailySnapshotSchemaStatus(db, { includeSnapshotTable: false });
  if (!tracking.ready) {
    console.log(
      `[region-daily-snapshot] 거래 변경 표시 미적용(${tracking.missing.join(", ")}) — 건너뜀 (npx tsx scripts/apply-tx-change-marks.ts --apply)`,
    );
    return;
  }
  if (apply) {
    const added = await ensureRegionDailySnapshotTable(db);
    if (added.length) console.log(`[region-daily-snapshot] columns added: ${added.join(",")}`);
  }
  // 오늘 날짜는 한 번만 정한다. 계산 뒤 날짜가 바뀌었으면 그 지역은 저장하지 않는다.
  const seoulDate = seoulToday();
  clearRegionDailyCaches();
  const summary = await refreshRegionDailySnapshots({
    db,
    regions: pickRegions(),
    compute: computeRegionDailyStrict,
    seoulDate,
    yearMonth: yearMonthFromSeoulDate(seoulDate),
    currentSeoulDate: () => seoulToday(),
    apply,
    maxRegions: Number(arg("max-regions") ?? "40") || 40,
    maxMs: (Number(arg("max-minutes") ?? "10") || 10) * 60_000,
    minRebuildMs: (Number(arg("min-rebuild-minutes") ?? "60") || 0) * 60_000,
    pauseMs: 500,
    force: process.argv.includes("--force"),
    log: (line) => console.log(line),
  });
  console.log(JSON.stringify({ ...summary, dryRun: !apply }));
  if (summary.failures.length > 0) process.exitCode = 1;
}

/**
 * Turso 읽기 비용 측정 (측정 전용): Hrana HTTP 응답의 rows_read·rows_written(과금 기준, 스캔한 행)과
 * 돌려받은 행 수를 센다. getDb() 가 클라이언트를 만들기 전에 불러야 한다 (클라이언트가 그때 fetch 를 잡음).
 * 로컬 file: DB 는 HTTP 를 쓰지 않아 rowsRead 가 0 으로 남는다.
 */
function installTursoMeter(): { take: () => { queries: number; rowsRead: number; rowsWritten: number; rowsReturned: number } } {
  let queries = 0;
  let rowsRead = 0;
  let rowsWritten = 0;
  let rowsReturned = 0;
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const n of node) walk(n);
      return;
    }
    if (!node || typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    if (typeof o.rows_read === "number") {
      queries += 1;
      rowsRead += o.rows_read;
      if (typeof o.rows_written === "number") rowsWritten += o.rows_written;
      if (Array.isArray(o.rows)) rowsReturned += o.rows.length;
      return;
    }
    for (const v of Object.values(o)) walk(v);
  };
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const res = await orig(input, init);
    try {
      if ((res.headers.get("content-type") ?? "").includes("json")) {
        walk(await res.clone().json());
      }
    } catch {
      // 측정 실패는 무시 (응답은 그대로)
    }
    return res;
  }) as typeof fetch;
  return {
    take: () => {
      const out = { queries, rowsRead, rowsWritten, rowsReturned };
      queries = 0;
      rowsRead = 0;
      rowsWritten = 0;
      rowsReturned = 0;
      return out;
    },
  };
}

function sampleRegions(n: number): RegionDef[] {
  const explicit = pickRegions();
  if (explicit !== ALL_REGIONS) return explicit;
  // 고르게: 목록 전체에서 같은 간격으로 n개
  const step = Math.max(1, Math.floor(ALL_REGIONS.length / n));
  const out: RegionDef[] = [];
  for (let i = 0; i < ALL_REGIONS.length && out.length < n; i += step) out.push(ALL_REGIONS[i]!);
  return out;
}

/**
 * strict 계산 = 라이브 계산(캐시 없이)? + 지역 1개 다시 만들기의 Turso 읽기 비용(rows_read). 쓰기 없음.
 * --no-live 면 라이브 비교를 건너뛴다 (측정만, 읽기 절반).
 *
 * 다시 만들기 1회 = 기준 읽기(readRegionBuildBasis) + strict 계산 3개 + 조건부 쓰기 3개.
 * 쓰기 3개의 WHERE(지역 번호 + 달 목록 + 트리거 확인)는 드라이런이라 못 재므로 부분 비용으로 추정한다.
 * 변경 표시 표가 아직 없으면 지역 번호 읽기 행 수를 map_complex_recent 단지 수로 추정한다 (단지당 표시 1행이 상한).
 */
async function compare(n: number): Promise<void> {
  const meter = installTursoMeter();
  const db = getDb();
  if (!db) throw new Error("DB가 설정되지 않았습니다.");
  const withLive = !process.argv.includes("--no-live");
  const seoulDate = seoulToday();
  const yearMonth = yearMonthFromSeoulDate(seoulDate);
  meter.take();
  const schema = await readRegionDailySnapshotSchemaStatus(db, { includeSnapshotTable: false });
  const schemaCheck = meter.take();
  const marksTable = !schema.missing.includes("table:tx_change_marks");
  console.log(
    JSON.stringify({ trackingReady: schema.ready, missing: schema.missing, schemaCheckRowsRead: schemaCheck.rowsRead }),
  );
  let equal = 0;
  let different = 0;
  for (const region of sampleRegions(n)) {
    let strictMs = 0;
    let liveMs = 0;
    let bytes = 0;
    const strictRowsRead: Record<string, number> = {};
    let strictQueries = 0;
    let strictReturned = 0;
    const same: boolean[] = [];
    for (const part of REGION_DAILY_SNAPSHOT_PARTS) {
      clearRegionDailyCaches();
      meter.take();
      const t0 = Date.now();
      const strict = JSON.stringify(
        await computeRegionDailyStrict({ region, part, yearMonth, seoulDate }),
      );
      strictMs += Date.now() - t0;
      const c = meter.take();
      strictRowsRead[part] = c.rowsRead;
      strictQueries += c.queries;
      strictReturned += c.rowsReturned;
      bytes += strict.length;
      if (withLive) {
        const t1 = Date.now();
        const live = JSON.stringify(
          await computeRegionDailyLiveUncached({ region, part, yearMonth, seoulDate }),
        );
        liveMs += Date.now() - t1;
        meter.take();
        const ok = live === strict;
        same.push(ok);
        if (ok) equal += 1;
        else different += 1;
      }
    }
    // 달 목록 서브쿼리 (기준 읽기·스냅샷 읽기·쓰기 WHERE 에 모두 들어감)
    const months = regionMonthsKeySubquery(region.lawdCodes);
    meter.take();
    await db.execute({ sql: `SELECT ${months.sql} AS k`, args: months.args });
    const monthsRowsRead = meter.take().rowsRead;
    // 지역 번호 서브쿼리 — 표가 있으면 잰다, 없으면 단지 수로 추정
    let marksRowsRead: number;
    let marksMeasured = false;
    if (marksTable) {
      await readRegionBuildBasis(db, region);
      marksRowsRead = meter.take().rowsRead - monthsRowsRead;
      marksMeasured = true;
    } else {
      const est = await db.execute({
        sql: `SELECT COUNT(*) AS n FROM map_complex_recent WHERE lawd_cd IN (${region.lawdCodes.map(() => "?").join(",")})`,
        args: [...region.lawdCodes],
      });
      meter.take();
      marksRowsRead = Number(est.rows[0]?.n ?? 0);
    }
    const strictTotal = Object.values(strictRowsRead).reduce((a, b) => a + b, 0);
    const basis = marksRowsRead + monthsRowsRead + 2; // + 전역 번호 1행·빈 FROM
    const writes = REGION_DAILY_SNAPSHOT_PARTS.length * (marksRowsRead + monthsRowsRead + schemaCheck.rowsRead + 1);
    console.log(
      JSON.stringify({
        region: region.slug,
        lawds: region.lawdCodes.length,
        equal: withLive ? same : "skipped",
        strictMs,
        liveMs: withLive ? liveMs : null,
        strictQueries,
        strictRowsReturned: strictReturned,
        strictRowsRead,
        strictRowsReadTotal: strictTotal,
        monthsSubqueryRowsRead: monthsRowsRead,
        marksSubqueryRowsRead: marksRowsRead,
        marksMeasured,
        recomputeRowsReadEstimate: strictTotal + basis + writes,
        snapshotReadRowsReadEstimate: marksRowsRead + monthsRowsRead + 1,
        payloadBytes: bytes,
      }),
    );
    await sleep(300);
  }
  if (withLive) {
    console.log(JSON.stringify({ compare: equal + different, equal, different }));
    if (different > 0) process.exitCode = 1;
  }
}

/** 저장 행 표본: 스냅샷 읽기(쓸 수 있을 때) = 라이브 계산? 쓰기 없음. */
async function verify(n: number): Promise<void> {
  const db = getDb();
  if (!db) throw new Error("DB가 설정되지 않았습니다.");
  const seoulDate = seoulToday();
  const yearMonth = yearMonthFromSeoulDate(seoulDate);
  const res = await db.execute({
    sql: `SELECT region_slug, part FROM region_daily_snapshot
           WHERE year_month = ? ORDER BY random() LIMIT ?`,
    args: [yearMonth, n],
  });
  let usable = 0;
  let equal = 0;
  let different = 0;
  for (const row of res.rows) {
    const region = getRegion(String(row.region_slug));
    if (!region) continue;
    const part = String(row.part) as RegionDailySnapshotPart;
    const t0 = Date.now();
    const snap = await readRegionDailySnapshot<{
      contractMonthOptions: string[];
      activityYearMonths: string[];
    }>({ region, part, yearMonth, seoulDate });
    const snapMs = Date.now() - t0;
    const t1 = Date.now();
    const live = JSON.stringify(
      await computeRegionDailyLiveUncached({ region, part, yearMonth, seoulDate }),
    );
    const liveMs = Date.now() - t1;
    const ok = snap ? JSON.stringify(snap) === live : null;
    if (snap) usable += 1;
    if (ok === true) equal += 1;
    if (ok === false) different += 1;
    console.log(JSON.stringify({ region: region.slug, part, usable: snap != null, equal: ok, snapMs, liveMs }));
  }
  console.log(JSON.stringify({ verify: res.rows.length, usable, equal, different }));
  if (different > 0) process.exitCode = 1;
}

async function main() {
  const compareN = Number(arg("compare") ?? "0");
  if (compareN > 0) return compare(compareN);
  const verifyN = Number(arg("verify") ?? "0");
  if (verifyN > 0) return verify(verifyN);
  if (process.env.REGION_DAILY_SNAPSHOT_REFRESH === "0") {
    console.log("[region-daily-snapshot] REGION_DAILY_SNAPSHOT_REFRESH=0 — skip");
    return;
  }
  return refresh(process.argv.includes("--apply"));
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/build-region-daily-snapshot.ts")) {
  main()
    .then(() => process.exit(process.exitCode ?? 0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

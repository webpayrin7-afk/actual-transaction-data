/**
 * 지역 "새로 확인된 거래" 첫 화면 스냅샷(region_daily_snapshot) — 바뀐 지역만 다시 만든다.
 * 이 표 외에는 쓰지 않는다 (transactions·sync_months·tx_change_* 는 읽기만).
 * 거래 변경 표시(scripts/apply-tx-change-marks.ts)가 적용돼 있어야 한다 — 없으면 멈춘다.
 *
 *   npx tsx scripts/build-region-daily-snapshot.ts                     # 드라이런: 오래된 지역 고르고 계산만, 쓰기 없음
 *   npx tsx scripts/build-region-daily-snapshot.ts --apply             # 표/열 준비 + 바뀐 지역 저장 (기본 40지역·10분)
 *   npx tsx scripts/build-region-daily-snapshot.ts --apply --max-regions=80 --max-minutes=20
 *   npx tsx scripts/build-region-daily-snapshot.ts --regions=seoul-mapo,gyeonggi-suwon --apply --force
 *   npx tsx scripts/build-region-daily-snapshot.ts --verify=20        # 저장 행 20개: 스냅샷 읽기 = 라이브 계산? (읽기만)
 *   npx tsx scripts/build-region-daily-snapshot.ts --compare=12       # strict 계산 = 라이브 계산? + 지역당 읽기 비용 (읽기만, 표 불필요)
 *
 * 동기화 워크플로(.github/workflows/sync-molit.yml)가 sync 뒤에 --apply 로 부른다.
 * 끄기: REGION_DAILY_SNAPSHOT_REFRESH=0
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import type { Client } from "@libsql/client";
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
  readRegionDailySnapshot,
  refreshRegionDailySnapshots,
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
  // 거래 변경 표시가 없으면 아무것도 하지 않는다 (표·열도 건드리지 않음). 읽기는 라이브로 간다.
  const marks = await db.execute(
    `SELECT COUNT(*) AS n FROM sqlite_master
      WHERE type = 'table' AND name IN ('tx_change_seq', 'tx_change_marks')`,
  );
  if (Number(marks.rows[0]?.n) !== 2) {
    console.log(
      "[region-daily-snapshot] 거래 변경 표시(tx_change_*) 미적용 — 건너뜀 (npx tsx scripts/apply-tx-change-marks.ts --apply)",
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

/** 읽은 행 수를 세도록 client.execute 를 감싼다 (측정 전용). */
function countRows(db: Client): { take: () => { queries: number; rows: number } } {
  let queries = 0;
  let rows = 0;
  const orig = db.execute.bind(db) as (...a: unknown[]) => Promise<{ rows: unknown[] }>;
  (db as unknown as { execute: (...a: unknown[]) => Promise<unknown> }).execute = async (
    ...a: unknown[]
  ) => {
    const res = await orig(...a);
    queries += 1;
    rows += res.rows.length;
    return res;
  };
  return {
    take: () => {
      const out = { queries, rows };
      queries = 0;
      rows = 0;
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

/** strict 계산 = 라이브 계산(캐시 없이)? + 지역당 읽기 비용. 쓰기 없음. */
async function compare(n: number): Promise<void> {
  const db = getDb();
  if (!db) throw new Error("DB가 설정되지 않았습니다.");
  const counter = countRows(db);
  const seoulDate = seoulToday();
  const yearMonth = yearMonthFromSeoulDate(seoulDate);
  let equal = 0;
  let different = 0;
  for (const region of sampleRegions(n)) {
    let strictMs = 0;
    let q = 0;
    let rows = 0;
    let bytes = 0;
    let liveMs = 0;
    const same: boolean[] = [];
    for (const part of REGION_DAILY_SNAPSHOT_PARTS) {
      clearRegionDailyCaches();
      counter.take();
      const t0 = Date.now();
      const strict = JSON.stringify(
        await computeRegionDailyStrict({ region, part, yearMonth, seoulDate }),
      );
      strictMs += Date.now() - t0;
      const c = counter.take();
      q += c.queries;
      rows += c.rows;
      bytes += strict.length;
      const t1 = Date.now();
      const live = JSON.stringify(
        await computeRegionDailyLiveUncached({ region, part, yearMonth, seoulDate }),
      );
      liveMs += Date.now() - t1;
      counter.take();
      const ok = live === strict;
      same.push(ok);
      if (ok) equal += 1;
      else different += 1;
    }
    console.log(
      JSON.stringify({
        region: region.slug,
        lawds: region.lawdCodes.length,
        equal: same,
        strictMs,
        liveMs,
        queries: q,
        rowsReturned: rows,
        payloadBytes: bytes,
      }),
    );
    await sleep(300);
  }
  console.log(JSON.stringify({ compare: equal + different, equal, different }));
  if (different > 0) process.exitCode = 1;
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

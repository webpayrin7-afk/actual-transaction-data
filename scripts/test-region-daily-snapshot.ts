/**
 * 지역 "새로 확인된 거래" 스냅샷 — 저장·읽기·신선도·strict 규칙 (로컬 file DB).
 * production Turso에 연결하지 않는다.
 *
 *   npx tsx scripts/test-region-daily-snapshot.ts
 */
import { resolve } from "node:path";
import { existsSync, unlinkSync } from "node:fs";
import assert from "node:assert/strict";

const dbPath = resolve("data/test-region-daily-snapshot.db");
for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
  if (existsSync(p)) unlinkSync(p);
}
process.env.TURSO_DATABASE_URL = `file:${dbPath}`;
delete process.env.TURSO_AUTH_TOKEN;
delete process.env.MOLIT_API_KEY;

import { getRegion } from "../src/lib/constants/regions";
import { ensureSchema, getDb } from "../src/lib/db/client";
import { replaceMonthTransactions } from "../src/lib/db/repository";
import { applyTxChangeTracking } from "../src/lib/db/tx-change-schema";
import { TX_CHANGE_TRIGGERS } from "../src/lib/db/tx-change-status";
import { seoulToday, yearMonthFromSeoulDate } from "../src/lib/market/time";
import {
  clearRegionDailyCaches,
  computeRegionDailyLiveUncached,
  computeRegionDailyStrict,
  getRegionDaily,
} from "../src/lib/molit/service";
import {
  REGION_DAILY_SNAPSHOT_PARTS,
  readRegionDailySnapshot,
  readRegionDailySnapshotSchemaStatus,
  refreshRegionDailySnapshots,
  resetRegionDailySnapshotGate,
  snapshotDateUsable,
  type RegionDailySnapshotCompute,
} from "../src/lib/region/region-daily-snapshot";
import { ensureRegionDailySnapshotTable } from "../src/lib/region/region-daily-snapshot-schema";
import { shiftYearMonth } from "../src/lib/region/market-insight";
import type { Transaction } from "../src/types/transaction";

function tx(
  partial: Partial<Transaction> & Pick<Transaction, "id" | "dealAmount" | "dealDate">,
): Transaction {
  return {
    id: partial.id,
    dealType: "trade",
    dealDate: partial.dealDate,
    aptName: partial.aptName ?? "테스트아파트",
    gu: "강남구",
    dong: "대치동",
    exclusiveArea: partial.exclusiveArea ?? 84.9,
    dealAmount: partial.dealAmount,
    monthlyRent: 0,
    floor: partial.floor ?? 10,
    buildYear: 2010,
    jibun: "1-1",
    dealingGbn: "중개거래",
    lawdCd: "11680",
  };
}

function ymToDate(ym: string, day: number): string {
  return `${ym.slice(0, 4)}-${ym.slice(4, 6)}-${String(day).padStart(2, "0")}`;
}

async function main() {
  assert.ok(process.env.TURSO_DATABASE_URL?.startsWith("file:"), "로컬 file DB 만");
  const db = getDb()!;
  await ensureSchema(db);
  // production 에만 있는 열(다른 마이그레이션) — 읽기 쿼리가 고른다
  const txCols = new Set(
    (await db.execute(`PRAGMA table_info(transactions)`)).rows.map((r) => String(r.name)),
  );
  for (const col of ["rgst_date", "apt_dong"]) {
    if (!txCols.has(col)) await db.execute(`ALTER TABLE transactions ADD COLUMN ${col} TEXT`);
  }
  const region = getRegion("seoul-gangnam")!;
  assert.deepEqual([...region.lawdCodes], ["11680"]);
  const today = seoulToday();
  const ym = yearMonthFromSeoulDate(today);
  const prevYm = shiftYearMonth(ym, -1);
  const day = Number(today.slice(8, 10));

  const opts = {
    db,
    regions: [region],
    compute: computeRegionDailyStrict as RegionDailySnapshotCompute,
    seoulDate: today,
    yearMonth: ym,
    currentSeoulDate: () => seoulToday(),
    apply: true,
    maxRegions: 10,
    maxMs: 60_000,
    minRebuildMs: 0,
  };

  /** db.execute 호출 수 세기 (스키마 없을 때 요청마다 실패 쿼리를 보내지 않는지) */
  let executes = 0;
  const origExecute = db.execute.bind(db);
  (db as unknown as { execute: typeof db.execute }).execute = ((...a: Parameters<typeof db.execute>) => {
    executes += 1;
    return origExecute(...a);
  }) as typeof db.execute;
  const readLatest = () =>
    readRegionDailySnapshot({ region, part: "latest", yearMonth: ym, seoulDate: today });

  // 0-a) 옛 표(새 열 없음) + 변경 표시 없음: 읽기는 null, 확인 1번 뒤로는 쿼리 0 (캐시)
  await db.execute(
    `CREATE TABLE region_daily_snapshot (region_slug TEXT NOT NULL, part TEXT NOT NULL, year_month TEXT NOT NULL,
       seoul_date TEXT NOT NULL, source_sync TEXT NOT NULL, content_hash TEXT NOT NULL, built_at TEXT NOT NULL,
       payload TEXT NOT NULL, PRIMARY KEY (region_slug, part, year_month))`,
  );
  resetRegionDailySnapshotGate();
  executes = 0;
  assert.equal(await readLatest(), null);
  assert.equal(executes, 1, "sqlite_master 확인 1번만 (스냅샷 SELECT 없음)");
  for (let i = 0; i < 5; i++) assert.equal(await readLatest(), null);
  assert.equal(executes, 1, "없음은 캐시 — 요청마다 쿼리 없음");
  const oldStatus = await readRegionDailySnapshotSchemaStatus(db);
  assert.ok(oldStatus.missing.includes("column:region_daily_snapshot.tx_mark"));
  assert.ok(oldStatus.missing.includes(`trigger:${TX_CHANGE_TRIGGERS[0]}`));

  // 0-b) 표·열은 있고 변경 표시 없음: 빌더는 멈춘다(저장 없음), 읽기는 null
  await ensureRegionDailySnapshotTable(db);
  await ensureRegionDailySnapshotTable(db); // 두 번 돌려도 무해
  await assert.rejects(refreshRegionDailySnapshots(opts), /tx change tracking not installed/);
  resetRegionDailySnapshotGate();
  assert.equal(await readLatest(), null);

  await applyTxChangeTracking(db);
  const readyStatus = await readRegionDailySnapshotSchemaStatus(db);
  assert.deepEqual(readyStatus, { ready: true, missing: [] });

  // 0-c) 표는 있고 트리거 하나가 빠짐: 빌더 멈춤, 읽기 null (표만으로는 믿지 않음)
  await db.execute(`DROP TRIGGER ${TX_CHANGE_TRIGGERS[1]}`);
  await assert.rejects(refreshRegionDailySnapshots(opts), /trigger:trg_tx_change_au(,|$)/);
  resetRegionDailySnapshotGate();
  assert.equal(await readLatest(), null);
  await applyTxChangeTracking(db); // 다시 설치 (IF NOT EXISTS)
  resetRegionDailySnapshotGate();

  // 지난 달(오늘 전 확인) + 이번 달 거래 — 같은 단지·면적 이력 있어 신고가 판정도 돈다
  const prev: Transaction[] = [];
  for (let i = 0; i < 12; i++) {
    prev.push(
      tx({ id: `p${i}`, dealDate: ymToDate(prevYm, 1 + i), dealAmount: 100000 + i * 100, aptName: i % 2 ? "A단지" : "B단지" }),
    );
  }
  await replaceMonthTransactions({ lawdCd: "11680", yearMonth: prevYm, dealKind: "trade", items: prev, setFirstSeenOnInsert: false });
  const cur: Transaction[] = [];
  for (let i = 0; i < 8; i++) {
    cur.push(
      tx({ id: `c${i}`, dealDate: ymToDate(ym, Math.max(1, Math.min(day, 1 + i))), dealAmount: 101000 + i * 500, aptName: i % 2 ? "A단지" : "B단지", floor: 3 + i }),
    );
  }
  await replaceMonthTransactions({ lawdCd: "11680", yearMonth: ym, dealKind: "trade", items: cur });

  /** sync 밖 직접 UPDATE — 지난 달 거래 n번째 한 행 */
  async function bumpPrevRow(n: number) {
    const res = await db.execute({
      sql: `UPDATE transactions SET deal_amount = deal_amount + 1
             WHERE id = (SELECT id FROM transactions WHERE year_month = ? ORDER BY id LIMIT 1 OFFSET ?)`,
      args: [prevYm, n],
    });
    assert.equal(res.rowsAffected, 1);
  }

  async function assertSnapshotEqualsLive(label: string, seoulDate = today) {
    for (const part of REGION_DAILY_SNAPSHOT_PARTS) {
      const snap = await readRegionDailySnapshot({ region, part, yearMonth: ym, seoulDate });
      assert.ok(snap, `${label}: ${part} 스냅샷 없음`);
      const live = await computeRegionDailyLiveUncached({ region, part, yearMonth: ym, seoulDate });
      assert.equal(JSON.stringify(snap), JSON.stringify(live), `${label}: ${part} 다름`);
    }
  }
  async function assertAllNull(label: string) {
    for (const part of REGION_DAILY_SNAPSHOT_PARTS) {
      assert.equal(
        await readRegionDailySnapshot({ region, part, yearMonth: ym, seoulDate: today }),
        null,
        `${label}: ${part} 는 라이브로 가야 함`,
      );
    }
  }

  // 1) 처음: 행 없음 → 만들고 저장, 읽기 = 라이브
  const s1 = await refreshRegionDailySnapshots(opts);
  assert.equal(s1.staleByReason.missing, 1);
  assert.equal(s1.built, 1);
  assert.equal(s1.rowsWritten, 3);
  await assertSnapshotEqualsLive("처음");
  const latestLive = await computeRegionDailyLiveUncached({ region, part: "latest", yearMonth: ym, seoulDate: today });
  assert.equal(latestLive.latestIsToday, true, "오늘 확인 거래가 있어야 함");
  assert.ok(latestLive.deals.length > 0);

  // getRegionDaily 첫 화면도 같은 값 (스냅샷 경로)
  for (const part of REGION_DAILY_SNAPSHOT_PARTS) {
    clearRegionDailyCaches();
    const viaApi = await getRegionDaily({ regionSlug: region.slug, part });
    const live = await computeRegionDailyLiveUncached({ region, part, yearMonth: ym, seoulDate: today });
    assert.equal(JSON.stringify(viaApi), JSON.stringify(live));
  }

  // 1-b) 저장된 스냅샷이 있어도 트리거가 사라지면: 확인(캐시 만료 = 여기선 reset) 뒤 읽기 null
  await db.execute(`DROP TRIGGER ${TX_CHANGE_TRIGGERS[3]}`);
  resetRegionDailySnapshotGate();
  await assertAllNull("트리거 없음");
  //      캐시가 살아 있는 동안은 확인 쿼리 없이 스냅샷 SELECT 1번 (트리거 다시 설치 후)
  await applyTxChangeTracking(db);
  resetRegionDailySnapshotGate();
  assert.ok(await readLatest());
  executes = 0;
  assert.ok(await readLatest());
  assert.equal(executes, 1, "있음 캐시 — 스냅샷 SELECT 1번만");

  // 2) 바뀐 것 없음 → 다시 만들지 않음 (전역 번호 같음 → 번호 확인도 생략)
  const s2 = await refreshRegionDailySnapshots(opts);
  assert.equal(s2.fresh, 1);
  assert.equal(s2.built, 0);
  assert.equal(s2.rowsWritten, 0);

  // 3) sync 경로로 거래 바뀜 → 읽기는 라이브, 1시간 안이면 다시 만들지 않음, 지나면 다시 만듦
  cur[0] = { ...cur[0]!, dealAmount: 250000 };
  const r3 = await replaceMonthTransactions({ lawdCd: "11680", yearMonth: ym, dealKind: "trade", items: cur });
  assert.equal(r3.wrote, true);
  await assertAllNull("sync 변경 뒤");
  const s3a = await refreshRegionDailySnapshots({ ...opts, minRebuildMs: 60 * 60_000 });
  assert.equal(s3a.staleByReason.mark, 1);
  assert.equal(s3a.skippedRecent, 1);
  assert.equal(s3a.built, 0);
  const s3b = await refreshRegionDailySnapshots(opts);
  assert.equal(s3b.built, 1);
  await assertSnapshotEqualsLive("sync 변경 후 다시 만듦");

  // 4) sync 밖 직접 UPDATE (scripts/fixes 식) → 라이브로
  await bumpPrevRow(3);
  await assertAllNull("직접 UPDATE 뒤");
  await refreshRegionDailySnapshots(opts);
  await assertSnapshotEqualsLive("직접 UPDATE 후 다시 만듦");

  // 5) sync_months 만 바뀜(거래 번호 그대로) → 달 목록을 라이브처럼 다시 만들어 같은 값
  await db.execute(
    `INSERT INTO sync_months (lawd_cd, year_month, deal_kind, synced_at, row_count)
     VALUES ('11680', '${shiftYearMonth(ym, -5)}', 'trade', '2026-01-01T00:00:00Z', 7)`,
  );
  await assertSnapshotEqualsLive("달 목록만 바뀜");
  const hist = await readRegionDailySnapshot<{ contractMonthOptions: string[]; activityYearMonths: string[] }>({
    region, part: "history", yearMonth: ym, seoulDate: today,
  });
  assert.ok(hist!.contractMonthOptions.includes(shiftYearMonth(ym, -5)));

  // 6) 날짜 규칙
  assert.equal(snapshotDateUsable({ yearMonth: ym, seoulDate: today, heroDate: today, heroIsToday: true }, today), true);
  assert.equal(snapshotDateUsable({ yearMonth: "202609", seoulDate: "2026-09-10", heroDate: "2026-09-10", heroIsToday: true }, "2026-09-11"), false);
  assert.equal(snapshotDateUsable({ yearMonth: "202609", seoulDate: "2026-09-10", heroDate: "2026-09-08", heroIsToday: false }, "2026-09-11"), true);
  assert.equal(snapshotDateUsable({ yearMonth: "202609", seoulDate: "2026-09-10", heroDate: "2026-09-12", heroIsToday: false }, "2026-09-11"), false);
  assert.equal(snapshotDateUsable({ yearMonth: "202609", seoulDate: "2026-09-10", heroDate: null, heroIsToday: false }, "2026-09-30"), true);
  assert.equal(snapshotDateUsable({ yearMonth: "202609", seoulDate: "2026-09-10", heroDate: null, heroIsToday: false }, "2026-10-01"), false);
  assert.equal(snapshotDateUsable({ yearMonth: "202609", seoulDate: "2026-09-10", heroDate: null, heroIsToday: false }, "2026-09-09"), false);
  // 내일(같은 달): latest(오늘 확인됨)는 라이브로, history·days(확인일 없음)는 스냅샷 = 내일 기준 라이브
  const tomorrow = new Date(Date.parse(`${today}T12:00:00+09:00`) + 86_400_000);
  const tomorrowStr = seoulToday(tomorrow);
  if (yearMonthFromSeoulDate(tomorrowStr) === ym) {
    assert.equal(
      await readRegionDailySnapshot({ region, part: "latest", yearMonth: ym, seoulDate: tomorrowStr }),
      null,
    );
    for (const part of ["history", "days"] as const) {
      const snap = await readRegionDailySnapshot({ region, part, yearMonth: ym, seoulDate: tomorrowStr });
      const live = await computeRegionDailyLiveUncached({ region, part, yearMonth: ym, seoulDate: tomorrowStr });
      assert.ok(snap);
      assert.equal(JSON.stringify(snap), JSON.stringify(live));
    }
  }

  // 7) strict: DB 읽기 에러는 던지고(라이브는 삼킴), 빌더는 그 지역을 저장하지 않는다
  await bumpPrevRow(4);
  await db.execute(`ALTER TABLE sync_months RENAME TO sync_months_off`);
  await assert.rejects(computeRegionDailyStrict({ region, part: "history", yearMonth: ym, seoulDate: today }));
  const degraded = await computeRegionDailyLiveUncached({ region, part: "history", yearMonth: ym, seoulDate: today });
  assert.ok(degraded, "라이브는 열화 결과로라도 응답");
  const beforeRows = await db.execute(`SELECT part, tx_mark, built_at FROM region_daily_snapshot ORDER BY part`);
  const s7 = await refreshRegionDailySnapshots(opts);
  assert.deepEqual(s7.failures, [region.slug]);
  assert.equal(s7.rowsWritten, 0);
  const afterRows = await db.execute(`SELECT part, tx_mark, built_at FROM region_daily_snapshot ORDER BY part`);
  assert.deepEqual(JSON.stringify(afterRows.rows), JSON.stringify(beforeRows.rows));
  await db.execute(`ALTER TABLE sync_months_off RENAME TO sync_months`);
  await assertAllNull("에러 뒤(옛 행은 번호가 달라 안 쓰임)");

  //    계산 하나가 던지면 그 지역 3행 모두 저장 안 함
  const throwingCompute: RegionDailySnapshotCompute = async (p) => {
    if (p.part === "days") throw new Error("boom");
    return computeRegionDailyStrict(p);
  };
  const s7b = await refreshRegionDailySnapshots({ ...opts, compute: throwingCompute });
  assert.equal(s7b.rowsWritten, 0);
  await assertAllNull("계산 에러 뒤");

  // 8) 계산 도중 거래가 바뀜 → 조건부 쓰기가 막음
  const racingCompute: RegionDailySnapshotCompute = async (p) => {
    const out = await computeRegionDailyStrict(p);
    if (p.part === "days") {
      await bumpPrevRow(5);
    }
    return out;
  };
  const s8 = await refreshRegionDailySnapshots({ ...opts, compute: racingCompute });
  assert.equal(s8.raced, 1);
  assert.equal(s8.rowsWritten, 0);
  await assertAllNull("도중 변경 뒤");

  //    계산 도중 트리거가 지워짐 → 조건부 쓰기의 트리거 확인이 막음
  const dropTriggerCompute: RegionDailySnapshotCompute = async (p) => {
    const out = await computeRegionDailyStrict(p);
    if (p.part === "days") await db.execute(`DROP TRIGGER ${TX_CHANGE_TRIGGERS[0]}`);
    return out;
  };
  const s8b = await refreshRegionDailySnapshots({ ...opts, compute: dropTriggerCompute });
  assert.equal(s8b.raced, 1);
  assert.equal(s8b.rowsWritten, 0);
  await applyTxChangeTracking(db);
  resetRegionDailySnapshotGate();
  await assertAllNull("트리거 지워진 도중 뒤");

  // 9) 다시 정상 → 같은 값, 지난 달 행은 지움
  await db.execute(
    `INSERT INTO region_daily_snapshot (region_slug, part, year_month, seoul_date, source_sync, content_hash, built_at, payload)
     VALUES ('seoul-gangnam', 'latest', '${prevYm}', '${ymToDate(prevYm, 28)}', '', 'x', 'x', '{}')`,
  );
  const s9 = await refreshRegionDailySnapshots(opts);
  assert.equal(s9.built, 1);
  assert.equal(s9.deletedOldMonths, 1);
  await assertSnapshotEqualsLive("마지막");

  // 10) 끄기 스위치
  process.env.ZIPLAB_REGION_DAILY_SNAPSHOT = "0";
  assert.equal(await readRegionDailySnapshot({ region, part: "latest", yearMonth: ym, seoulDate: today }), null);
  delete process.env.ZIPLAB_REGION_DAILY_SNAPSHOT;

  console.log("test-region-daily-snapshot: all passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

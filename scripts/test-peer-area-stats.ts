/**
 * 단지 비교 후보 면적 집계 스냅샷 — 갱신·게시·신선도·라이브 폴백 (로컬 file DB).
 * production Turso에 연결하지 않는다.
 *
 *   npx tsx scripts/test-peer-area-stats.ts
 */
import { resolve } from "node:path";
import { unlinkSync, existsSync } from "node:fs";
import assert from "node:assert/strict";

const dbPath = resolve("data/test-peer-area-stats.db");
for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
  if (existsSync(p)) unlinkSync(p);
}

process.env.TURSO_DATABASE_URL = `file:${dbPath}`;
delete process.env.TURSO_AUTH_TOKEN;
delete process.env.MOLIT_API_KEY;

import type { Client } from "@libsql/client";
import { ensureSchema, getDb } from "../src/lib/db/client";
import { rebuildAptCatalog, replaceMonthTransactions } from "../src/lib/db/repository";
import { applyTxChangeTracking } from "../src/lib/db/tx-change-schema";
import { districtNameFromCode } from "../src/lib/constants/regions";
import {
  allPeerAreaLawdCodes,
  refreshPeerAreaStats,
} from "../src/lib/complex-detail/peer-area-stats-refresh";
import {
  debugLoadComparePeerAreaRows,
  selectComparePeers,
} from "../src/lib/complex-detail/select-compare-peers";
import type { Transaction } from "../src/types/transaction";

let idSeq = 0;
function tx(p: {
  lawdCd: string;
  gu: string;
  dong: string;
  aptName: string;
  area: number;
  buildYear: number | null;
  dealDate: string;
  amount?: number;
}): Transaction {
  idSeq += 1;
  return {
    id: `t${idSeq}`,
    dealType: "trade",
    dealDate: p.dealDate,
    aptName: p.aptName,
    gu: p.gu,
    dong: p.dong,
    exclusiveArea: p.area,
    dealAmount: p.amount ?? 100000 + idSeq,
    monthlyRent: 0,
    floor: (idSeq % 20) + 1,
    buildYear: p.buildYear as number,
    jibun: `${idSeq}-1`,
    dealingGbn: "중개거래",
    lawdCd: p.lawdCd,
  };
}

async function setupExtraSchema(db: Client) {
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_tx_trade_lawd_apt_ym
    ON transactions (lawd_cd, apt_name_norm, year_month, floor, deal_amount, exclusive_area)
    WHERE deal_type = 'trade'`);
  await db.execute(`CREATE TABLE IF NOT EXISTS apt_complex_master (
    complex_id TEXT PRIMARY KEY, apt_name TEXT NOT NULL, apt_name_norm TEXT NOT NULL,
    sigungu TEXT, lawd_cd TEXT NOT NULL, legal_dong_name TEXT)`);
  await db.execute(`CREATE TABLE IF NOT EXISTS apt_complex_profile (
    complex_id TEXT PRIMARY KEY, household_count INTEGER)`);
}

const GANGNAM = "11680";

async function load(month: string, lawdCd: string, gu: string, items: Transaction[]) {
  await replaceMonthTransactions({ lawdCd, yearMonth: month, dealKind: "trade", items });
}

type Input = Parameters<typeof selectComparePeers>[0];

async function assertSame(input: Input, expectSource: "snapshot" | "live", label: string) {
  const d = await debugLoadComparePeerAreaRows(input);
  assert.ok(d?.fast && d.sequential, `${label}: loaded`);
  assert.equal(d.fast.areaSource, expectSource, `${label}: source`);
  assert.deepEqual(d.fast.areaRows, d.sequential.areaRows, `${label}: area rows`);
  assert.deepEqual(
    d.fast.catalog.map((c) => c.aptNameNorm),
    d.sequential.catalog.map((c) => c.aptNameNorm),
    `${label}: catalog`,
  );
}

async function main() {
  const db = getDb()!;
  await ensureSchema(db);
  await setupExtraSchema(db);

  // 강남구: 대치동 단지 6개 + 역삼동 3개, 면적·준공연도 섞어서(동률 건수 포함, NULL 준공연도 포함)
  const items: Transaction[] = [];
  const apts = [
    ["대치동", "은마", 1979],
    ["대치동", "래미안대치팰리스", 2015],
    ["대치동", "대치아이파크", 2008],
    ["대치동", "한보미도맨션", 1983],
    ["대치동", "선경", null],
    ["대치동", "개포우성1", 1983],
    ["역삼동", "역삼래미안", 2005],
    ["역삼동", "역삼푸르지오", 2006],
    ["역삼동", "개나리래미안", 2006],
  ] as const;
  for (const [i, [dong, name, by]] of apts.entries()) {
    for (let k = 0; k < 3 + (i % 3); k++) {
      for (const area of [59.9, 84.97, 114.2 + i]) {
        items.push(
          tx({ lawdCd: GANGNAM, gu: "강남구", dong, aptName: name, area, buildYear: by, dealDate: `2026-08-${String(10 + k).padStart(2, "0")}` }),
        );
      }
    }
  }
  await load("202608", GANGNAM, "강남구", items);
  await rebuildAptCatalog();

  const input: Input = {
    aptName: "은마",
    gu: "강남구",
    dong: "대치동",
    targetExclusiveCenter: 84.97,
    buildYear: 1979,
    householdCount: null,
  };

  // 1) 스냅샷 표·번호 표 없음 → 빠른 길 에러 → selectComparePeers 는 라이브로 같은 결과
  const liveOnly = await selectComparePeers(input);
  assert.ok(liveOnly.length > 0, "peers found");

  // 2) 변경 표시 없이 갱신 → 에러(아무것도 게시하지 않음)
  await assert.rejects(refreshPeerAreaStats(db, { lawdCodes: [GANGNAM], pauseMs: 0 }));

  // 3) 변경 표시 설치 뒤: 게시 전에는 라이브
  await applyTxChangeTracking(db);
  await load("202608", GANGNAM, "강남구", [
    ...items,
    tx({ lawdCd: GANGNAM, gu: "강남구", dong: "대치동", aptName: "은마", area: 76.79, buildYear: 1979, dealDate: "2026-08-20" }),
  ]);
  await rebuildAptCatalog();
  await refreshPeerAreaStats(db, { lawdCodes: ["11110"], pauseMs: 0 }); // 표 만들기용(다른 코드)
  await assertSame(input, "live", "before publish");

  // 4) 게시 → 스냅샷, 라이브와 같음
  const r1 = await refreshPeerAreaStats(db, { lawdCodes: [GANGNAM], pauseMs: 0 });
  assert.equal(r1.lawdPublished, 1);
  assert.ok(r1.upserted > 0);
  await assertSame(input, "snapshot", "after publish");

  // 다시 돌리면 할 일 없음(쓰기 0)
  const r2 = await refreshPeerAreaStats(db, { lawdCodes: [GANGNAM], pauseMs: 0 });
  assert.equal(r2.lawdRebuilt, 0);

  // 5) 새 거래 → 라이브, 갱신은 바뀐 단지만
  await load("202609", GANGNAM, "강남구", [
    tx({ lawdCd: GANGNAM, gu: "강남구", dong: "대치동", aptName: "선경", area: 84.97, buildYear: null, dealDate: "2026-09-02" }),
  ]);
  await assertSame(input, "live", "after new trade");
  const r3 = await refreshPeerAreaStats(db, { lawdCodes: [GANGNAM], pauseMs: 0 });
  assert.equal(r3.lawdPublished, 1);
  assert.equal(r3.keysSeen, 1, "only changed complex recomputed");
  assert.equal(r3.upserted, 1);
  await assertSame(input, "snapshot", "after incremental");

  // 6) sync 밖 직접 UPDATE(스크립트 수정) → 라이브
  await db.execute(
    `UPDATE transactions SET exclusive_area = 84.98 WHERE apt_name_norm = (SELECT apt_name_norm FROM apt_catalog WHERE apt_name = '역삼래미안' LIMIT 1) AND exclusive_area = 84.97`,
  );
  await assertSame(input, "live", "after direct update");

  // 7) 집계 도중 거래가 바뀜 → 게시 안 함(라이브 유지), 다음 갱신에서 게시
  let injected = false;
  const racing = new Proxy(db, {
    get(target, prop, recv) {
      if (prop === "execute") {
        return async (stmt: Parameters<Client["execute"]>[0]) => {
          const res = await target.execute(stmt);
          const sql = typeof stmt === "string" ? stmt : (stmt as { sql: string }).sql;
          if (!injected && sql.includes("FROM transactions INDEXED BY")) {
            injected = true;
            await load("202609", GANGNAM, "강남구", [
              tx({ lawdCd: GANGNAM, gu: "강남구", dong: "대치동", aptName: "선경", area: 84.97, buildYear: null, dealDate: "2026-09-02" }),
              tx({ lawdCd: GANGNAM, gu: "강남구", dong: "대치동", aptName: "은마", area: 84.43, buildYear: 1979, dealDate: "2026-09-05" }),
            ]);
          }
          return res;
        };
      }
      const v = Reflect.get(target, prop, recv) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  const r4 = await refreshPeerAreaStats(racing, { lawdCodes: [GANGNAM], pauseMs: 0 });
  assert.ok(injected);
  assert.deepEqual(r4.changedDuringBuild, [GANGNAM]);
  assert.equal(r4.lawdPublished, 0);
  await assertSame(input, "live", "changed during build");
  const r5 = await refreshPeerAreaStats(db, { lawdCodes: [GANGNAM], pauseMs: 0 });
  assert.equal(r5.lawdPublished, 1);
  await assertSame(input, "snapshot", "after re-publish");

  // 8) 집계 읽기 실패 → 쓰기 0, 번호 그대로(라이브), failures 에 코드
  await load("202609", GANGNAM, "강남구", [
    tx({ lawdCd: GANGNAM, gu: "강남구", dong: "대치동", aptName: "은마", area: 84.43, buildYear: 1979, dealDate: "2026-09-05" }),
  ]);
  const before = await db.execute(`SELECT COUNT(*) n, MAX(built_at) b FROM apt_trade_area_stats`);
  const failing = new Proxy(db, {
    get(target, prop, recv) {
      if (prop === "execute") {
        return async (stmt: Parameters<Client["execute"]>[0]) => {
          const sql = typeof stmt === "string" ? stmt : (stmt as { sql: string }).sql;
          if (sql.includes("FROM transactions INDEXED BY")) throw new Error("simulated read failure");
          return target.execute(stmt);
        };
      }
      const v = Reflect.get(target, prop, recv) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  const r6 = await refreshPeerAreaStats(failing, { lawdCodes: [GANGNAM], pauseMs: 0 });
  assert.deepEqual(r6.failures, [GANGNAM]);
  const after = await db.execute(`SELECT COUNT(*) n, MAX(built_at) b FROM apt_trade_area_stats`);
  assert.deepEqual(after.rows[0], before.rows[0], "no writes on failed read");
  await assertSame(input, "live", "after failed refresh");
  await refreshPeerAreaStats(db, { lawdCodes: [GANGNAM], pauseMs: 0 });
  await assertSame(input, "snapshot", "recovered");

  // 9) 단지 전체 삭제(거래 0) → 스냅샷 행 삭제, 라이브와 같음
  await db.execute(`DELETE FROM transactions WHERE apt_name = '한보미도맨션'`);
  await assertSame(input, "live", "after delete");
  const r7 = await refreshPeerAreaStats(db, { lawdCodes: [GANGNAM], pauseMs: 0 });
  assert.ok(r7.deleted >= 1);
  await assertSame(input, "snapshot", "after delete refresh");

  // 10) 여러 법정동코드가 같은 구 이름(예: 중구) — 코드 하나만 게시되면 라이브, 둘 다면 스냅샷
  const junggu = allPeerAreaLawdCodes().filter((c) => districtNameFromCode(c) === "중구");
  if (junggu.length >= 2) {
    const [c1, c2] = junggu;
    const j: Transaction[] = [];
    for (const [code, names] of [
      [c1!, ["신당삼성", "남산타운"]],
      [c2!, ["중앙하이츠", "영주대림"]],
    ] as const) {
      for (const name of names)
        for (const area of [59.9, 84.9, 84.9])
          j.push(tx({ lawdCd: code, gu: "중구", dong: "신당동", aptName: name, area, buildYear: 2000, dealDate: "2026-08-11" }));
    }
    await load("202608", c1!, "중구", j.filter((t) => t.lawdCd === c1));
    await load("202608", c2!, "중구", j.filter((t) => t.lawdCd === c2));
    await rebuildAptCatalog();
    const jin: Input = { aptName: "신당삼성", gu: "중구", dong: "신당동", targetExclusiveCenter: 84.9, buildYear: 2000, householdCount: null };
    await refreshPeerAreaStats(db, { lawdCodes: [c1!], pauseMs: 0 });
    await assertSame(jin, "live", "only one code published");
    await refreshPeerAreaStats(db, { lawdCodes: junggu.filter((c) => c !== c1), pauseMs: 0 });
    await assertSame(jin, "snapshot", "all codes published");
  }

  console.log("[test-peer-area-stats] OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

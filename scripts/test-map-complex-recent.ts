/**
 * 지도 단지 최근 거래 스냅샷(map_complex_recent) 신선도·갱신 테스트 (로컬 file DB).
 * production Turso에 연결하지 않는다.
 *
 *   npx tsx scripts/test-map-complex-recent.ts
 */
import { resolve } from "node:path";
import { unlinkSync, existsSync } from "node:fs";
import assert from "node:assert/strict";

const dbPath = resolve("data/test-map-complex-recent.db");
for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
  if (existsSync(p)) unlinkSync(p);
}

process.env.TURSO_DATABASE_URL = `file:${dbPath}`;
delete process.env.TURSO_AUTH_TOKEN;
delete process.env.MOLIT_API_KEY;

import type { Client, InStatement } from "@libsql/client";
import { ensureSchema, getDb } from "../src/lib/db/client";
import { replaceMonthTransactions } from "../src/lib/db/repository";
import { applyTxChangeTracking } from "../src/lib/db/tx-change-schema";
import {
  MAP_RECENT_TABLE,
  mapRecentLawdsToRefresh,
  readMapRecentDeals,
  refreshMapComplexRecent,
} from "../src/lib/map/map-complex-recent";
import type { Transaction } from "../src/types/transaction";

function tx(
  partial: Partial<Transaction> & Pick<Transaction, "id" | "dealAmount" | "dealDate">,
): Transaction {
  return {
    id: partial.id,
    dealType: partial.dealType ?? "trade",
    dealDate: partial.dealDate,
    aptName: partial.aptName ?? "A단지",
    gu: partial.gu ?? "강남구",
    dong: partial.dong ?? "대치동",
    exclusiveArea: partial.exclusiveArea ?? 84.9,
    dealAmount: partial.dealAmount,
    monthlyRent: partial.monthlyRent ?? 0,
    floor: partial.floor ?? 10,
    buildYear: partial.buildYear ?? 2010,
    jibun: partial.jibun ?? "1-1",
    dealingGbn: partial.dealingGbn ?? "중개거래",
    lawdCd: partial.lawdCd ?? "11680",
  };
}

const LAWD = "11680";
const SINCE = "202503";

/** 지도 예전 쿼리와 같은 순서·값 (조건 없이 since 이후 전부, 금액 > 0) */
async function liveDeals(db: Client, name: string) {
  const rs = await db.execute({
    sql: `SELECT deal_type, deal_amount, monthly_rent, deal_date, exclusive_area, build_year, dealing_gbn, floor, year_month
          FROM transactions INDEXED BY idx_tx_lawd_apt_ym
          WHERE lawd_cd = ? AND apt_name_norm = ? AND year_month >= ? AND deal_amount > 0`,
    args: [LAWD, name, SINCE],
  });
  return rs.rows.map((r) => ({
    dealType: String(r.deal_type),
    yearMonth: String(r.year_month),
    amount: Number(r.deal_amount),
    rent: Number(r.monthly_rent),
    date: String(r.deal_date),
    area: Number(r.exclusive_area),
    buildYear: r.build_year == null ? null : Number(r.build_year),
    floor: r.floor == null ? null : Number(r.floor),
    gbn: r.dealing_gbn == null ? null : String(r.dealing_gbn),
  }));
}

async function snapNames(db: Client) {
  const m = await readMapRecentDeals(db, LAWD, ["a단지", "b단지"], SINCE);
  return [...m.keys()].sort();
}

async function main() {
  const db = getDb()!;
  await ensureSchema(db);
  await db.execute(`CREATE TABLE apt_complex_master (complex_id TEXT PRIMARY KEY, lawd_cd TEXT, apt_name_norm TEXT)`);
  await db.execute(`INSERT INTO apt_complex_master VALUES ('c1', '${LAWD}', 'a단지'), ('c2', '${LAWD}', 'b단지'), ('c3', '${LAWD}', 'old단지')`);

  const items: Transaction[] = [];
  for (let i = 0; i < 30; i++) {
    items.push(
      tx({
        id: `t${i}`,
        dealDate: `2026-08-${String(1 + (i % 28)).padStart(2, "0")}`,
        dealAmount: i === 3 ? 0 : 100000 + i,
        aptName: i % 2 ? "A단지" : "B단지",
        dealingGbn: i % 3 ? "중개거래" : "직거래",
        exclusiveArea: 59.99 + (i % 4) * 25,
      }),
    );
  }
  await replaceMonthTransactions({ lawdCd: LAWD, yearMonth: "202608", dealKind: "trade", items });
  await replaceMonthTransactions({
    lawdCd: LAWD,
    yearMonth: "202607",
    dealKind: "rent",
    items: [
      tx({ id: "r1", dealType: "rent", dealDate: "2026-07-05", dealAmount: 50000, monthlyRent: 100 }),
      tx({ id: "r2", dealType: "rent", dealDate: "2026-07-06", dealAmount: 60000, buildYear: undefined }),
    ],
  });

  // 변경 표시가 없으면: 만들기는 에러, 읽기도 에러(호출하는 쪽이 라이브)
  await assert.rejects(refreshMapComplexRecent(db, { mode: "stale" }), /no such table/);
  await assert.rejects(readMapRecentDeals(db, LAWD, ["a단지"], SINCE), /no such table/);
  await applyTxChangeTracking(db);
  assert.equal((await readMapRecentDeals(db, LAWD, ["a단지"], SINCE)).size, 0);

  // 트리거 설치 전 거래 → 번호 0. 처음 만들기
  const dry = await refreshMapComplexRecent(db, { mode: "stale", dryRun: true });
  assert.equal(dry.targets, 3);
  const r1 = await refreshMapComplexRecent(db, { mode: "stale" });
  assert.equal(r1.lawds, 1);
  assert.equal(r1.written, 3);
  assert.deepEqual(await snapNames(db), ["a단지", "b단지"]);
  const snap = await readMapRecentDeals(db, LAWD, ["a단지", "b단지"], SINCE);
  assert.deepEqual(snap.get("a단지"), await liveDeals(db, "a단지"));
  assert.deepEqual(snap.get("b단지"), await liveDeals(db, "b단지"));

  // 바뀐 게 없으면 다시 볼 시군구 없음
  assert.deepEqual(await mapRecentLawdsToRefresh(db, "stale"), []);
  const r2 = await refreshMapComplexRecent(db, { mode: "all" });
  assert.equal(r2.targets, 0);

  // 거래 내용 변경(sync 밖 UPDATE) → 그 단지만 라이브, 갱신하면 새 내용
  await db.execute(`UPDATE transactions SET deal_amount = 777777 WHERE rowid = (SELECT MIN(rowid) FROM transactions WHERE apt_name_norm = 'a단지' AND deal_type = 'trade')`);
  assert.deepEqual(await snapNames(db), ["b단지"]);
  assert.deepEqual(await mapRecentLawdsToRefresh(db, "stale"), [LAWD]);
  const r3 = await refreshMapComplexRecent(db, { mode: "stale" });
  assert.equal(r3.targets, 1);
  assert.equal(r3.written, 1);
  assert.deepEqual(await snapNames(db), ["a단지", "b단지"]);
  assert.deepEqual((await readMapRecentDeals(db, LAWD, ["a단지"], SINCE)).get("a단지"), await liveDeals(db, "a단지"));

  // 지도에 안 쓰이는 열만 바뀜 → 번호만 고침(행 내용 쓰기 없음)
  await db.execute(`UPDATE transactions SET last_seen_at = 'x' WHERE apt_name_norm = 'b단지'`);
  assert.deepEqual(await snapNames(db), ["a단지"]);
  const r4 = await refreshMapComplexRecent(db, { mode: "stale" });
  assert.equal(r4.markOnly, 1);
  assert.equal(r4.written, 0);
  assert.deepEqual(await snapNames(db), ["a단지", "b단지"]);

  // 계산 도중 거래가 바뀜 → 조건부 쓰기가 막아 낡은 행이 그대로(라이브), 다음 갱신이 고침
  await db.execute(`UPDATE transactions SET deal_amount = 888888 WHERE rowid = (SELECT MIN(rowid) FROM transactions WHERE apt_name_norm = 'a단지' AND deal_type = 'trade')`);
  let injected = false;
  const racing = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== "execute") return Reflect.get(target, prop, receiver);
      return async (stmt: InStatement) => {
        const res = await target.execute(stmt);
        const sql = typeof stmt === "string" ? stmt : stmt.sql;
        if (!injected && /FROM transactions/.test(sql)) {
          injected = true;
          await target.execute(`UPDATE transactions SET deal_amount = 999999 WHERE rowid = (SELECT MIN(rowid) FROM transactions WHERE apt_name_norm = 'a단지' AND deal_type = 'trade')`);
        }
        return res;
      };
    },
  }) as Client;
  const r5 = await refreshMapComplexRecent(racing, { mode: "stale" });
  assert.ok(injected);
  assert.equal(r5.skippedChanged, 1);
  assert.deepEqual(await snapNames(db), ["b단지"]);
  const r6 = await refreshMapComplexRecent(db, { mode: "stale" });
  assert.equal(r6.targets, 1);
  assert.deepEqual(await snapNames(db), ["a단지", "b단지"]);
  assert.equal((await readMapRecentDeals(db, LAWD, ["a단지"], SINCE)).get("a단지")!.some((d) => d.amount === 999999), true);

  // 옛 형식 행(번호 없음)·창보다 이른 since 는 쓰지 않는다
  await db.execute(`UPDATE ${MAP_RECENT_TABLE} SET tx_mark = NULL WHERE apt_name_norm = 'a단지'`);
  assert.deepEqual(await snapNames(db), ["b단지"]);
  assert.equal((await readMapRecentDeals(db, LAWD, ["b단지"], "200001")).size, 0);

  // 단지 표에서 빠진 이름은 지운다
  await db.execute(`DELETE FROM apt_complex_master WHERE complex_id = 'c3'`);
  const r7 = await refreshMapComplexRecent(db, { mode: "all" });
  assert.equal(r7.deleted, 1);
  assert.equal(r7.markOnly, 1); // a단지 번호 복구

  console.log("test-map-complex-recent: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

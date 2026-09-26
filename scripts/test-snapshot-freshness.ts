/**
 * transactions 변경 표시 트리거 + snapshot-freshness 헬퍼 (로컬 file DB).
 * production Turso에 연결하지 않는다.
 *
 *   npx tsx scripts/test-snapshot-freshness.ts
 */
import { resolve } from "node:path";
import { unlinkSync, existsSync } from "node:fs";
import assert from "node:assert/strict";

const dbPath = resolve("data/test-snapshot-freshness.db");
for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
  if (existsSync(p)) unlinkSync(p);
}

process.env.TURSO_DATABASE_URL = `file:${dbPath}`;
delete process.env.TURSO_AUTH_TOKEN;
delete process.env.MOLIT_API_KEY;

import { ensureSchema, getDb } from "../src/lib/db/client";
import { replaceMonthTransactions } from "../src/lib/db/repository";
import { applyTxChangeTracking } from "../src/lib/db/tx-change-schema";
import {
  changeMarkSubquery,
  computeWithFreshnessGuard,
  isMarkCurrent,
  isSnapshotFresh,
  listChangedComplexesSince,
  markUnchangedCondition,
  readChangeMark,
  readGlobalChangeSeq,
  type ChangeScope,
} from "../src/lib/db/snapshot-freshness";
import type { Transaction } from "../src/types/transaction";

function tx(
  partial: Partial<Transaction> & Pick<Transaction, "id" | "dealAmount" | "dealDate">,
): Transaction {
  return {
    id: partial.id,
    dealType: partial.dealType ?? "trade",
    dealDate: partial.dealDate,
    aptName: partial.aptName ?? "테스트아파트",
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

async function main() {
  const db = getDb()!;
  await ensureSchema(db);

  // 표가 없을 때: 읽는 쪽은 false(라이브), 쓰는 쪽은 에러
  const A: ChangeScope = { complexes: [{ lawdCd: "11680", aptNameNorm: "a단지" }] };
  assert.equal(await isSnapshotFresh(db, A, 0), false);
  await assert.rejects(readChangeMark(db, A));

  await applyTxChangeTracking(db);
  await applyTxChangeTracking(db); // IF NOT EXISTS — 두 번 돌려도 무해
  assert.equal(await readGlobalChangeSeq(db), 0);
  assert.equal(await readChangeMark(db, A), 0);
  assert.equal(await isSnapshotFresh(db, A, 0), true);

  const B: ChangeScope = { complexes: [{ lawdCd: "11680", aptNameNorm: "b단지" }] };
  const L: ChangeScope = { lawds: ["11680"] };
  const L2: ChangeScope = { lawds: ["11710"] };
  const G: ChangeScope = { global: true };

  // 1) sync 경로 INSERT (replaceMonthTransactions: 81행 → 묶음 2개)
  const rows: Transaction[] = [];
  for (let i = 0; i < 81; i++) {
    rows.push(
      tx({
        id: `x${i}`,
        dealDate: `2026-09-${String(1 + (i % 28)).padStart(2, "0")}`,
        dealAmount: 100000 + i,
        floor: i,
        aptName: i % 2 ? "A 단지" : "B단지",
      }),
    );
  }
  const r1 = await replaceMonthTransactions({
    lawdCd: "11680",
    yearMonth: "202609",
    dealKind: "trade",
    items: rows,
  });
  assert.equal(r1.inserted, 81);
  assert.equal(await readGlobalChangeSeq(db), 81);
  const markA1 = await readChangeMark(db, A);
  const markB1 = await readChangeMark(db, B);
  assert.ok(markA1 > 0 && markB1 > 0);
  assert.equal(await readChangeMark(db, L), 81);
  assert.equal(await readChangeMark(db, L2), 0);

  // sync_months 는 마지막 문장 — 모든 거래 뒤에 기록
  const sm = await db.execute(
    `SELECT row_count FROM sync_months WHERE lawd_cd='11680' AND year_month='202609' AND deal_kind='trade'`,
  );
  assert.equal(Number(sm.rows[0].row_count), 81);

  // 2) 같은 내용 다시 → 쓰기 없음 → 번호 그대로
  const r2 = await replaceMonthTransactions({
    lawdCd: "11680",
    yearMonth: "202609",
    dealKind: "trade",
    items: rows,
  });
  assert.equal(r2.wrote, false);
  assert.equal(await readChangeMark(db, A), markA1);
  assert.equal(await isSnapshotFresh(db, A, markA1), true);

  // 3) sync 밖 직접 UPDATE (load-apt-dong 식) → 그 단지만 바뀜
  const idOfA = (
    await db.execute(`SELECT id FROM transactions WHERE apt_name_norm = 'a단지' LIMIT 1`)
  ).rows[0].id as string;
  await db.execute({ sql: `UPDATE transactions SET last_seen_at = 'x' WHERE id = ?`, args: [idOfA] });
  const markA2 = await readChangeMark(db, A);
  assert.ok(markA2 > markA1);
  assert.equal(await isSnapshotFresh(db, A, markA1), false);
  assert.equal(await isSnapshotFresh(db, B, markB1), true);
  assert.equal(await isSnapshotFresh(db, L, 81), false);

  // 4) 단지 키가 바뀐 UPDATE → 옛 단지·새 단지 둘 다
  const markB2 = await readChangeMark(db, B);
  await db.execute({
    sql: `UPDATE transactions SET apt_name_norm = 'c단지' WHERE id = ?`,
    args: [idOfA],
  });
  assert.ok((await readChangeMark(db, A)) > markA2);
  assert.ok(
    (await readChangeMark(db, { complexes: [{ lawdCd: "11680", aptNameNorm: "c단지" }] })) > 0,
  );
  assert.equal(await readChangeMark(db, B), markB2);

  // 5) DELETE
  const idOfB = (
    await db.execute(`SELECT id FROM transactions WHERE apt_name_norm = 'b단지' LIMIT 1`)
  ).rows[0].id as string;
  await db.execute({ sql: `DELETE FROM transactions WHERE id = ?`, args: [idOfB] });
  assert.ok((await readChangeMark(db, B)) > markB2);

  // 6) 다른 시군구 쓰기는 이 시군구 번호를 바꾸지 않음, 전역은 바뀜
  const markL = await readChangeMark(db, L);
  const g0 = await readGlobalChangeSeq(db);
  await replaceMonthTransactions({
    lawdCd: "11710",
    yearMonth: "202609",
    dealKind: "trade",
    items: [tx({ id: "y1", dealDate: "2026-09-03", dealAmount: 1, lawdCd: "11710", gu: "송파구" })],
  });
  assert.equal(await readChangeMark(db, L), markL);
  assert.ok((await readChangeMark(db, L2)) > 0);
  assert.equal(await readChangeMark(db, G), g0 + 1);
  assert.ok((await readChangeMark(db, { lawds: ["11680", "11710"] })) > markL);

  // 7) 쓰는 쪽 가드: 계산 도중 바뀌면 ok=false
  const guarded = await computeWithFreshnessGuard(db, B, async () => {
    await db.execute(`UPDATE transactions SET last_seen_at = 'y' WHERE apt_name_norm = 'b단지'`);
    return 1;
  });
  assert.equal(guarded.ok, false);
  const calm = await computeWithFreshnessGuard(db, B, async () => 2);
  assert.ok(calm.ok && calm.value === 2);

  // 8) 계산 중 에러는 그대로 던짐 (스냅샷 저장 안 함)
  await assert.rejects(
    computeWithFreshnessGuard(db, B, async () => {
      throw new Error("degraded read");
    }),
    /degraded read/,
  );

  // 9) 조건부 쓰기: 번호가 그대로일 때만 저장
  await db.execute(`CREATE TABLE snap (k TEXT PRIMARY KEY, payload TEXT, mark INTEGER)`);
  const mB = await readChangeMark(db, B);
  const put = async (payload: string, mark: number) => {
    const cond = markUnchangedCondition(B, mark);
    const rs = await db.execute({
      sql: `INSERT INTO snap (k, payload, mark) SELECT ?, ?, ? WHERE ${cond.sql}
            ON CONFLICT(k) DO UPDATE SET payload = excluded.payload, mark = excluded.mark`,
      args: ["b", payload, mark, ...cond.args],
    });
    return rs.rowsAffected;
  };
  assert.equal(await put("v1", mB), 1);
  await db.execute(`UPDATE transactions SET last_seen_at = 'z' WHERE apt_name_norm = 'b단지'`);
  assert.equal(await put("v2", mB), 0); // 계산 뒤에 바뀜 → 저장 안 됨

  // 10) 읽는 쪽 1왕복: 스냅샷 SELECT 에 현재 번호를 붙여 비교
  const sub = changeMarkSubquery(B);
  const read = await db.execute({
    sql: `SELECT payload, mark, ${sub.sql} AS cur FROM snap WHERE k = ?`,
    args: [...sub.args, "b"],
  });
  assert.equal(read.rows[0].payload, "v1");
  assert.equal(isMarkCurrent(read.rows[0].mark, read.rows[0].cur), false);
  assert.equal(isMarkCurrent(null, 0), false);
  assert.equal(isMarkCurrent("abc", 0), false);

  // 11) post-sync: 번호 이후 바뀐 단지
  const changed = await listChangedComplexesSince(db, g0);
  assert.deepEqual(
    changed.map((c) => `${c.lawdCd}|${c.aptNameNorm}`).sort(),
    ["11680|b단지", "11710|테스트아파트"],
  );
  assert.equal((await listChangedComplexesSince(db, g0, { lawds: ["11710"] })).length, 1);

  console.log("test-snapshot-freshness: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

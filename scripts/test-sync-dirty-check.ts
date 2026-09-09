/**
 * replaceMonthTransactions dirty-check 로컬 검증 (file DB).
 * 운영 Turso에 연결하지 않는다.
 *
 *   npx tsx scripts/test-sync-dirty-check.ts
 */
import { resolve } from "node:path";
import { unlinkSync, existsSync } from "node:fs";
import assert from "node:assert/strict";

const dbPath = resolve("data/test-sync-dirty-check.db");
if (existsSync(dbPath)) unlinkSync(dbPath);
if (existsSync(`${dbPath}-wal`)) unlinkSync(`${dbPath}-wal`);
if (existsSync(`${dbPath}-shm`)) unlinkSync(`${dbPath}-shm`);

process.env.TURSO_DATABASE_URL = `file:${dbPath}`;
delete process.env.TURSO_AUTH_TOKEN;

import { ensureSchema, getDb } from "../src/lib/db/client";
import { replaceMonthTransactions } from "../src/lib/db/repository";
import { isSameTransactionContent, snapshotFromTx } from "../src/lib/db/sync-diff";
import type { Transaction } from "../src/types/transaction";

function tx(partial: Partial<Transaction> & Pick<Transaction, "id" | "dealAmount" | "dealDate">): Transaction {
  return {
    id: partial.id,
    dealType: partial.dealType ?? "trade",
    dealDate: partial.dealDate,
    aptName: partial.aptName ?? "테스트아파트",
    gu: partial.gu ?? "만안구",
    dong: partial.dong ?? "안양동",
    exclusiveArea: partial.exclusiveArea ?? 84.9,
    dealAmount: partial.dealAmount,
    monthlyRent: partial.monthlyRent ?? 0,
    floor: partial.floor ?? 10,
    buildYear: partial.buildYear ?? 2010,
    jibun: partial.jibun ?? "1-1",
    dealingGbn: partial.dealingGbn ?? "중개거래",
    lawdCd: partial.lawdCd ?? "41171",
  };
}

async function countTx(): Promise<number> {
  const db = getDb();
  assert.ok(db);
  const r = await db.execute(`SELECT COUNT(*) AS n FROM transactions`);
  return Number(r.rows[0]?.n ?? 0);
}

async function loadRow(id: string) {
  const db = getDb();
  assert.ok(db);
  const r = await db.execute({
    sql: `SELECT * FROM transactions WHERE id = ?`,
    args: [id],
  });
  return r.rows[0] ?? null;
}

async function main() {
  const db = getDb();
  assert.ok(db, "local db");
  await ensureSchema(db);

  // pure helper
  const a = snapshotFromTx(tx({ id: "a", dealAmount: 10000, dealDate: "2026-01-01" }));
  const b = snapshotFromTx(tx({ id: "b", dealAmount: 10000, dealDate: "2026-01-01" }));
  assert.equal(isSameTransactionContent(a, b), true);
  assert.equal(
    isSameTransactionContent(a, snapshotFromTx(tx({ id: "c", dealAmount: 10001, dealDate: "2026-01-01" }))),
    false,
  );

  const lawdCd = "41171";
  const yearMonth = "202601";
  const base = [
    tx({ id: "t1", dealAmount: 50000, dealDate: "2026-01-05", floor: 3 }),
    tx({ id: "t2", dealAmount: 60000, dealDate: "2026-01-06", floor: 7, dealingGbn: "직거래" }),
  ];

  // 1) initial insert
  const r1 = await replaceMonthTransactions({
    lawdCd,
    yearMonth,
    dealKind: "trade",
    items: base,
  });
  assert.equal(r1.inserted, 2);
  assert.equal(r1.updated, 0);
  assert.equal(r1.unchanged, 0);
  assert.equal(r1.deleted, 0);
  assert.equal(r1.wrote, true);
  assert.equal(await countTx(), 2);
  const row1 = await loadRow(
    (await db.execute(`SELECT id FROM transactions LIMIT 1`)).rows[0]!.id as string,
  );
  assert.ok(row1?.first_seen_at);
  const firstSeenKeep = String(row1!.first_seen_at);
  const lastSeen1 = String(row1!.last_seen_at);

  // 2) identical re-sync → UPDATE 0
  await new Promise((r) => setTimeout(r, 5));
  const r2 = await replaceMonthTransactions({
    lawdCd,
    yearMonth,
    dealKind: "trade",
    items: base.map((t) => ({ ...t })),
  });
  assert.equal(r2.inserted, 0);
  assert.equal(r2.updated, 0);
  assert.equal(r2.unchanged, 2);
  assert.equal(r2.deleted, 0);
  assert.equal(r2.wrote, false);
  assert.equal(await countTx(), 2);
  const afterSame = await loadRow(String(row1!.id));
  assert.equal(String(afterSame!.first_seen_at), firstSeenKeep);
  assert.equal(String(afterSame!.last_seen_at), lastSeen1); // unchanged last_seen

  // 3) genuine field change (dealingGbn) → UPDATE 1, first_seen 유지
  await new Promise((r) => setTimeout(r, 5));
  const beforeUpdate = (
    await db.execute({
      sql: `SELECT id, first_seen_at, last_seen_at FROM transactions WHERE deal_amount = ?`,
      args: [60000],
    })
  ).rows[0];
  assert.ok(beforeUpdate);
  const keepFirst = String(beforeUpdate!.first_seen_at);
  const prevLast = String(beforeUpdate!.last_seen_at);

  const changed = base.map((t, i) =>
    i === 1 ? { ...t, dealingGbn: "중개거래" } : { ...t },
  );
  const r3 = await replaceMonthTransactions({
    lawdCd,
    yearMonth,
    dealKind: "trade",
    items: changed,
  });
  assert.equal(r3.inserted, 0);
  assert.equal(r3.updated, 1);
  assert.equal(r3.unchanged, 1);
  assert.equal(r3.deleted, 0);
  assert.equal(r3.wrote, true);

  const updatedRow = (
    await db.execute({
      sql: `SELECT * FROM transactions WHERE id = ?`,
      args: [String(beforeUpdate!.id)],
    })
  ).rows[0];
  assert.ok(updatedRow);
  assert.equal(String(updatedRow!.first_seen_at), keepFirst);
  assert.equal(String(updatedRow!.dealing_gbn), "중개거래");
  assert.notEqual(String(updatedRow!.last_seen_at), prevLast);

  // 4) new deal → INSERT
  const withNew = [
    ...changed,
    tx({ id: "t3", dealAmount: 70000, dealDate: "2026-01-10", floor: 12 }),
  ];
  const r4 = await replaceMonthTransactions({
    lawdCd,
    yearMonth,
    dealKind: "trade",
    items: withNew,
  });
  assert.equal(r4.inserted, 1);
  assert.equal(r4.updated, 0);
  assert.equal(r4.unchanged, 2);
  assert.equal(r4.deleted, 0);
  assert.equal(r4.wrote, true);
  assert.equal(await countTx(), 3);
  const newRow = (
    await db.execute({
      sql: `SELECT * FROM transactions WHERE deal_amount = ?`,
      args: [70000],
    })
  ).rows[0];
  assert.ok(newRow?.first_seen_at);
  assert.ok(newRow?.last_seen_at);

  // 5) orphan delete — drop t1 equivalent
  const withoutFirst = withNew.filter((t) => t.dealAmount !== 50000);
  const r5 = await replaceMonthTransactions({
    lawdCd,
    yearMonth,
    dealKind: "trade",
    items: withoutFirst,
  });
  assert.equal(r5.deleted, 1);
  assert.equal(r5.inserted, 0);
  assert.equal(r5.updated, 0);
  assert.equal(r5.unchanged, 2);
  assert.equal(r5.wrote, true);
  assert.equal(await countTx(), 2);

  // 6) same-date multi deals keep distinct natural keys
  const multi = [
    tx({ id: "m1", dealAmount: 11111, dealDate: "2026-01-15", floor: 1 }),
    tx({ id: "m2", dealAmount: 22222, dealDate: "2026-01-15", floor: 2 }),
  ];
  await replaceMonthTransactions({
    lawdCd,
    yearMonth: "202602",
    dealKind: "trade",
    items: multi,
  });
  const r6 = await replaceMonthTransactions({
    lawdCd,
    yearMonth: "202602",
    dealKind: "trade",
    items: multi,
  });
  assert.equal(r6.unchanged, 2);
  assert.equal(r6.wrote, false);

  // 7) re-run identical → still minimize writes
  const r7 = await replaceMonthTransactions({
    lawdCd,
    yearMonth,
    dealKind: "trade",
    items: withoutFirst,
  });
  assert.equal(r7.wrote, false);
  assert.equal(r7.unchanged, 2);

  const beforeDry = await countTx();
  const dry = await replaceMonthTransactions({
    lawdCd,
    yearMonth,
    dealKind: "trade",
    items: [
      ...withoutFirst,
      tx({ id: "dry-new", dealAmount: 12345, dealDate: "2026-01-20", floor: 2, jibun: "9-9" }),
    ],
    dryRun: true,
  });
  assert.equal(dry.inserted, 1);
  assert.equal(dry.wrote, false);
  assert.equal(await countTx(), beforeDry, "dry-run must not write");

  console.log(
    JSON.stringify(
      {
        ok: true,
        cases: [
          "identical-resync-noop",
          "genuine-update",
          "insert",
          "orphan-delete",
          "same-date-multi",
          "first_seen-preserved",
          "dry-run-write-0",
        ],
      },
      null,
      2,
    ),
  );

  // cleanup
  try {
    unlinkSync(dbPath);
  } catch {
    /* ignore */
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

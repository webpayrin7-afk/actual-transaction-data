/**
 * first_seen / request-path persist 가드 (로컬 file DB).
 * production Turso에 연결하지 않는다.
 *
 *   npx tsx scripts/test-first-seen-guard.ts
 */
import { resolve } from "node:path";
import { unlinkSync, existsSync, readFileSync } from "node:fs";
import assert from "node:assert/strict";

const dbPath = resolve("data/test-first-seen-guard.db");
for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
  if (existsSync(p)) unlinkSync(p);
}

process.env.TURSO_DATABASE_URL = `file:${dbPath}`;
delete process.env.TURSO_AUTH_TOKEN;
delete process.env.MOLIT_API_KEY;

import { ensureSchema, getDb } from "../src/lib/db/client";
import { persistMonthInBackground } from "../src/lib/db/persist";
import { replaceMonthTransactions } from "../src/lib/db/repository";
import { ALL_REGIONS } from "../src/lib/constants/regions-registry";
import { recentYearMonths } from "../src/lib/utils/format";
import type { Transaction } from "../src/types/transaction";

function tx(
  partial: Partial<Transaction> & Pick<Transaction, "id" | "dealAmount" | "dealDate">,
): Transaction {
  return {
    id: partial.id,
    dealType: partial.dealType ?? "trade",
    dealDate: partial.dealDate,
    aptName: partial.aptName ?? "테스트아파트",
    gu: partial.gu ?? "해운대구",
    dong: partial.dong ?? "좌동",
    exclusiveArea: partial.exclusiveArea ?? 84.9,
    dealAmount: partial.dealAmount,
    monthlyRent: partial.monthlyRent ?? 0,
    floor: partial.floor ?? 10,
    buildYear: partial.buildYear ?? 2010,
    jibun: partial.jibun ?? "1-1",
    dealingGbn: partial.dealingGbn ?? "중개거래",
    lawdCd: partial.lawdCd ?? "26350",
  };
}

function hintedLawdCodes(queryNorm: string): string[] {
  const codes = new Set<string>();
  const normalizeName = (name: string) => name.replace(/\s+/g, "").toLowerCase();
  const regionNameKey = (name: string) =>
    normalizeName(name.replace(/(특별시|광역시|특별자치시|시|군|구)$/g, ""));
  for (const region of ALL_REGIONS) {
    const keys = [
      regionNameKey(region.name),
      ...region.districts.map((d) => regionNameKey(d.name)),
    ].filter((k) => k.length >= 2);
    if (keys.some((k) => queryNorm.includes(k) || k.includes(queryNorm))) {
      for (const code of region.lawdCodes) codes.add(code);
    }
  }
  return [...codes];
}

async function countWhere(sql: string): Promise<number> {
  const db = getDb();
  assert.ok(db);
  const r = await db.execute(sql);
  return Number(r.rows[0]?.c ?? r.rows[0]?.n ?? 0);
}

async function firstSeen(idHint: string): Promise<string | null> {
  const db = getDb();
  assert.ok(db);
  const r = await db.execute({
    sql: `SELECT first_seen_at FROM transactions WHERE apt_name = ?`,
    args: [idHint],
  });
  const v = r.rows[0]?.first_seen_at;
  if (v == null || v === "") return null;
  return String(v);
}

async function main() {
  const db = getDb();
  assert.ok(db, "local file db");
  await ensureSchema(db);

  // --- invariant: request-path client no longer calls persist ---
  const clientSrc = readFileSync(resolve("src/lib/molit/client.ts"), "utf8");
  assert.equal(
    clientSrc.includes("persistMonthInBackground"),
    false,
    "fetchOneTrade/Rent must not call persistMonthInBackground",
  );

  // --- Case: 해운대 hint → 26350, recent 2 months are current+prev ---
  const hinted = hintedLawdCodes("해운대");
  assert.ok(hinted.includes("26350"), "해운대 search hints LAWD 26350");
  const recent2 = recentYearMonths(4).slice(0, 2);
  assert.equal(recent2.length, 2);
  // On 2026-09-08/09 this is 202609 + 202608 — the production pair.
  assert.equal(recent2[0].length, 6);

  // --- Case 1: request-path persist is a no-op (no warehouse write) ---
  persistMonthInBackground({
    lawdCd: "26350",
    yearMonth: "202608",
    dealKind: "trade",
    items: [
      tx({ id: "ghost", aptName: "고스트", dealAmount: 1, dealDate: "2026-08-01" }),
    ],
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(await countWhere(`SELECT COUNT(*) AS c FROM transactions`), 0);

  // --- Reproduce production pattern (legacy persist = default discovery true) ---
  const ymPrev = recent2[1] ?? "202608";
  const ymCur = recent2[0] ?? "202609";
  const batchA = [
    tx({
      id: "a1",
      aptName: "레거시A",
      dealAmount: 10000,
      dealDate: `${ymCur.slice(0, 4)}-${ymCur.slice(4, 6)}-01`,
    }),
  ];
  const batchB = [
    tx({
      id: "b1",
      aptName: "레거시B",
      dealAmount: 20000,
      dealDate: `${ymPrev.slice(0, 4)}-${ymPrev.slice(4, 6)}-01`,
    }),
    tx({
      id: "b2",
      aptName: "레거시B2",
      dealAmount: 21000,
      dealDate: `${ymPrev.slice(0, 4)}-${ymPrev.slice(4, 6)}-02`,
    }),
  ];
  const [rCur, rPrev] = await Promise.all([
    replaceMonthTransactions({
      lawdCd: "26350",
      yearMonth: ymCur,
      dealKind: "trade",
      items: batchA,
    }),
    replaceMonthTransactions({
      lawdCd: "26350",
      yearMonth: ymPrev,
      dealKind: "trade",
      items: batchB,
    }),
  ]);
  assert.equal(rCur.inserted, 1);
  assert.equal(rPrev.inserted, 2);
  const legacyFirst = await db.execute(
    `SELECT COUNT(*) AS c FROM transactions WHERE first_seen_at IS NOT NULL AND first_seen_at != ''`,
  );
  assert.equal(Number(legacyFirst.rows[0]?.c), 3, "legacy default discovery SET first_seen");

  // cleanup reproduction rows
  await db.execute(`DELETE FROM transactions`);
  await db.execute(`DELETE FROM sync_months`);

  // --- Case 2: explicit discovery ingestion → first_seen=now ---
  const d1 = await replaceMonthTransactions({
    lawdCd: "26350",
    yearMonth: "202608",
    dealKind: "trade",
    items: [tx({ id: "d1", aptName: "발견", dealAmount: 30000, dealDate: "2026-08-10" })],
    setFirstSeenOnInsert: true,
  });
  assert.equal(d1.inserted, 1);
  const seenDiscover = await firstSeen("발견");
  assert.ok(seenDiscover, "discovery=1 sets first_seen");

  // --- Case 3: historical discovery=0 → first_seen audit set, discovery NULL ---
  const d0 = await replaceMonthTransactions({
    lawdCd: "41171",
    yearMonth: "202608",
    dealKind: "trade",
    items: [
      tx({
        id: "h1",
        aptName: "백필",
        gu: "만안구",
        lawdCd: "41171",
        dealAmount: 40000,
        dealDate: "2026-08-11",
      }),
    ],
    setFirstSeenOnInsert: false,
  });
  assert.equal(d0.inserted, 1);
  assert.ok(await firstSeen("백필"), "discovery=0 still records first_seen audit");
  const backfillDiscovery = (
    await db.execute(`SELECT discovery_at FROM transactions WHERE apt_name='백필'`)
  ).rows[0];
  assert.equal(
    backfillDiscovery?.discovery_at == null || backfillDiscovery?.discovery_at === "",
    true,
  );

  // --- Case 4: existing row no-op → first_seen + last_seen + write 없음 ---
  const before = (
    await db.execute(`SELECT first_seen_at, last_seen_at FROM transactions WHERE apt_name='발견'`)
  ).rows[0];
  assert.ok(before);
  const noop = await replaceMonthTransactions({
    lawdCd: "26350",
    yearMonth: "202608",
    dealKind: "trade",
    items: [tx({ id: "d1", aptName: "발견", dealAmount: 30000, dealDate: "2026-08-10" })],
    setFirstSeenOnInsert: true,
  });
  assert.equal(noop.inserted, 0);
  assert.equal(noop.updated, 0);
  assert.equal(noop.deleted, 0);
  assert.equal(noop.unchanged, 1);
  assert.equal(noop.wrote, false);
  const afterNoop = (
    await db.execute(`SELECT first_seen_at, last_seen_at FROM transactions WHERE apt_name='발견'`)
  ).rows[0];
  assert.equal(String(afterNoop!.first_seen_at), String(before!.first_seen_at));
  assert.equal(String(afterNoop!.last_seen_at), String(before!.last_seen_at));

  // --- Case 5: genuine update → first_seen 보존, last_seen 변경 ---
  await new Promise((r) => setTimeout(r, 5));
  const upd = await replaceMonthTransactions({
    lawdCd: "26350",
    yearMonth: "202608",
    dealKind: "trade",
    items: [
      tx({
        id: "d1",
        aptName: "발견",
        dealAmount: 30000,
        dealDate: "2026-08-10",
        dealingGbn: "직거래",
      }),
    ],
    setFirstSeenOnInsert: true,
  });
  assert.equal(upd.updated, 1);
  assert.equal(upd.wrote, true);
  const afterUpd = (
    await db.execute(
      `SELECT first_seen_at, last_seen_at, dealing_gbn FROM transactions WHERE apt_name='발견'`,
    )
  ).rows[0];
  assert.equal(String(afterUpd!.first_seen_at), String(before!.first_seen_at));
  assert.notEqual(String(afterUpd!.last_seen_at), String(before!.last_seen_at));
  assert.equal(String(afterUpd!.dealing_gbn), "직거래");

  console.log(
    JSON.stringify(
      {
        ok: true,
        hinted26350: hinted.includes("26350"),
        recent2,
        cases: [
          "request-path-persist-noop",
          "legacy-two-month-discovery-default",
          "discovery=1",
          "discovery=0",
          "existing-noop",
          "genuine-update-preserves-first-seen",
          "client-has-no-persist-call",
        ],
      },
      null,
      2,
    ),
  );

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

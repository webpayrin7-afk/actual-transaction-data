/**
 * Cancellation / identity resolver tests (local, no production DB / no MOLIT).
 *
 *   npx tsx scripts/test-trade-resolve.ts
 */
import { resolve } from "node:path";
import { existsSync, unlinkSync } from "node:fs";
import assert from "node:assert/strict";

const dbPath = resolve("data/test-trade-resolve.db");
for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
  if (existsSync(p)) unlinkSync(p);
}
process.env.TURSO_DATABASE_URL = `file:${dbPath}`;
delete process.env.TURSO_AUTH_TOKEN;
delete process.env.MOLIT_API_KEY;

import { ensureSchema, getDb } from "../src/lib/db/client";
import { replaceMonthTransactions } from "../src/lib/db/repository";
import { naturalKeyFromTx } from "../src/lib/market/identity";
import {
  classifyIdentityGroup,
  isCancelledTrade,
  isUnsafeMonthShrink,
  resolveActiveTrades,
} from "../src/lib/molit/trade-resolve";
import type { Transaction } from "../src/types/transaction";

const LAWD = "11170";

function tx(
  partial: Partial<Transaction> &
    Pick<Transaction, "id" | "dealAmount" | "dealDate">,
): Transaction {
  return {
    id: partial.id,
    dealType: "trade",
    dealDate: partial.dealDate,
    aptName: partial.aptName ?? "미주B",
    gu: "용산구",
    dong: partial.dong ?? "이촌동",
    exclusiveArea: partial.exclusiveArea ?? 149.09,
    dealAmount: partial.dealAmount,
    monthlyRent: 0,
    floor: partial.floor ?? 4,
    buildYear: 1976,
    jibun: partial.jibun ?? "302-48",
    dealingGbn: "중개거래",
    lawdCd: LAWD,
    ingestMeta: partial.ingestMeta ?? {
      cdealType: "",
      cdealDay: "",
      rgstDate: "",
      aptDong: "",
    },
  };
}

const mijubLive = tx({
  id: "mijub-live",
  dealAmount: 178000,
  dealDate: "2026-06-30",
  ingestMeta: {
    cdealType: "",
    cdealDay: "",
    rgstDate: "26.09.01",
    aptDong: "",
  },
});
const mijubCancel = tx({
  id: "mijub-cancel",
  dealAmount: 178000,
  dealDate: "2026-06-30",
  ingestMeta: {
    cdealType: "O",
    cdealDay: "26.07.20",
    rgstDate: "",
    aptDong: "",
  },
});

async function main() {
  assert.equal(isCancelledTrade(mijubLive), false);
  assert.equal(isCancelledTrade(mijubCancel), true);
  assert.equal(classifyIdentityGroup([mijubLive, mijubCancel]), "cancellation-pair");
  assert.equal(
    naturalKeyFromTx(mijubLive, LAWD),
    naturalKeyFromTx(mijubCancel, LAWD),
  );

  const normalOnly = resolveActiveTrades([mijubLive], LAWD);
  assert.equal(normalOnly.active.length, 1);
  assert.equal(normalOnly.cancelledExcluded, 0);

  const cancelOnly = resolveActiveTrades([mijubCancel], LAWD);
  assert.equal(cancelOnly.active.length, 0);
  assert.equal(cancelOnly.cancelledOnlyDropped, 1);

  const forward = resolveActiveTrades([mijubLive, mijubCancel], LAWD);
  const reverse = resolveActiveTrades([mijubCancel, mijubLive], LAWD);
  assert.equal(forward.active.length, 1);
  assert.equal(reverse.active.length, 1);
  assert.equal(forward.active[0].ingestMeta?.rgstDate, "26.09.01");
  assert.equal(reverse.active[0].ingestMeta?.rgstDate, "26.09.01");
  assert.equal(forward.active[0].ingestMeta?.cdealType, "");
  assert.equal(reverse.active[0].id, forward.active[0].id);

  const withDup = resolveActiveTrades(
    [mijubCancel, mijubLive, { ...mijubLive, id: "mijub-live-2" }],
    LAWD,
  );
  assert.equal(withDup.active.length, 1);
  assert.equal(withDup.active[0].ingestMeta?.rgstDate, "26.09.01");

  assert.equal(isUnsafeMonthShrink({ previousRowCount: 64, nextRowCount: 63 }), false);
  assert.equal(isUnsafeMonthShrink({ previousRowCount: 64, nextRowCount: 5 }), true);
  assert.equal(isUnsafeMonthShrink({ previousRowCount: 64, nextRowCount: 0 }), true);
  assert.equal(isUnsafeMonthShrink({ previousRowCount: 3, nextRowCount: 0 }), false);

  const db = getDb();
  assert.ok(db);
  await ensureSchema(db);

  const resolved = resolveActiveTrades([mijubCancel, mijubLive], LAWD).active;
  const ins = await replaceMonthTransactions({
    lawdCd: LAWD,
    yearMonth: "202606",
    dealKind: "trade",
    items: resolved,
    setFirstSeenOnInsert: true,
  });
  assert.equal(ins.inserted, 1);
  const row = (
    await db.execute(`SELECT COUNT(*) AS n, MIN(first_seen_at) AS fs FROM transactions`)
  ).rows[0];
  assert.equal(Number(row?.n), 1);
  assert.ok(row?.fs);

  const seed = Array.from({ length: 20 }, (_, i) =>
    tx({
      id: `seed-${i}`,
      aptName: `시드${i}`,
      dealAmount: 10000 + i,
      dealDate: "2026-06-01",
      floor: i + 1,
      jibun: `${i}`,
    }),
  );
  await replaceMonthTransactions({
    lawdCd: LAWD,
    yearMonth: "202607",
    dealKind: "trade",
    items: seed,
    setFirstSeenOnInsert: true,
  });
  await assert.rejects(
    () =>
      replaceMonthTransactions({
        lawdCd: LAWD,
        yearMonth: "202607",
        dealKind: "trade",
        items: seed.slice(0, 5),
        setFirstSeenOnInsert: true,
      }),
    /refusing destructive month replace/,
  );
  const still = await db.execute(
    `SELECT COUNT(*) AS n FROM transactions WHERE year_month='202607'`,
  );
  assert.equal(Number(still.rows[0]?.n), 20);

  console.log(
    JSON.stringify(
      {
        ok: true,
        cases: [
          "normal-only",
          "cancel-only-dropped",
          "normal+cancel",
          "reverse-order",
          "duplicate-actives",
          "mijub-fixture",
          "shrink-guard",
          "first_seen-on-insert",
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

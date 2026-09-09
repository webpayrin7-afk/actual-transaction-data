/**
 * Dual-schema compatibility for PR #40.
 *
 * SCHEMA A: ENABLE_DISCOVERY_AT_COLUMN=0 → no discovery_at column
 * SCHEMA B: ENABLE_DISCOVERY_AT_COLUMN=1 → column present
 *
 *   npx tsx scripts/test-discovery-compat.ts
 */
import { spawnSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";

const MODE = process.env.DISCOVERY_COMPAT_MODE;

if (!MODE) {
  for (const mode of ["absent", "present"] as const) {
    const result = spawnSync("npx", ["tsx", resolve("scripts/test-discovery-compat.ts")], {
      env: { ...process.env, DISCOVERY_COMPAT_MODE: mode },
      stdio: "inherit",
    });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
  console.log(JSON.stringify({ ok: true, schemas: ["absent", "present"] }));
  process.exit(0);
}

const present = MODE === "present";
const dbPath = resolve(
  present ? "data/test-discovery-compat-present.db" : "data/test-discovery-compat-absent.db",
);
for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
  if (existsSync(p)) unlinkSync(p);
}

process.env.TURSO_DATABASE_URL = `file:${dbPath}`;
delete process.env.TURSO_AUTH_TOKEN;
delete process.env.MOLIT_API_KEY;
process.env.ENABLE_DISCOVERY_AT_COLUMN = present ? "1" : "0";

async function runWorker() {
  const { ensureSchema, getDb } = await import("../src/lib/db/client");
  const { hasDiscoveryAtColumn } = await import("../src/lib/db/discovery-axis");
  const { queryAptTransactions, replaceMonthTransactions } = await import(
    "../src/lib/db/repository"
  );
  const { computeMarketHome } = await import("../src/lib/market/home");
  const { seoulToday } = await import("../src/lib/market/time");
  const { clearRegionDailyCaches, getRegionDaily } = await import(
    "../src/lib/molit/service"
  );
  const { YONGSAN_LAWD_CD } = await import("../src/lib/molit/sync-policy");
  type Transaction = import("../src/types/transaction").Transaction;

  function tx(
    partial: Partial<Transaction> & Pick<Transaction, "id" | "dealAmount" | "dealDate">,
  ): Transaction {
    return {
      id: partial.id,
      dealType: partial.dealType ?? "trade",
      dealDate: partial.dealDate,
      aptName: partial.aptName ?? "미주B",
      gu: partial.gu ?? "용산구",
      dong: partial.dong ?? "이촌동",
      exclusiveArea: partial.exclusiveArea ?? 84.9,
      dealAmount: partial.dealAmount,
      monthlyRent: partial.monthlyRent ?? 0,
      floor: partial.floor ?? 5,
      buildYear: partial.buildYear ?? 1972,
      jibun: partial.jibun ?? "300-3",
      dealingGbn: partial.dealingGbn ?? "중개거래",
      lawdCd: partial.lawdCd ?? YONGSAN_LAWD_CD,
    };
  }

  const db = getDb();
  assert.ok(db, "local file db");
  await ensureSchema(db);
  assert.equal(await hasDiscoveryAtColumn(db), present, `column present=${present}`);

  if (!present) {
    await assert.rejects(
      () => db.execute("SELECT discovery_at FROM transactions LIMIT 1"),
      /no such column: discovery_at/,
    );
  }

  const today = seoulToday();
  const ym = `${today.slice(0, 4)}${today.slice(5, 7)}`;

  const d1 = await replaceMonthTransactions({
    lawdCd: YONGSAN_LAWD_CD,
    yearMonth: ym,
    dealKind: "trade",
    items: [
      tx({
        id: "disc-1",
        aptName: "발견A",
        dealAmount: 250000,
        dealDate: today,
        floor: 1,
        jibun: "1-1",
      }),
    ],
    setFirstSeenOnInsert: true,
  });
  assert.equal(d1.inserted, 1);

  const seen1 = (
    await db.execute(
      `SELECT first_seen_at, last_seen_at${present ? ", discovery_at" : ""}
       FROM transactions WHERE apt_name='발견A'`,
    )
  ).rows[0];
  assert.ok(seen1?.first_seen_at, "discovery=1 sets first_seen");
  if (present) {
    assert.ok(seen1?.discovery_at);
    assert.equal(String(seen1!.first_seen_at), String(seen1!.discovery_at));
  }
  const keepFirst = String(seen1!.first_seen_at);
  const keepLast = String(seen1!.last_seen_at);
  const keepDiscovery = present ? String(seen1!.discovery_at) : null;

  const d0 = await replaceMonthTransactions({
    lawdCd: YONGSAN_LAWD_CD,
    yearMonth: ym,
    dealKind: "trade",
    items: [
      tx({
        id: "disc-1",
        aptName: "발견A",
        dealAmount: 250000,
        dealDate: today,
        floor: 1,
        jibun: "1-1",
      }),
      tx({
        id: "back-1",
        aptName: "백필B",
        dealAmount: 122000,
        dealDate: today,
        floor: 2,
        jibun: "2-2",
      }),
    ],
    setFirstSeenOnInsert: false,
  });
  assert.equal(d0.inserted, 1);
  assert.equal(d0.unchanged, 1);

  const seen0 = (
    await db.execute(
      `SELECT first_seen_at${present ? ", discovery_at" : ""}
       FROM transactions WHERE apt_name='백필B'`,
    )
  ).rows[0];
  if (present) {
    assert.ok(seen0?.first_seen_at, "column present: discovery=0 still records first_seen");
    assert.equal(seen0?.discovery_at == null || seen0?.discovery_at === "", true);
  } else {
    assert.equal(
      seen0?.first_seen_at == null || seen0?.first_seen_at === "",
      true,
      "column absent: discovery=0 keeps legacy first_seen NULL",
    );
  }

  const noop = await replaceMonthTransactions({
    lawdCd: YONGSAN_LAWD_CD,
    yearMonth: ym,
    dealKind: "trade",
    items: [
      tx({
        id: "disc-1",
        aptName: "발견A",
        dealAmount: 250000,
        dealDate: today,
        floor: 1,
        jibun: "1-1",
      }),
      tx({
        id: "back-1",
        aptName: "백필B",
        dealAmount: 122000,
        dealDate: today,
        floor: 2,
        jibun: "2-2",
      }),
    ],
    setFirstSeenOnInsert: true,
  });
  assert.equal(noop.inserted, 0);
  assert.equal(noop.updated, 0);
  assert.equal(noop.deleted, 0);
  assert.equal(noop.unchanged, 2);
  assert.equal(noop.wrote, false);
  const afterNoop = (
    await db.execute(
      `SELECT first_seen_at, last_seen_at${present ? ", discovery_at" : ""}
       FROM transactions WHERE apt_name='발견A'`,
    )
  ).rows[0];
  assert.equal(String(afterNoop!.first_seen_at), keepFirst);
  assert.equal(String(afterNoop!.last_seen_at), keepLast);
  if (present) assert.equal(String(afterNoop!.discovery_at), keepDiscovery);

  await new Promise((r) => setTimeout(r, 5));
  const upd = await replaceMonthTransactions({
    lawdCd: YONGSAN_LAWD_CD,
    yearMonth: ym,
    dealKind: "trade",
    items: [
      tx({
        id: "disc-1",
        aptName: "발견A",
        dealAmount: 250000,
        dealDate: today,
        floor: 1,
        jibun: "1-1",
        dealingGbn: "직거래",
      }),
      tx({
        id: "back-1",
        aptName: "백필B",
        dealAmount: 122000,
        dealDate: today,
        floor: 2,
        jibun: "2-2",
      }),
    ],
    setFirstSeenOnInsert: true,
  });
  assert.equal(upd.updated, 1);
  assert.equal(upd.unchanged, 1);
  const afterUpd = (
    await db.execute(
      `SELECT first_seen_at, last_seen_at, dealing_gbn${present ? ", discovery_at" : ""}
       FROM transactions WHERE apt_name='발견A'`,
    )
  ).rows[0];
  assert.equal(String(afterUpd!.first_seen_at), keepFirst);
  assert.notEqual(String(afterUpd!.last_seen_at), keepLast);
  assert.equal(String(afterUpd!.dealing_gbn), "직거래");
  if (present) assert.equal(String(afterUpd!.discovery_at), keepDiscovery);

  const aptRows = await queryAptTransactions({
    lawdCodes: [YONGSAN_LAWD_CD],
    aptName: "백필B",
    yearMonths: [ym],
    dealKinds: ["trade"],
  });
  assert.equal(aptRows.length, 1);

  const home = await computeMarketHome();
  assert.equal(home.source, "db");
  assert.equal(home.kpis.newDealCount, 1, "Home includes discovery=1 only");
  const homeNames = [
    ...home.notables,
    ...home.singoga,
    ...home.drops,
    ...home.highDeals,
  ].map((d) => d.aptName);
  assert.ok(homeNames.includes("발견A"));
  assert.equal(homeNames.includes("백필B"), false);

  clearRegionDailyCaches();
  const region = await getRegionDaily({
    regionSlug: "seoul-yongsan",
    contractMonth: ym,
    yearMonth: ym,
    part: "all",
  });
  assert.equal(region.source, "db");
  assert.equal(region.monthTradeCount, 2, "Section1 deal_date includes backfill");
  const section2Names = region.deals.map((d) => d.aptName);
  assert.ok(section2Names.includes("발견A"), "Section2 keeps discovery=1");
  assert.equal(section2Names.includes("백필B"), false, "Section2 excludes discovery=0");
  const calendarCount = region.days.find((d) => d.date === today)?.dealCount ?? 0;
  assert.equal(calendarCount, 2, "calendar includes discovery=0 on deal_date");
  const historyNames = region.historySections.flatMap((s) =>
    s.deals.map((d) => d.aptName),
  );
  assert.ok(historyNames.includes("백필B"), "Section3 includes discovery=0");
  assert.ok(region.activityYearMonths.includes(ym), "activityMonth from deal_date");
  assert.equal(region.historyDateAxis, "deal_date");

  console.log(
    JSON.stringify({
      ok: true,
      schema: present ? "present" : "absent",
      cases: [
        "home",
        "region-section2",
        "region-section3",
        "calendar",
        "activityMonth",
        "discovery=1",
        "discovery=0",
        "update-preserve",
        "unchanged-write-0",
        "deal-date-unchanged",
      ],
    }),
  );

  try {
    unlinkSync(dbPath);
  } catch {
    /* ignore */
  }
}

runWorker().catch((err) => {
  console.error(MODE, err);
  process.exit(1);
});

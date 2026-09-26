/**
 * 단지 실거래 스냅샷(apt_tx_hist_snap) 테스트.
 *
 *   npx tsx scripts/test-apt-tx-snapshot.ts            # 로컬 file DB (production 에 쓰지 않음)
 *   npx tsx scripts/test-apt-tx-snapshot.ts --seed-prod # 위 + production 에서 3단지 행을 읽어와 씨앗으로 (읽기만)
 *
 * 확인하는 것
 * - 인코딩 왕복 (null·빈 문자열·음수 층·규칙 밖 id·"~1" 꼬리·이상한 날짜)
 * - 빌드 뒤 스냅샷 경로 = 라이브 쿼리 (trade+rent, trade만, rent만)
 * - 행 수가 그대로인 직접 UPDATE(apt_dong) → 스냅샷 안 씀(라이브) → 갱신 뒤 다시 적중·동일
 * - 내용 밖 컬럼만 바뀐 UPDATE(last_seen_at) → 갱신이 mark 만 올림(markOnly)
 * - 빌드 도중 변경(경합) → 저장 안 됨(raced), 읽기는 라이브, 다음 갱신이 잡음
 * - 행 읽기 실패 → 아무것도 저장 안 됨 (에러 전파)
 * - 트리거 삭제 → 스냅샷 안 씀
 * - 단지 행 전부 삭제 → 스냅샷 행 삭제
 * - 기준 번호(watermark)는 목록 읽기 전 번호로만 오르고, 실패 lawd 가 있으면 그대로
 */
import { resolve } from "node:path";
import { existsSync, unlinkSync } from "node:fs";
import assert from "node:assert/strict";
import { config } from "dotenv";
import { createClient, type Client, type InStatement } from "@libsql/client";

config({ path: ".env.local" });
const PROD_URL = process.env.TURSO_DATABASE_URL?.trim();
const PROD_TOKEN = process.env.TURSO_AUTH_TOKEN?.trim();

const dbPath = resolve("data/test-apt-tx-snapshot.db");
for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
  if (existsSync(p)) unlinkSync(p);
}
process.env.TURSO_DATABASE_URL = `file:${dbPath}`;
delete process.env.TURSO_AUTH_TOKEN;
delete process.env.MOLIT_API_KEY;

import { ensureSchema, getDb } from "../src/lib/db/client";
import { queryAptTransactions } from "../src/lib/db/repository";
import { applyTxChangeTracking } from "../src/lib/db/tx-change-schema";
import {
  APT_TX_ORDER_BY,
  APT_TX_SELECT_COLUMNS,
  APT_TX_SNAPSHOT_DDL,
  APT_TX_SNAPSHOT_TABLE,
  buildAptTxSnapshotsForLawd,
  mapAptTxRow,
  packAptTx,
  readAptTxSnapshot,
  readAptTxSnapshotWatermark,
  refreshAptTxSnapshots,
  resetAptTxSnapshotReadStateForTest,
  sameAptTxRows,
  unpackAptTx,
  writeAptTxSnapshotWatermark,
} from "../src/lib/db/apt-tx-snapshot";
import { readGlobalChangeSeq } from "../src/lib/db/snapshot-freshness";
import type { DealType, Transaction } from "../src/types/transaction";

const LAWD = "11680";

function row(i: number, over: Partial<Transaction> = {}): Transaction {
  const base: Transaction = {
    id: "",
    dealType: i % 3 === 0 ? "rent" : "trade",
    dealDate: `2025-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 27) + 1).padStart(2, "0")}`,
    aptName: "테스트 아파트",
    gu: "강남구",
    dong: "대치동",
    exclusiveArea: [59.97, 84.99, 114.5][i % 3],
    dealAmount: 100000 + i * 137,
    monthlyRent: i % 3 === 0 ? i % 5 * 10 : 0,
    floor: (i % 25) - 1,
    buildYear: i % 11 === 0 ? null : 2008,
    jibun: i % 13 === 0 ? "" : "1-1",
    dealingGbn: i % 2 ? "중개거래" : "",
    rgstDate: i % 4 === 0 ? `2025-12-${String((i % 27) + 1).padStart(2, "0")}` : null,
    aptDong: i % 5 === 0 ? `${100 + (i % 9)}` : null,
    ...over,
  };
  if (!over.id) {
    base.id = [
      base.dealType,
      LAWD,
      base.dealDate,
      base.aptName.replace(/\s+/g, ""),
      base.dong,
      base.jibun,
      String(base.floor),
      String(base.dealAmount),
      String(base.monthlyRent),
      String(base.exclusiveArea),
    ].join("-");
    if (i % 17 === 0) base.id += "~1";
    if (i % 19 === 0) base.id = `legacy-${i}`;
  }
  return base;
}

function roundTripUnit(): void {
  const rows = Array.from({ length: 60 }, (_, i) => row(i));
  rows.sort((a, b) => (a.dealDate === b.dealDate ? (a.id < b.id ? -1 : 1) : a.dealDate < b.dealDate ? 1 : -1));
  assert.equal(sameAptTxRows(rows, unpackAptTx(packAptTx(rows, LAWD), LAWD)), null);
  // 이상한 날짜 → 사전 경로
  const odd = [row(1, { dealDate: "2025-02-30" }), row(2, { dealDate: "2025-2-3" })];
  assert.equal(sameAptTxRows(odd, unpackAptTx(packAptTx(odd, LAWD), LAWD)), null);
  // 한 행 (모든 컬럼 상수)
  const one = [row(5)];
  assert.equal(sameAptTxRows(one, unpackAptTx(packAptTx(one, LAWD), LAWD)), null);
  assert.equal(unpackAptTx(packAptTx([], LAWD), LAWD).length, 0);
  // 다른 lawd 로 디코드하면 규칙 id 가 달라진다 (키가 lawd 를 포함) — 빌드는 항상 같은 lawd 로 왕복 확인
  const other = unpackAptTx(packAptTx(rows, LAWD), "99999");
  assert.notEqual(sameAptTxRows(rows, other), null);
  console.log("ok  roundtrip unit");
}

async function insertRows(db: Client, lawdCd: string, rows: Transaction[]): Promise<void> {
  const stmts: InStatement[] = rows.map((t) => ({
    sql: `INSERT INTO transactions (id, lawd_cd, year_month, deal_type, deal_date, apt_name, apt_name_norm,
            gu, dong, exclusive_area, deal_amount, monthly_rent, floor, build_year, jibun, dealing_gbn,
            rgst_date, apt_dong)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      t.id,
      lawdCd,
      t.dealDate.slice(0, 4) + t.dealDate.slice(5, 7),
      t.dealType,
      t.dealDate,
      t.aptName,
      t.aptName.replace(/\s+/g, "").toLowerCase(),
      t.gu,
      t.dong,
      t.exclusiveArea,
      t.dealAmount,
      t.monthlyRent,
      t.floor,
      t.buildYear,
      t.jibun,
      t.dealingGbn,
      t.rgstDate ?? null,
      t.aptDong ?? null,
    ],
  }));
  for (let i = 0; i < stmts.length; i += 200) await db.batch(stmts.slice(i, i + 200), "write");
}

async function live(lawdCd: string, apt: string, kinds?: DealType[]): Promise<Transaction[]> {
  process.env.APT_TX_SNAPSHOT_READ = "0";
  try {
    return await queryAptTransactions({ lawdCodes: [lawdCd], aptName: apt, yearMonths: [], dealKinds: kinds });
  } finally {
    delete process.env.APT_TX_SNAPSHOT_READ;
  }
}

async function assertSnapshotEqualsLive(db: Client, lawdCd: string, norm: string, label: string) {
  const snap = await readAptTxSnapshot(db, lawdCd, norm);
  assert.ok(snap, `${label}: snapshot should hit`);
  for (const kinds of [undefined, ["trade"], ["rent"]] as Array<DealType[] | undefined>) {
    const viaRepo = await queryAptTransactions({ lawdCodes: [lawdCd], aptName: norm, yearMonths: [], dealKinds: kinds });
    const l = await live(lawdCd, norm, kinds);
    assert.equal(sameAptTxRows(l, viaRepo), null, `${label} kinds=${kinds?.join("+") ?? "all"}`);
  }
}

async function seedFromProd(db: Client): Promise<Array<{ lawdCd: string; norm: string }>> {
  if (!PROD_URL || PROD_URL.startsWith("file:")) throw new Error("--seed-prod: production URL 없음");
  const prod = createClient({ url: PROD_URL, authToken: PROD_TOKEN || undefined });
  const picks = [
    { lawdCd: "11200", norm: "현대그린" },
    { lawdCd: "41390", norm: "주공1" },
    { lawdCd: "41171", norm: "제나시티" },
  ];
  for (const p of picks) {
    const rs = await prod.execute({
      sql: `SELECT ${APT_TX_SELECT_COLUMNS} FROM transactions
            WHERE lawd_cd = ? AND apt_name_norm = ? AND +deal_type IN ('trade','rent') ORDER BY ${APT_TX_ORDER_BY}`,
      args: [p.lawdCd, p.norm],
    });
    const rows = rs.rows.map((r) => mapAptTxRow(r as unknown as Record<string, unknown>));
    assert.ok(rows.length > 0, `prod seed ${p.norm}`);
    await insertRows(db, p.lawdCd, rows);
  }
  prod.close();
  return picks;
}

async function main() {
  roundTripUnit();

  const db = getDb()!;
  await ensureSchema(db);
  // production 에만 있는 컬럼 (별도 마이그레이션으로 추가된 것)
  for (const col of ["rgst_date", "apt_dong"]) {
    const info = await db.execute(`PRAGMA table_info(transactions)`);
    if (!info.rows.some((r) => r.name === col)) await db.execute(`ALTER TABLE transactions ADD COLUMN ${col} TEXT`);
  }
  await db.execute(`CREATE TABLE IF NOT EXISTS snapshot_watermark (
    family TEXT PRIMARY KEY, synced_through TEXT NOT NULL, built_at TEXT NOT NULL)`);

  // 표·트리거 없음: 읽기 null(라이브), 빌드 에러
  assert.equal(await readAptTxSnapshot(db, LAWD, "a"), null);
  await db.execute(APT_TX_SNAPSHOT_DDL);
  await assert.rejects(buildAptTxSnapshotsForLawd(db, LAWD, { dryRun: false, pauseMs: 0 }));
  await applyTxChangeTracking(db);

  const A = "테스트아파트";
  const B = "비단지";
  const aRows = Array.from({ length: 300 }, (_, i) => row(i));
  const bRows = Array.from({ length: 40 }, (_, i) => row(i + 1000, { aptName: "비 단지", id: `b-${i}` }));
  await insertRows(db, LAWD, [...aRows, ...bRows]);
  const seeded = process.argv.includes("--seed-prod") ? await seedFromProd(db) : [];

  // 위에서 표 없음으로 5분 읽기 비활성 → 초기화
  resetAptTxSnapshotReadStateForTest();

  // 1) 전체 빌드
  const seqStart = await readGlobalChangeSeq(db);
  const s1 = await buildAptTxSnapshotsForLawd(db, LAWD, { dryRun: false, pauseMs: 0 });
  assert.equal(s1.inserted, 2);
  for (const p of seeded) await buildAptTxSnapshotsForLawd(db, p.lawdCd, { dryRun: false, pauseMs: 0 });
  await writeAptTxSnapshotWatermark(db, seqStart);
  await assertSnapshotEqualsLive(db, LAWD, A, "A built");
  await assertSnapshotEqualsLive(db, LAWD, B, "B built");
  for (const p of seeded) await assertSnapshotEqualsLive(db, p.lawdCd, p.norm, `prod ${p.norm}`);
  // 다시 돌리면 전부 fresh (행 안 읽음)
  const s2 = await buildAptTxSnapshotsForLawd(db, LAWD, { dryRun: false, pauseMs: 0 });
  assert.equal(s2.fresh, 2);
  assert.equal(s2.rowsRead, 0);
  console.log("ok  build + identity (+ rebuild skips fresh)");

  // 2) 행 수 그대로인 직접 UPDATE (sync 밖) → 스냅샷 안 씀
  const target = aRows[10].id;
  await db.execute({ sql: `UPDATE transactions SET apt_dong = '999' WHERE id = ?`, args: [target] });
  assert.equal(await readAptTxSnapshot(db, LAWD, A), null, "count-preserving update must invalidate");
  assert.notEqual(await readAptTxSnapshot(db, LAWD, B), null, "other complex stays valid");
  const liveAfter = await live(LAWD, A);
  assert.equal(liveAfter.find((t) => t.id === target)?.aptDong, "999");
  const viaRepo = await queryAptTransactions({ lawdCodes: [LAWD], aptName: A, yearMonths: [] });
  assert.equal(sameAptTxRows(liveAfter, viaRepo), null);
  const r1 = await refreshAptTxSnapshots(db, { pauseMs: 0, log: () => {} });
  assert.equal(r1.changed, 1);
  assert.equal(r1.stats[0].updated, 1);
  assert.equal(r1.watermark.to, await readGlobalChangeSeq(db));
  await assertSnapshotEqualsLive(db, LAWD, A, "A after refresh");
  console.log("ok  count-preserving UPDATE → live, refresh → hit");

  // 3) 내용 밖 컬럼만 바뀜 → mark 만
  await db.execute({ sql: `UPDATE transactions SET last_seen_at = 'x' WHERE id = ?`, args: [target] });
  assert.equal(await readAptTxSnapshot(db, LAWD, A), null);
  const r2 = await refreshAptTxSnapshots(db, { pauseMs: 0, log: () => {} });
  assert.equal(r2.stats[0].markOnly, 1);
  await assertSnapshotEqualsLive(db, LAWD, A, "A after markOnly");
  console.log("ok  non-payload UPDATE → markOnly");

  // 4) 경합: 행을 읽은 직후(저장 전) 변경 → 저장 안 됨, 기준 번호는 그 변경을 다음에 다시 잡음
  await db.execute({ sql: `UPDATE transactions SET deal_amount = deal_amount + 1 WHERE id = ?`, args: [target] });
  const racing: Client = new Proxy(db, {
    get(t, prop) {
      if (prop === "execute") {
        return async (stmt: InStatement) => {
          const res = await t.execute(stmt);
          const sql = typeof stmt === "string" ? stmt : stmt.sql;
          if (sql.includes("ORDER BY apt_name_norm")) {
            await t.execute({ sql: `UPDATE transactions SET floor = floor + 1 WHERE id = ?`, args: [target] });
          }
          return res;
        };
      }
      const v = Reflect.get(t, prop);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  const wmBefore = await readAptTxSnapshotWatermark(db);
  const r3 = await refreshAptTxSnapshots(racing, { pauseMs: 0, log: () => {} });
  assert.equal(r3.stats[0].raced, 1);
  assert.equal(await readAptTxSnapshot(db, LAWD, A), null, "raced snapshot must not be served");
  assert.ok((await readAptTxSnapshotWatermark(db))! > wmBefore!);
  const r4 = await refreshAptTxSnapshots(db, { pauseMs: 0, log: () => {} });
  assert.equal(r4.changed, 1, "racing change is picked up next time");
  assert.equal(r4.stats[0].updated, 1);
  await assertSnapshotEqualsLive(db, LAWD, A, "A after race");
  console.log("ok  race → not stored, next refresh picks up");

  // 5) 행 읽기 실패 → 저장 없음, 기준 번호 그대로
  await db.execute({ sql: `UPDATE transactions SET dealing_gbn = '직거래' WHERE id = ?`, args: [target] });
  const failing: Client = new Proxy(db, {
    get(t, prop) {
      if (prop === "execute") {
        return async (stmt: InStatement) => {
          const sql = typeof stmt === "string" ? stmt : stmt.sql;
          if (sql.includes("ORDER BY apt_name_norm")) throw new Error("simulated read failure");
          return t.execute(stmt);
        };
      }
      const v = Reflect.get(t, prop);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  const before = await db.execute(`SELECT built_at, mark FROM ${APT_TX_SNAPSHOT_TABLE} WHERE apt_name_norm = '${A}'`);
  const wm5 = await readAptTxSnapshotWatermark(db);
  const r5 = await refreshAptTxSnapshots(failing, { pauseMs: 0, log: () => {} });
  assert.deepEqual(r5.failedLawds, [LAWD]);
  assert.equal(r5.watermark.to, null);
  assert.equal(await readAptTxSnapshotWatermark(db), wm5);
  const after = await db.execute(`SELECT built_at, mark FROM ${APT_TX_SNAPSHOT_TABLE} WHERE apt_name_norm = '${A}'`);
  assert.deepEqual(after.rows[0], before.rows[0]);
  assert.equal(await readAptTxSnapshot(db, LAWD, A), null);
  await refreshAptTxSnapshots(db, { pauseMs: 0, log: () => {} });
  await assertSnapshotEqualsLive(db, LAWD, A, "A after failed read + refresh");
  console.log("ok  failed read → nothing stored");

  // 6) 단지 행 전부 삭제 → 스냅샷 행 삭제
  await db.execute({ sql: `DELETE FROM transactions WHERE apt_name_norm = ?`, args: [B] });
  assert.equal(await readAptTxSnapshot(db, LAWD, B), null);
  const r6 = await refreshAptTxSnapshots(db, { pauseMs: 0, log: () => {} });
  assert.equal(r6.stats[0].deleted, 1);
  const left = await db.execute({ sql: `SELECT COUNT(*) AS n FROM ${APT_TX_SNAPSHOT_TABLE} WHERE apt_name_norm = ?`, args: [B] });
  assert.equal(Number(left.rows[0].n), 0);
  console.log("ok  all rows deleted → snapshot deleted");

  // 7) 새 단지 INSERT → 갱신이 만든다
  await insertRows(db, LAWD, [row(1, { aptName: "새단지", id: "new-1" })]);
  const r7 = await refreshAptTxSnapshots(db, { pauseMs: 0, log: () => {} });
  assert.equal(r7.stats[0].inserted, 1);
  await assertSnapshotEqualsLive(db, LAWD, "새단지", "new complex");
  console.log("ok  new complex → inserted");

  // 8) 트리거가 없어지면 스냅샷 안 씀 (트리거 확인은 10분 캐시 — 테스트는 캐시 초기화)
  await db.execute(`DROP TRIGGER trg_tx_change_au`);
  resetAptTxSnapshotReadStateForTest();
  assert.equal(await readAptTxSnapshot(db, LAWD, A), null, "missing trigger → live");
  await assert.rejects(refreshAptTxSnapshots(db, { pauseMs: 0, log: () => {} }));
  console.log("ok  missing trigger → live");

  console.log("ALL OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

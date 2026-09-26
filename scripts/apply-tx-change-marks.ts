/**
 * transactions 변경 표시(tx_change_seq / tx_change_marks + 트리거 4개) 적용.
 * 새 표 2개와 트리거만 만든다 — transactions 행·인덱스는 건드리지 않는다. IF NOT EXISTS 라 다시 돌려도 무해.
 *
 *   npx tsx scripts/apply-tx-change-marks.ts           # 드라이런: 문장과 현재 상태만 출력
 *   npx tsx scripts/apply-tx-change-marks.ts --apply   # 적용 (문장 하나씩, 5초 넘으면 멈춤)
 */
import { config } from "dotenv";
import { createClient } from "@libsql/client";
import { TX_CHANGE_MIGRATION, txChangeTrackingStatements } from "../src/lib/db/tx-change-schema";

config({ path: ".env.local" });

const APPLY = process.argv.includes("--apply");

async function state(db: ReturnType<typeof createClient>) {
  const rs = await db.execute(
    `SELECT type, name FROM sqlite_master
     WHERE name IN ('tx_change_seq', 'tx_change_marks')
        OR (type = 'trigger' AND tbl_name = 'transactions')
     ORDER BY type, name`,
  );
  return rs.rows.map((r) => `${r.type}:${r.name}`);
}

async function main() {
  const url = process.env.TURSO_DATABASE_URL?.trim();
  if (!url) throw new Error("TURSO_DATABASE_URL missing");
  const db = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN?.trim() || undefined });

  const stmts = txChangeTrackingStatements();
  console.log(`[tx-change] ${TX_CHANGE_MIGRATION}: ${stmts.length} statements`);
  console.log("[tx-change] before:", JSON.stringify(await state(db)));
  if (!APPLY) {
    for (const s of stmts) console.log(`---\n${s};`);
    console.log("[tx-change] DRY-RUN (--apply 로 적용)");
    return;
  }
  for (const sql of stmts) {
    const t0 = Date.now();
    await db.execute(sql);
    const ms = Date.now() - t0;
    console.log(`[tx-change] ok ${ms}ms: ${sql.split("\n")[0]}`);
    if (ms > 5000) throw new Error(`statement took ${ms}ms — stopping`);
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log("[tx-change] after:", JSON.stringify(await state(db)));
  const seq = await db.execute(`SELECT seq FROM tx_change_seq WHERE id = 1`);
  const marks = await db.execute(`SELECT COUNT(*) AS n FROM tx_change_marks`);
  console.log(`[tx-change] seq=${seq.rows[0]?.seq} marks=${marks.rows[0]?.n}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

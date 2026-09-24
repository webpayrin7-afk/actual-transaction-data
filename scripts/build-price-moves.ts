/**
 * 신고가 · 하락 거래 기록(market_price_moves) 만들기.
 * 이 테이블 외에는 쓰지 않는다 (transactions는 읽기만).
 *
 *   npm run db:price-moves                          # 오늘(KST) dry-run — 쓰기 없음, 건수만
 *   npm run db:price-moves -- --days=30             # 최근 30일 dry-run
 *   npm run db:price-moves -- --from=2026-09-01 --to=2026-09-24
 *   npm run db:price-moves -- --days=30 --apply     # 테이블 만들고 없는 행만 넣음 (INSERT OR IGNORE)
 *
 * 다시 돌리면 새로 들어가는 행이 0이어야 한다 (tx_id PK, 이미 있는 행은 건드리지 않음).
 * 하루에 처음 확인된 매매가 --bulk-guard(기본 20,000)를 넘으면 대량 적재일로 보고 건너뛴다.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "../src/lib/db/client";
import { addDays } from "../src/lib/market/keys";
import { seoulToday } from "../src/lib/market/time";
import {
  PRICE_MOVES_RULE_VERSION,
  computePriceMovesForDay,
} from "../src/lib/market/price-moves-build";

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

async function main() {
  const db = getDb();
  if (!db) throw new Error("DB가 설정되지 않았습니다.");
  const apply = process.argv.includes("--apply");
  const today = seoulToday();
  const days = Number(arg("days") ?? "1");
  const to = arg("to") ?? today;
  const from = arg("from") ?? addDays(to, -(Math.max(1, days) - 1));
  const bulkGuard = Number(arg("bulk-guard") ?? "20000");

  if (apply) {
    const ddl = readFileSync(join(process.cwd(), "src/lib/db/migrations/20260925_market_price_moves.sql"), "utf8");
    for (const stmt of ddl
      .split(/;\s*\n/)
      .map((s) => s.replace(/^\s*--.*$/gm, "").trim())
      .filter(Boolean)) {
      await db.execute(stmt);
    }
  }

  const summary: Array<Record<string, unknown>> = [];
  let totalRows = 0;
  let totalInserted = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const t0 = Date.now();
    const day = await computePriceMovesForDay(db, d);
    if (day.seenTrades > bulkGuard) {
      summary.push({ day: d, seen: day.seenTrades, skipped: "bulk-guard" });
      continue;
    }
    const singoga = day.rows.filter((r) => r.kind === "singoga").length;
    const drop = day.rows.length - singoga;
    let inserted = 0;
    if (apply && day.rows.length) {
      const now = new Date().toISOString();
      const stmts = day.rows.map((r) => ({
        sql: `INSERT OR IGNORE INTO market_price_moves
              (tx_id, kind, seen_date, deal_date, lawd_cd, apt_name, apt_name_norm, gu, dong,
               exclusive_area, floor, deal_amount, prior_max_amount, prior_max_date,
               change_amount, change_pct, rule_version, computed_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          r.txId, r.kind, r.seenDate, r.dealDate, r.lawdCd, r.aptName, r.aptNameNorm, r.gu, r.dong,
          r.exclusiveArea, r.floor, r.dealAmount, r.priorMaxAmount, r.priorMaxDate,
          r.changeAmount, r.changePct, PRICE_MOVES_RULE_VERSION, now,
        ],
      }));
      for (let i = 0; i < stmts.length; i += 200) {
        const res = await db.batch(stmts.slice(i, i + 200), "write");
        inserted += res.reduce((n, x) => n + x.rowsAffected, 0);
      }
    }
    totalRows += day.rows.length;
    totalInserted += inserted;
    summary.push({ day: d, seen: day.seenTrades, singoga, drop, ...(apply ? { inserted } : {}), ms: Date.now() - t0 });
  }

  console.table(summary);
  console.log(
    JSON.stringify({ mode: apply ? "apply" : "dry-run", from, to, ruleVersion: PRICE_MOVES_RULE_VERSION, rows: totalRows, ...(apply ? { inserted: totalInserted } : {}) }),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

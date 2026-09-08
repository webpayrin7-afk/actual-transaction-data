/**
 * 전국 확대 비용 추정 (DB 밀도 기반, WRITE 0 / MOLIT 0)
 *
 *   npx tsx scripts/estimate-nationwide.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import {
  allCapitalLawdCodes,
  allNationwideLawdCodes,
} from "../src/lib/constants/regions-registry";
import { ensureSchema, getDb, hasDb } from "../src/lib/db/client";

async function main() {
  const capital = allCapitalLawdCodes();
  const nation = allNationwideLawdCodes();
  const novel = nation.filter((c) => !capital.includes(c));

  console.log("=== coverage target ===");
  console.log({
    capitalLawds: capital.length,
    nationwideLawds: nation.length,
    novelLawds: novel.length,
  });

  if (!hasDb()) {
    console.log("NO DB — structural estimate only");
    return;
  }
  await ensureSchema();
  const db = getDb()!;

  const trade = Number(
    (
      await db.execute(
        `SELECT COUNT(*) AS c FROM transactions WHERE deal_type='trade'`,
      )
    ).rows[0]?.c ?? 0,
  );
  const rent = Number(
    (
      await db.execute(
        `SELECT COUNT(*) AS c FROM transactions WHERE deal_type='rent'`,
      )
    ).rows[0]?.c ?? 0,
  );
  const depth = await db.execute(
    `SELECT MIN(year_month) AS mn, MAX(year_month) AS mx FROM sync_months WHERE deal_kind='trade'`,
  );
  const mn = String(depth.rows[0]?.mn ?? "");
  const mx = String(depth.rows[0]?.mx ?? "");
  const months =
    mn && mx
      ? (Number(mx.slice(0, 4)) - Number(mn.slice(0, 4))) * 12 +
        (Number(mx.slice(4, 6)) - Number(mn.slice(4, 6))) +
        1
      : 120;

  const tradePerLawdMonth = trade / Math.max(capital.length, 1) / Math.max(months, 1);
  const rentPerLawdMonth = rent / Math.max(capital.length, 1) / Math.max(months, 1);

  // 비수도권은 보수적으로 수도권 밀도의 45%로 가정 (실측 전)
  const novelFactor = 0.45;

  function estimate(monthCount: number) {
    const capitalTrade = Math.round(capital.length * monthCount * tradePerLawdMonth);
    const novelTrade = Math.round(
      novel.length * monthCount * tradePerLawdMonth * novelFactor,
    );
    const capitalRent = Math.round(capital.length * monthCount * rentPerLawdMonth);
    const novelRent = Math.round(
      novel.length * monthCount * rentPerLawdMonth * novelFactor,
    );
    // API: 대략 1 page/cell (대량 월은 추가 page) — 하한
    const apiCellsTrade = nation.length * monthCount;
    const apiCellsRent = nation.length * monthCount;
    return {
      monthCount,
      tradeRowsNationwideApprox: capitalTrade + novelTrade,
      rentRowsNationwideApprox: capitalRent + novelRent,
      novelTradeInsertsApprox: novelTrade,
      novelRentInsertsApprox: novelRent,
      novelWritesApprox: novelTrade + novelRent,
      apiCellsTradeLowerBound: apiCellsTrade,
      apiCellsRentLowerBound: apiCellsRent,
    };
  }

  console.log("=== current DB ===");
  console.log({
    trade,
    rent,
    total: trade + rent,
    syncDepth: { mn, mx, monthsApprox: months },
    tradePerLawdMonth: Math.round(tradePerLawdMonth * 10) / 10,
    rentPerLawdMonth: Math.round(rentPerLawdMonth * 10) / 10,
  });

  console.log("=== estimates (novel regions only inserts; capital already present) ===");
  for (const m of [1, 3, 12, months]) {
    console.log(estimate(m));
  }

  const full = estimate(months);
  console.log("=== STOP CONDITION hint ===");
  console.log({
    fullHistoryNovelWritesApprox: full.novelWritesApprox,
    note:
      "If Turso monthly write quota is in the low millions or below, DO NOT run full historical nationwide backfill. Prefer recent 1–3 months with --discovery=0.",
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

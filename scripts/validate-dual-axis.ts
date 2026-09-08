/**
 * Dual time-axis smoke validation
 *   npx tsx scripts/validate-dual-axis.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { getDb, ensureSchema } from "../src/lib/db/client";
import {
  computeMarketHome,
  rebuildMarketHomeSnapshot,
} from "../src/lib/market/home";
import { getMarketStats } from "../src/lib/market/stats";
import { resolvePeriodWindow } from "../src/lib/market/keys";

async function main() {
  await ensureSchema();
  const db = getDb();
  if (!db) throw new Error("no db");

  const cnt = await db.execute({
    sql: `SELECT COUNT(*) AS c, MIN(deal_date) AS mn, MAX(deal_date) AS mx
          FROM transactions WHERE deal_type = ?`,
    args: ["trade"],
  });
  const tradeCount = Number(cnt.rows[0]?.c ?? 0);
  const asOf = String(cnt.rows[0]?.mx ?? "");
  const minD = String(cnt.rows[0]?.mn ?? "");
  console.log("trade count/range", { tradeCount, minD, asOf });

  const fs = await db.execute({
    sql: `SELECT
            SUM(CASE WHEN first_seen_at IS NOT NULL AND first_seen_at != '' THEN 1 ELSE 0 END) AS seen,
            SUM(CASE WHEN first_seen_at IS NULL OR first_seen_at = '' THEN 1 ELSE 0 END) AS legacy
          FROM transactions WHERE deal_type = ?`,
    args: ["trade"],
  });
  console.log("first_seen seen/legacy", fs.rows[0]);

  const t0 = Date.now();
  const home = await computeMarketHome();
  console.log("home", {
    ms: Date.now() - t0,
    discoveryReady: home.discoveryReady,
    kpis: home.kpis,
    warning: home.warning?.slice(0, 100),
  });

  // Case E: legacy must not flood "today"
  if (home.kpis.newDealCount > 50_000) {
    throw new Error("FAIL case E: legacy flooded new deals");
  }
  console.log("case E ok");

  const snap = await rebuildMarketHomeSnapshot();
  console.log("home snapshot saved", snap.kpis);

  const weekly = resolvePeriodWindow(asOf, "weekly", asOf);
  console.log("weekly window", {
    curFrom: weekly.curFrom,
    curTo: weekly.curTo,
    chartFrom: weekly.chartFrom,
    compare: weekly.compareLabel,
    canNext: weekly.canGoNext,
  });

  const t1 = Date.now();
  const statsW = await getMarketStats({
    period: "weekly",
    scope: "all",
    date: asOf,
  });
  console.log("stats weekly", {
    ms: Date.now() - t1,
    selected: statsW.selectedDate,
    trade: statsW.kpi?.tradeCount,
    singogaShare: statsW.kpi?.singogaSharePct,
    dropShare: statsW.kpi?.dropSharePct,
    compare: statsW.kpi?.compareLabel,
    canNext: statsW.kpi?.canGoNext,
  });

  const rawWeek = await db.execute({
    sql: `SELECT COUNT(*) AS c FROM transactions
          WHERE deal_type = ? AND deal_date >= ? AND deal_date <= ?`,
    args: ["trade", weekly.curFrom, weekly.curTo],
  });
  console.log("weekly raw vs kpi", {
    raw: Number(rawWeek.rows[0]?.c),
    kpi: statsW.kpi?.tradeCount,
  });

  const statsD = await getMarketStats({
    period: "daily",
    scope: "all",
    date: asOf,
  });
  const rawDay = await db.execute({
    sql: `SELECT COUNT(*) AS c FROM transactions WHERE deal_type = ? AND deal_date = ?`,
    args: ["trade", asOf],
  });
  console.log("daily raw vs kpi", {
    raw: Number(rawDay.rows[0]?.c),
    kpi: statsD.kpi?.tradeCount,
  });

  const statsM = await getMarketStats({
    period: "monthly",
    scope: "seoul",
    date: asOf,
  });
  console.log("monthly seoul", {
    selected: statsM.selectedDate,
    trade: statsM.kpi?.tradeCount,
    window: statsM.kpi?.windowLabel,
  });

  // nav next disabled on latest
  if (statsW.kpi?.canGoNext) {
    console.warn("WARN: canGoNext true on asOf week — check window logic");
  } else {
    console.log("future nav disabled ok");
  }

  // prev then next
  const prev = await getMarketStats({
    period: "weekly",
    scope: "gyeonggi",
    date: statsW.kpi!.prevAnchor,
  });
  console.log("prev week gyeonggi", {
    selected: prev.selectedDate,
    trade: prev.kpi?.tradeCount,
    canNext: prev.kpi?.canGoNext,
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

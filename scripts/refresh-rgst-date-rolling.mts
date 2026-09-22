/**
 * Rolling AptTrade registration refresh (late-published rgstDate).
 * Forces only-changed=0 semantics for recent trade months.
 *
 *   npx tsx scripts/refresh-rgst-date-rolling.mts --plan=1
 *   npx tsx scripts/refresh-rgst-date-rolling.mts --apply=1 --months=12 --discovery=0
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { ensureSchema, getDb } from "../src/lib/db/client";
import { replaceMonthTransactions } from "../src/lib/db/repository";
import {
  hasRgstDateColumn,
  resetRgstDateColumnCache,
} from "../src/lib/db/rgst-date-column";
import { fetchOneTradeForSync } from "../src/lib/molit/client";
import { rgstDateFromTx } from "../src/lib/molit/rgst-date";

function argValue(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function rollingTradeMonths(months: number, asOf = new Date()): string[] {
  const out: string[] = [];
  const d = new Date(asOf);
  for (let i = 0; i < months; i += 1) {
    const y = d.getFullYear();
    const m = d.getMonth() + 1; // 1-12
    out.push(`${y}${String(m).padStart(2, "0")}`);
    d.setMonth(d.getMonth() - 1);
  }
  return out.filter((ym) => ym >= "202301");
}

async function main() {
  const apply = argValue("apply", "0") === "1";
  const planOnly = argValue("plan", "0") === "1";
  const discovery = argValue("discovery", "0") !== "0";
  const months = Math.min(24, Math.max(1, Number(argValue("months", "6")) || 6));
  const sleepMs = Math.max(0, Number(argValue("sleep-ms", "250")) || 0);
  const concurrency = Math.min(
    3,
    Math.max(1, Number(argValue("concurrency", "2")) || 1),
  );

  process.env.MOLIT_SYNCING = "1";
  const db = getDb();
  if (!db) throw new Error("DB unavailable");

  const yms = rollingTradeMonths(months);
  const cellRes = await db.execute({
    sql: `SELECT lawd_cd AS lawd, year_month AS ym
          FROM sync_months
          WHERE deal_kind='trade' AND year_month IN (${yms.map(() => "?").join(",")})
          ORDER BY year_month DESC, lawd_cd ASC`,
    args: yms,
  });
  const cells = cellRes.rows.map((r) => ({
    lawdCd: String(r.lawd),
    yearMonth: String(r.ym),
  }));
  const lawds = [...new Set(cells.map((c) => c.lawdCd))];

  console.error(
    `[rgst-refresh] months=${months} yms=${yms.join(",")} lawds=${lawds.length} cells=${cells.length} ` +
      `onlyChanged=0 apply=${apply ? 1 : 0}`,
  );

  if (planOnly) {
    console.log(
      JSON.stringify(
        {
          plan: true,
          windowMonths: months,
          yearMonths: yms,
          lawds: lawds.length,
          cells: cells.length,
          onlyChanged: 0,
          write: 0,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (apply) {
    await ensureSchema(db);
    resetRgstDateColumnCache();
    if (!(await hasRgstDateColumn(db))) {
      throw new Error("rgst_date column missing");
    }
  }

  let next = 0;
  const totals = {
    apiCalls: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    populated: 0,
    unresolved: 0,
    failed: 0,
  };

  async function worker() {
    while (true) {
      const i = next;
      next += 1;
      if (i >= cells.length) return;
      const cell = cells[i]!;
      try {
        if (sleepMs) await new Promise((r) => setTimeout(r, sleepMs));
        const items = await fetchOneTradeForSync(cell.lawdCd, cell.yearMonth);
        totals.apiCalls += 1;
        for (const tx of items) {
          if (rgstDateFromTx(tx)) totals.populated += 1;
          else if (tx.dealDate >= "2023-01-01") totals.unresolved += 1;
        }
        const result = await replaceMonthTransactions({
          lawdCd: cell.lawdCd,
          yearMonth: cell.yearMonth,
          dealKind: "trade",
          items,
          setFirstSeenOnInsert: discovery,
          dryRun: !apply,
          skipDelete: true,
        });
        totals.inserted += result.inserted;
        totals.updated += result.updated;
        totals.unchanged += result.unchanged;
        console.error(
          `[rgst-refresh] ${cell.lawdCd}|${cell.yearMonth} active=${items.length} ` +
            `ins=${result.inserted} upd=${result.updated} same=${result.unchanged}`,
        );
      } catch (err) {
        totals.failed += 1;
        console.error(
          `[rgst-refresh] FAIL ${cell.lawdCd}|${cell.yearMonth}`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  console.log(
    JSON.stringify(
      {
        apply,
        windowMonths: months,
        yearMonths: yms,
        cells: cells.length,
        onlyChanged: 0,
        totals,
      },
      null,
      2,
    ),
  );
  if (totals.failed > 0) process.exitCode = 3;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

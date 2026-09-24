/**
 * Songpa (11710) 2023+ AptTrade rgst_date pilot.
 *
 *   # dry-run (default): ALTER skipped unless column exists; classify only
 *   npx tsx scripts/pilot-rgst-date-songpa.mts
 *
 *   # apply: ensure column + replaceMonth for Songpa trade months
 *   npx tsx scripts/pilot-rgst-date-songpa.mts --apply=1 --discovery=0
 *
 * Identity: existing stableTransactionId / naturalKey / resolveActiveTrades.
 * No nationwide backfill. No rent. No fake matching.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { ensureSchema, getDb } from "../src/lib/db/client";
import { replaceMonthTransactions } from "../src/lib/db/repository";
import { resetRgstDateColumnCache, hasRgstDateColumn } from "../src/lib/db/rgst-date-column";
import { fetchOneTradeForSync } from "../src/lib/molit/client";
import { rgstDateFromTx } from "../src/lib/molit/rgst-date";

function argValue(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function yearMonthsBetween(fromYm: string, toYm: string): string[] {
  const out: string[] = [];
  let y = Number(fromYm.slice(0, 4));
  let m = Number(fromYm.slice(4, 6));
  const ty = Number(toYm.slice(0, 4));
  const tm = Number(toYm.slice(4, 6));
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
    if (out.length > 120) break;
  }
  return out;
}

async function main() {
  const apply = argValue("apply", "0") === "1";
  const discovery = argValue("discovery", "0") !== "0";
  const fromYm = argValue("from-month", "202301");
  const toYm = argValue("to-month", "202609");
  const lawdCd = argValue("lawd", "11710");
  const sleepMs = Math.max(0, Number(argValue("sleep-ms", "350")) || 0);

  process.env.MOLIT_SYNCING = "1";
  const db = getDb();
  if (!db) throw new Error("DB unavailable");

  if (apply) {
    await ensureSchema(db);
    resetRgstDateColumnCache();
  }

  const hasCol = await hasRgstDateColumn(db);
  if (apply && !hasCol) {
    throw new Error("rgst_date column missing after ensureSchema");
  }

  const months = yearMonthsBetween(fromYm, toYm);
  let apiCalls = 0;
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  let deleted = 0;
  let populated = 0;
  let unresolved = 0;
  let jamsilPopulated = 0;
  let jamsilUnresolved = 0;
  const identityConflicts = 0;

  for (const yearMonth of months) {
    if (sleepMs) await new Promise((r) => setTimeout(r, sleepMs));
    const items = await fetchOneTradeForSync(lawdCd, yearMonth);
    apiCalls += 1;
    for (const tx of items) {
      const rgst = rgstDateFromTx(tx);
      if (rgst) populated += 1;
      else if (tx.dealDate >= "2023-01-01") unresolved += 1;
      if (tx.aptName.includes("잠실엘스")) {
        if (rgst) jamsilPopulated += 1;
        else jamsilUnresolved += 1;
      }
    }

    const result = await replaceMonthTransactions({
      lawdCd,
      yearMonth,
      dealKind: "trade",
      items,
      setFirstSeenOnInsert: discovery,
      dryRun: !apply,
      skipDelete: true,
    });
    inserted += result.inserted;
    updated += result.updated;
    unchanged += result.unchanged;
    deleted += result.deleted;
    console.error(
      `[pilot-rgst] ${lawdCd} ${yearMonth} active=${items.length} ` +
        `ins=${result.inserted} upd=${result.updated} same=${result.unchanged} ` +
        `delCandidates=${result.deleted} dryRun=${apply ? 0 : 1}`,
    );
  }

  console.log(
    JSON.stringify(
      {
        apply,
        lawdCd,
        fromYm,
        toYm,
        months: months.length,
        apiCalls,
        hasRgstColumn: hasCol,
        totals: {
          inserted,
          updated,
          unchanged,
          deleteCandidatesSkipped: deleted,
          populated,
          unresolved2023plus: unresolved,
          jamsilPopulated,
          jamsilUnresolved,
          identityConflicts,
        },
        note: "skipDelete=1 keeps warehouse extras; cancel resolve already dropped cancelled-only rows from items",
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

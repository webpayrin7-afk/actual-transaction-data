/**
 * Force re-fetch explicit AptTrade cells (targeted retry).
 *   npx tsx scripts/retry-aptrade-cells.mts --apply=1 --cells=30200|202406,30200|202405
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { getDb, ensureSchema } from "../src/lib/db/client";
import { replaceMonthTransactions } from "../src/lib/db/repository";
import { fetchOneTradeForSync } from "../src/lib/molit/client";
import { rgstDateFromTx } from "../src/lib/molit/rgst-date";

const CHECKPOINT_PATH = resolve(
  "data/poc/aptrade-national-expand-checkpoint.json",
);

function argValue(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

async function main() {
  const apply = argValue("apply", "0") === "1";
  const cellsArg = argValue("cells", "");
  const cells = cellsArg
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [lawdCd, yearMonth] = s.split("|");
      return { lawdCd, yearMonth };
    });
  if (!cells.length) throw new Error("pass --cells=lawd|ym,...");

  process.env.MOLIT_SYNCING = "1";
  const db = getDb();
  if (!db) throw new Error("DB unavailable");
  await ensureSchema(db);

  const results = [];
  for (const { lawdCd, yearMonth } of cells) {
    try {
      const items = await fetchOneTradeForSync(lawdCd!, yearMonth!);
      const result = await replaceMonthTransactions({
        lawdCd: lawdCd!,
        yearMonth: yearMonth!,
        dealKind: "trade",
        items,
        setFirstSeenOnInsert: false,
        dryRun: !apply,
        skipDelete: false,
      });
      let populated = 0;
      for (const tx of items) if (rgstDateFromTx(tx)) populated += 1;
      results.push({
        key: `${lawdCd}|${yearMonth}`,
        ok: true,
        rows: items.length,
        ...result,
        populated,
      });
      if (existsSync(CHECKPOINT_PATH)) {
        const cp = JSON.parse(readFileSync(CHECKPOINT_PATH, "utf8"));
        const key = `${lawdCd}|${yearMonth}`;
        cp.completed[key] = {
          at: new Date().toISOString(),
          rowsFetched: items.length,
          inserted: result.inserted,
          updated: result.updated,
          unchanged: result.unchanged,
          deleted: result.deleted,
          retryCount: (cp.failed?.[key]?.attempts ?? 0) + 1,
          populated,
          unresolved: items.length - populated,
        };
        if (cp.failed) delete cp.failed[key];
        cp.updatedAt = new Date().toISOString();
        writeFileSync(CHECKPOINT_PATH, JSON.stringify(cp, null, 2));
      }
      console.log(`[retry] OK ${lawdCd}|${yearMonth} rows=${items.length} ins=${result.inserted} upd=${result.updated}`);
    } catch (err) {
      results.push({
        key: `${lawdCd}|${yearMonth}`,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
      console.warn(`[retry] FAIL ${lawdCd}|${yearMonth}`, err);
    }
  }
  console.log(JSON.stringify({ apply, results }, null, 2));
  if (results.some((r) => !r.ok)) process.exit(3);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

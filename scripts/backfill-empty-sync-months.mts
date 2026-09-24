/**
 * Backfill sync_months for completed expand cells that fetched 0 rows
 * (replaceMonthTransactions skips sync_months when there are no tx writes).
 *
 * Only writes for runnable AptTrade request lawds (never obsolete catalog codes).
 *
 *   npx tsx scripts/backfill-empty-sync-months.mts --apply=1
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });
config({ quiet: true });

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@libsql/client";
import { runnableAptTradeRequestLawds } from "../src/lib/molit/aptrade-lawd-mapping";

const CP = resolve("data/poc/aptrade-national-expand-checkpoint.json");

function argValue(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

async function main() {
  const apply = argValue("apply", "0") === "1";
  if (!existsSync(CP)) throw new Error(`missing ${CP}`);
  const cp = JSON.parse(readFileSync(CP, "utf8")) as {
    completed: Record<string, { rowsFetched: number }>;
  };
  const runnable = new Set(runnableAptTradeRequestLawds());
  const emptyKeys = Object.entries(cp.completed)
    .filter(([k, v]) => v.rowsFetched === 0 && runnable.has(k.split("|")[0]!))
    .map(([k]) => k);

  const db = createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN!,
  });

  const existing = await db.execute({
    sql: `SELECT lawd_cd || '|' || year_month AS k FROM sync_months
          WHERE deal_kind='trade'`,
  });
  const have = new Set(existing.rows.map((r) => String(r.k)));
  const missing = emptyKeys.filter((k) => !have.has(k));

  console.error(
    `[empty-sync] checkpointEmptyRunnable=${emptyKeys.length} missingSync=${missing.length} apply=${apply ? 1 : 0}`,
  );

  if (!apply) {
    console.log(
      JSON.stringify(
        { plan: true, missing: missing.length, sample: missing.slice(0, 20) },
        null,
        2,
      ),
    );
    return;
  }

  const now = new Date().toISOString();
  let wrote = 0;
  for (const key of missing) {
    const [lawdCd, yearMonth] = key.split("|");
    if (!lawdCd || !yearMonth) continue;
    await db.execute({
      sql: `INSERT INTO sync_months (lawd_cd, year_month, deal_kind, synced_at, row_count)
            VALUES (?, ?, 'trade', ?, 0)
            ON CONFLICT(lawd_cd, year_month, deal_kind) DO UPDATE SET
              synced_at = excluded.synced_at,
              row_count = excluded.row_count`,
      args: [lawdCd, yearMonth, now],
    });
    wrote += 1;
  }
  console.log(
    JSON.stringify({ apply: true, wrote, sample: missing.slice(0, 10) }, null, 2),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * Remove empty obsolete legacy prefix sync_months (42→51, 45→52 remapped).
 * Also drops empty Gyeonggi obsolete 41190/41590 if present with no warehouse rows.
 *
 *   npx tsx scripts/cleanup-legacy-empty-sync.mts --apply=1
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });
config({ quiet: true });

import { createClient } from "@libsql/client";
import { runnableAptTradeRequestLawds } from "../src/lib/molit/aptrade-lawd-mapping";
import { incheonTrueNodataLawds } from "../src/lib/molit/temporal-lawd";

function argValue(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

async function main() {
  const apply = argValue("apply", "0") === "1";
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN!,
  });
  const runnable = new Set(runnableAptTradeRequestLawds());
  const keep = new Set(incheonTrueNodataLawds());

  const rows = await db.execute({
    sql: `SELECT DISTINCT lawd_cd AS l FROM sync_months
          WHERE deal_kind='trade' AND year_month>='202301' AND row_count=0`,
  });
  const obsolete = rows.rows
    .map((r) => String(r.l))
    .filter((l) => !runnable.has(l) && !keep.has(l));

  // Skip if warehouse has any rows for that lawd
  const survivors: string[] = [];
  for (const l of obsolete) {
    const hit = await db.execute({
      sql: `SELECT 1 AS x FROM transactions
            WHERE deal_type='trade' AND lawd_cd=? AND deal_date>='2023-01-01'
            LIMIT 1`,
      args: [l],
    });
    if (hit.rows.length) continue;
    survivors.push(l);
  }

  console.error(
    `[cleanup-legacy] obsoleteEmpty=${survivors.length} apply=${apply ? 1 : 0} list=${survivors.join(",")}`,
  );
  if (!apply) {
    console.log(JSON.stringify({ plan: true, lawds: survivors }, null, 2));
    return;
  }

  let deleted = 0;
  for (const l of survivors) {
    const res = await db.execute({
      sql: `DELETE FROM sync_months
            WHERE lawd_cd=? AND deal_kind='trade' AND row_count=0
              AND year_month>='202301' AND year_month<='202609'`,
      args: [l],
    });
    deleted += Number(res.rowsAffected ?? 0);
  }
  console.log(JSON.stringify({ apply: true, deleted, lawds: survivors }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * Targeted cleanup: remove empty obsolete Incheon catalog sync_months
 * (28110/28140/28260) introduced by empty-cell backfill.
 *
 *   npx tsx scripts/cleanup-incheon-obsolete.mts --apply=1
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });
config({ quiet: true });

import { createClient } from "@libsql/client";

const OBSOLETE = ["28110", "28140", "28260"] as const;

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

  const before = await db.execute({
    sql: `SELECT lawd_cd AS l, COUNT(*) AS c, SUM(row_count) AS rows
          FROM sync_months
          WHERE deal_kind='trade' AND lawd_cd IN ('28110','28140','28260')
          GROUP BY 1`,
  });
  console.error("[cleanup-icn] before", JSON.stringify(before.rows));

  if (!apply) {
    console.log(JSON.stringify({ plan: true, lawds: OBSOLETE }, null, 2));
    return;
  }

  const res = await db.execute({
    sql: `DELETE FROM sync_months
          WHERE deal_kind='trade'
            AND lawd_cd IN ('28110','28140','28260')
            AND row_count=0`,
  });
  console.log(
    JSON.stringify(
      {
        apply: true,
        rowsAffected: res.rowsAffected,
      },
      null,
      2,
    ),
  );

  const after = await db.execute({
    sql: `SELECT lawd_cd AS l, COUNT(*) AS c, SUM(row_count) AS rows
          FROM sync_months
          WHERE deal_kind='trade' AND lawd_cd IN ('28110','28140','28260')
          GROUP BY 1`,
  });
  console.error("[cleanup-icn] after", JSON.stringify(after.rows));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

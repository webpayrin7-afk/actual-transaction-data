/** Production READ-only EXPLAIN for current first_seen Home/region shapes. */
import { createClient } from "@libsql/client";

const url = process.env.TURSO_DATABASE_URL ?? "";
if (!url || url.startsWith("file:")) throw new Error("Need remote TURSO");
const db = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN ?? "" });

async function main() {
  const q1 = await db.execute(
    `EXPLAIN QUERY PLAN
     SELECT id FROM transactions
     WHERE deal_type = 'trade'
       AND first_seen_at IS NOT NULL
       AND first_seen_at != ''
       AND first_seen_at >= '2026-09-08T21:00:00.000Z'
       AND first_seen_at < '2026-09-08T21:15:00.000Z'`,
  );
  console.log("HOME_DAY_RANGE");
  for (const r of q1.rows) console.log(r);

  const q2 = await db.execute(
    `EXPLAIN QUERY PLAN
     SELECT id FROM transactions
     WHERE lawd_cd = '11680'
       AND first_seen_at IS NOT NULL
       AND first_seen_at >= '2026-09-08T00:00:00.000Z'
       AND first_seen_at < '2026-09-09T00:00:00.000Z'`,
  );
  console.log("LAWD_FIRST_SEEN_RANGE");
  for (const r of q2.rows) console.log(r);

  const q3 = await db.execute(`PRAGMA index_list(transactions)`);
  console.log("INDEX_LIST");
  for (const r of q3.rows) console.log(r);

  const q4 = await db.execute(
    `EXPLAIN QUERY PLAN
     SELECT id FROM transactions
     WHERE lawd_cd = '11680' AND year_month IN ('202609','202608') AND deal_type = 'trade'`,
  );
  console.log("TRADE_POOL");
  for (const r of q4.rows) console.log(r);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

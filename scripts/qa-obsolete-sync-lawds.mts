import { config } from "dotenv";
config({ quiet: true });
import { createClient } from "@libsql/client";
import { runnableAptTradeRequestLawds } from "../src/lib/molit/aptrade-lawd-mapping";
import { incheonTrueNodataLawds } from "../src/lib/molit/temporal-lawd";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN!,
});

async function main() {
  const runnable = new Set(runnableAptTradeRequestLawds());
  const nodata = new Set(incheonTrueNodataLawds());
  const rows = await db.execute(
    `SELECT DISTINCT lawd_cd AS l FROM sync_months WHERE deal_kind='trade' AND year_month>='202301'`,
  );
  const all = rows.rows.map((r) => String(r.l));
  const obsolete = all.filter((l) => !runnable.has(l));
  const byPrefix: Record<string, number> = {};
  for (const l of obsolete) {
    const p = l.slice(0, 2);
    byPrefix[p] = (byPrefix[p] || 0) + 1;
  }
  console.log(
    JSON.stringify(
      {
        totalDistinct: all.length,
        runnable: runnable.size,
        obsolete: obsolete.length,
        obsoleteList: obsolete.sort(),
        byPrefix,
        nodataInSync: all.filter((l) => nodata.has(l)),
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

import { config } from "dotenv";
config({ path: ".env.local" });
import { getDb, hasDb, ensureSchema } from "../src/lib/db/client";
import { rebuildAllStatsDealFeeds } from "../src/lib/market/stats-feeds";

async function main() {
  if (!hasDb()) throw new Error("DB unavailable");
  await ensureSchema();
  const db = getDb()!;
  const maxRow = await db.execute({
    sql: `SELECT MAX(deal_date) AS m FROM transactions WHERE deal_type = ?`,
    args: ["trade"],
  });
  const asOfDate = String(maxRow.rows[0]?.m ?? "");
  if (!asOfDate) throw new Error("no trade data");

  const t0 = Date.now();
  const n = await rebuildAllStatsDealFeeds(asOfDate);
  console.log(
    JSON.stringify(
      { asOfDate, feeds: n, ms: Date.now() - t0 },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

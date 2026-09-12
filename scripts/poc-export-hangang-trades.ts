/**
 * Read-only export of Hangang Daewoo trades for unit-type PoC.
 * Does not modify transactions.
 */
import { createClient } from "@libsql/client";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url) throw new Error("TURSO_DATABASE_URL missing");

  const db = createClient({ url, authToken });
  const r = await db.execute({
    sql: `SELECT id, deal_date, exclusive_area, deal_amount, dealing_gbn
          FROM transactions
          WHERE deal_type='trade' AND apt_name_norm=? AND lawd_cd=?
          ORDER BY deal_date, id`,
    args: ["한강(대우)", "11170"],
  });

  const trades = r.rows.map((row) => ({
    id: String(row.id),
    deal_date: String(row.deal_date),
    exclusive_area: Number(row.exclusive_area),
    deal_amount: Number(row.deal_amount),
    dealing_gbn: row.dealing_gbn == null ? "" : String(row.dealing_gbn),
  }));

  const out = resolve("data/poc/hangang-daewoo-trades-readonly.json");
  mkdirSync(resolve("data/poc"), { recursive: true });
  writeFileSync(out, JSON.stringify({ count: trades.length, trades }, null, 2));
  console.log(`wrote ${trades.length} trades → ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

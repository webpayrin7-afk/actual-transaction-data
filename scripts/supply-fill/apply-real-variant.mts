/**
 * Insert REAL_VARIANT representative rows. Does not update supplies or delete rows.
 * Usage: ./node_modules/.bin/tsx scripts/supply-fill/apply-real-variant.mts
 */
import { readFileSync } from "node:fs";
import { config } from "dotenv";
import { createClient, type InArgs } from "@libsql/client";

config({ path: ".env.local", quiet: true });

const PLAN = "data/poc/supply/real-variant-plan.json";
const MIGRATION = "src/lib/db/migrations/20260924_supply_representative.sql";
const RULE = "max_household_then_smaller_supply";

type Decision = {
  complexId: string;
  exclusiveCents: number;
  representativeSupplyCents: number;
  representativeHousehold: number;
  variants: Array<{ supplyCents: number; householdCount: number }>;
};

async function main() {
  const plan = JSON.parse(readFileSync(PLAN, "utf8")) as { decisions: Decision[] };
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL!.trim(),
    authToken: process.env.TURSO_AUTH_TOKEN!.trim(),
  });
  await db.executeMultiple(readFileSync(MIGRATION, "utf8"));
  const now = new Date().toISOString();
  const statements = plan.decisions.map((row) => ({
    sql: `INSERT INTO apt_unit_supply_representative (
            complex_id, exclusive_cents, representative_supply_cents, representative_household_count,
            variant_count, variants_json, rule, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(complex_id, exclusive_cents) DO NOTHING`,
    args: [
      row.complexId,
      row.exclusiveCents,
      row.representativeSupplyCents,
      row.representativeHousehold,
      row.variants.length,
      JSON.stringify(row.variants),
      RULE,
      now,
    ] as InArgs,
  }));
  let affected = 0;
  for (let i = 0; i < statements.length; i += 40) {
    const results = await db.batch(statements.slice(i, i + 40), "write");
    affected += results.reduce((n, result) => n + result.rowsAffected, 0);
  }
  const left = await db.execute(`SELECT COUNT(*) n FROM apt_unit_supply_representative`);
  console.log(JSON.stringify({ inserted: affected, stored: Number(left.rows[0]?.n), planned: plan.decisions.length }));
}

main();

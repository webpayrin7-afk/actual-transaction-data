/**
 * Production READ-only dry-run counts for discovery_at backfill.
 * No writes. Does not call ensureSchema.
 *
 *   npx tsx scripts/dry-run-discovery-migration-readonly.ts
 */
import { config } from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@libsql/client";
import { TRUSTED_DISCOVERY_COPY } from "../src/lib/db/discovery-axis";

for (const p of [".env.local", ".env"]) {
  const abs = resolve(process.cwd(), p);
  if (existsSync(abs)) config({ path: abs, override: false });
}

const url = process.env.TURSO_DATABASE_URL ?? "";
if (!url || url.startsWith("file:")) {
  throw new Error("Need remote TURSO_DATABASE_URL");
}

const db = createClient({
  url,
  authToken: process.env.TURSO_AUTH_TOKEN ?? "",
});

const CAPITAL = [
  "11110","11140","11170","11200","11215","11230","11260","11290","11305","11320",
  "11350","11380","11410","11440","11470","11500","11530","11545","11560","11590",
  "11620","11650","11680","11710","11740","41111","41113","41115","41117","41131",
  "41133","41135","41150","41171","41173","41210","41220","41250","41271","41273",
  "41281","41285","41287","41290","41310","41360","41370","41390","41410","41430",
  "41450","41461","41463","41465","41480","41500","41550","41570","41590","41610",
  "41630","41650","41670","41800","41820","41830",
];
const inList = CAPITAL.map((c) => `'${c}'`).join(",");

async function main() {
  const cols = await db.execute("PRAGMA table_info(transactions)");
  const names = cols.rows.map((r) => String(r.name));
  console.log({
    has_discovery_at: names.includes("discovery_at"),
    has_first_seen_at: names.includes("first_seen_at"),
  });

  const literal = await db.execute(`
    SELECT COUNT(*) AS n
    FROM transactions
    WHERE lawd_cd IN (${inList})
      AND first_seen_at IS NOT NULL AND first_seen_at != ''
      AND first_seen_at >= '2026-09-08T21:04:43Z'
      AND first_seen_at <  '2026-09-08T21:07:51Z'
  `);

  const padded = await db.execute(`
    SELECT COUNT(*) AS n
    FROM transactions
    WHERE lawd_cd IN (${inList})
      AND first_seen_at IS NOT NULL AND first_seen_at != ''
      AND first_seen_at >= '${TRUSTED_DISCOVERY_COPY.fromInclusive}'
      AND first_seen_at <  '${TRUSTED_DISCOVERY_COPY.toExclusive}'
  `);

  const kst09 = await db.execute(`
    SELECT COUNT(*) AS n
    FROM transactions
    WHERE lawd_cd IN (${inList})
      AND first_seen_at IS NOT NULL AND first_seen_at != ''
      AND date(first_seen_at, '+9 hours') = '2026-09-09'
  `);

  const bulk08 = await db.execute(`
    SELECT COUNT(*) AS n
    FROM transactions
    WHERE lawd_cd IN (${inList})
      AND first_seen_at IS NOT NULL AND first_seen_at != ''
      AND date(first_seen_at, '+9 hours') = '2026-09-08'
  `);

  const phaseC = await db.execute(`
    SELECT COUNT(*) AS n
    FROM transactions
    WHERE lawd_cd IN (${inList})
      AND (first_seen_at IS NULL OR first_seen_at = '')
      AND last_seen_at >= '2026-09-09T13:03:00'
      AND last_seen_at <  '2026-09-09T13:07:00'
  `);

  const low08 = await db.execute(`
    SELECT COUNT(*) AS n
    FROM transactions
    WHERE lawd_cd IN ('11260','11110','11380','41281')
      AND first_seen_at IS NOT NULL AND first_seen_at != ''
      AND date(first_seen_at, '+9 hours') = '2026-09-08'
  `);

  console.log({
    trusted_literal_43Z: Number(literal.rows[0]?.n),
    trusted_padded_ms: Number(padded.rows[0]?.n),
    trusted_kst_2026_09_09: Number(kst09.rows[0]?.n),
    bulk_kst_2026_09_08: Number(bulk08.rows[0]?.n),
    phase_c_first_seen_null: Number(phaseC.rows[0]?.n),
    low_9_8_four_lawds: Number(low08.rows[0]?.n),
    expected_trusted: TRUSTED_DISCOVERY_COPY.expectedRows,
    expected_bulk: 172623,
    expected_phase_c: 8507,
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

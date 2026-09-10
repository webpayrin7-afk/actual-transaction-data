/**
 * READ-only post-repair warehouse snapshot + discovery check.
 *   npx tsx scripts/post-repair-snapshot.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { getDb } from "../src/lib/db/client";
import { allCapitalLawdCodes, districtNameFromCode } from "../src/lib/constants/regions-registry";
import { TRUSTED_DISCOVERY_COPY } from "../src/lib/db/discovery-axis";

async function main() {
  const db = getDb();
  if (!db) throw new Error("no db");
  const capital = allCapitalLawdCodes();
  const disc = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM transactions WHERE discovery_at IS NOT NULL AND discovery_at != ''`,
    args: [],
  });
  const trusted = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM transactions WHERE discovery_at >= ? AND discovery_at < ?`,
    args: [
      TRUSTED_DISCOVERY_COPY.fromInclusive,
      TRUSTED_DISCOVERY_COPY.toExclusive,
    ],
  });
  const totals = await db.execute(
    `SELECT deal_type, COUNT(*) AS n, MIN(deal_date) AS min_d, MAX(deal_date) AS max_d
     FROM transactions GROUP BY deal_type`,
  );
  const newCodes = [
    "41192",
    "41194",
    "41196",
    "41591",
    "41593",
    "41595",
    "41597",
  ];
  const ph = newCodes.map(() => "?").join(",");
  const byNew = await db.execute({
    sql: `SELECT lawd_cd, deal_type, COUNT(*) AS n, MIN(deal_date) AS min_d, MAX(deal_date) AS max_d
          FROM transactions WHERE lawd_cd IN (${ph})
          GROUP BY lawd_cd, deal_type ORDER BY lawd_cd, deal_type`,
    args: newCodes,
  });
  const capitalPresent = await db.execute({
    sql: `SELECT COUNT(DISTINCT lawd_cd) AS n FROM transactions WHERE lawd_cd IN (${capital.map(() => "?").join(",")})`,
    args: capital,
  });
  const missing = [];
  for (const c of capital) {
    const r = await db.execute({
      sql: `SELECT COUNT(*) AS n FROM transactions WHERE lawd_cd = ?`,
      args: [c],
    });
    if ((Number(r.rows[0]?.n) || 0) === 0) missing.push({ code: c, name: districtNameFromCode(c) });
  }
  console.log(
    JSON.stringify(
      {
        discovery_nn: Number(disc.rows[0]?.n),
        trusted: Number(trusted.rows[0]?.n),
        totals: totals.rows,
        capital_codes: capital.length,
        capital_present: Number(capitalPresent.rows[0]?.n),
        missing_capital: missing,
        new_lawds: byNew.rows,
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

/** Read-only schema and REAL_VARIANT shape. Prints no credentials. */
import { config } from "dotenv";
import { createClient } from "@libsql/client";

config({ path: ".env.local", quiet: true });

const db = createClient({
  url: process.env.TURSO_DATABASE_URL!.trim(),
  authToken: process.env.TURSO_AUTH_TOKEN!.trim(),
});

const names = [
  "apt_canonical_unit_types",
  "apt_unit_supply_conflicts",
  "apt_supply_conflict_class",
  "unit_type_household_counts",
  "unit_exclusive_group_counts",
  "apt_unit_exclusive_pairs",
];
const schema = await db.execute({
  sql: `SELECT name, sql FROM sqlite_master WHERE name IN (${names.map(() => "?").join(",")})`,
  args: names,
});
for (const row of schema.rows) {
  console.log("\n==", row.name, "==\n", row.sql);
}

const classes = await db.execute(
  `SELECT class, COUNT(*) n FROM apt_supply_conflict_class GROUP BY 1 ORDER BY 2 DESC`,
);
console.log("\n== classes ==", JSON.stringify(classes.rows));

const sample = await db.execute(`
  SELECT c.conflict_id, c.complex_id, c.exclusive_cents, c.held_supply_cents, c.reason,
         substr(c.provenance_json, 1, 400) AS prov
  FROM apt_unit_supply_conflicts c
  JOIN apt_supply_conflict_class k ON k.conflict_id = c.conflict_id
  WHERE k.class = 'REAL_VARIANT'
  LIMIT 2
`);
console.log("\n== real sample ==", JSON.stringify(sample.rows, null, 1));

const deriv = await db.execute(`
  SELECT c.complex_id, c.exclusive_cents, c.held_supply_cents, c.reason, substr(c.provenance_json, 1, 500) AS prov
  FROM apt_unit_supply_conflicts c
  JOIN apt_supply_conflict_class k ON k.conflict_id = c.conflict_id
  WHERE k.class = 'DERIVATION_CONFLICT'
`);
console.log("\n== derivation ==", JSON.stringify(deriv.rows, null, 1));

const shape = await db.execute(`
  WITH rv AS (
    SELECT DISTINCT c.complex_id, c.exclusive_cents
    FROM apt_unit_supply_conflicts c
    JOIN apt_supply_conflict_class k ON k.conflict_id = c.conflict_id
    WHERE k.class = 'REAL_VARIANT'
  )
  SELECT
    (SELECT COUNT(*) FROM rv) AS exclusives,
    (SELECT COUNT(*) FROM apt_canonical_unit_types u JOIN rv ON rv.complex_id=u.complex_id AND rv.exclusive_cents=u.exclusive_cents WHERE u.supply_cents>=0) AS canonical_positive,
    (SELECT COUNT(*) FROM apt_canonical_unit_types u JOIN rv ON rv.complex_id=u.complex_id AND rv.exclusive_cents=u.exclusive_cents WHERE u.supply_cents>=0 AND u.household_count IS NOT NULL AND u.household_count>0) AS with_hh,
    (SELECT COUNT(*) FROM rv r WHERE (
      SELECT COUNT(*) FROM apt_canonical_unit_types u
      WHERE u.complex_id=r.complex_id AND u.exclusive_cents=r.exclusive_cents AND u.supply_cents>=0
    ) >= 2) AS multi_row
`);
console.log("\n== shape ==", JSON.stringify(shape.rows));

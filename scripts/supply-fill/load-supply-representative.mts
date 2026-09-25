/**
 * apt_unit_supply_representative for REAL_VARIANT exclusives.
 *
 * Review finding (phase 3): the phase-2 plan pooled the held canonical supply with the
 * incoming 2026-08 evidence supply. Those are mostly the SAME units measured by two
 * registry derivations (same household counts, ~6㎡ offset), not A/B types. Pooling
 * them would show a fake "22~24평" range. This loader only pools supplies that are
 * already canonical rows of one exclusive (one derivation). An exclusive with a single
 * canonical supply needs no representative and is reported as DEFINITION_OFFSET.
 *
 * Rule: most households wins; tie → smaller supply (pickRepresentativeSupply).
 * DERIVATION_CONFLICT exclusives are kept out. Insert only; ON CONFLICT DO NOTHING.
 *
 * Usage: ./node_modules/.bin/tsx scripts/supply-fill/load-supply-representative.mts plan|apply
 */
import { readFileSync, writeFileSync } from "node:fs";
import { config } from "dotenv";
import { createClient, type InArgs } from "@libsql/client";
import { pickRepresentativeSupply, pyeongRangeLabel } from "../../src/lib/unit-type/supply-representative";

config({ path: ".env.local", quiet: true });

const MIGRATION = "src/lib/db/migrations/20260924_supply_representative.sql";
const RULE = "max_household_then_smaller_supply";
const OUT = "data/poc/supply/representative-plan.json";

function num(v: unknown): number {
  return typeof v === "bigint" ? Number(v) : Number(v ?? 0);
}

async function main() {
  const apply = process.argv[2] === "apply";
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL!.trim(),
    authToken: process.env.TURSO_AUTH_TOKEN!.trim(),
  });
  const res = await db.execute(`
    WITH rv AS (
      SELECT DISTINCT c.complex_id, c.exclusive_cents
      FROM apt_unit_supply_conflicts c
      JOIN apt_supply_conflict_class k ON k.conflict_id = c.conflict_id
      WHERE k.class = 'REAL_VARIANT'
    ),
    dc AS (
      SELECT DISTINCT c.complex_id, c.exclusive_cents
      FROM apt_unit_supply_conflicts c
      JOIN apt_supply_conflict_class k ON k.conflict_id = c.conflict_id
      WHERE k.class = 'DERIVATION_CONFLICT'
    )
    SELECT rv.complex_id, rv.exclusive_cents, u.supply_cents, u.household_count,
           EXISTS (SELECT 1 FROM dc WHERE dc.complex_id = rv.complex_id AND dc.exclusive_cents = rv.exclusive_cents) AS in_dc
    FROM rv
    LEFT JOIN apt_canonical_unit_types u
      ON u.complex_id = rv.complex_id AND u.exclusive_cents = rv.exclusive_cents AND u.supply_cents >= 0
  `);
  const groups = new Map<string, { complexId: string; exclusiveCents: number; inDc: boolean; variants: Array<{ supplyCents: number; householdCount: number | null }> }>();
  for (const row of res.rows) {
    const key = `${row.complex_id}|${num(row.exclusive_cents)}`;
    const group = groups.get(key) ?? {
      complexId: String(row.complex_id),
      exclusiveCents: num(row.exclusive_cents),
      inDc: num(row.in_dc) > 0,
      variants: [],
    };
    if (row.supply_cents != null) {
      group.variants.push({
        supplyCents: num(row.supply_cents),
        householdCount: row.household_count == null ? null : num(row.household_count),
      });
    }
    groups.set(key, group);
  }
  const held: Record<string, number> = {};
  const decisions: Array<{
    complexId: string;
    exclusiveCents: number;
    representativeSupplyCents: number;
    representativeHouseholdCount: number;
    variants: Array<{ supplyCents: number; householdCount: number }>;
    label: string;
  }> = [];
  for (const group of groups.values()) {
    if (group.inDc) {
      held.DERIVATION_CONFLICT = (held.DERIVATION_CONFLICT ?? 0) + 1;
      continue;
    }
    const distinct = new Set(group.variants.map((v) => v.supplyCents));
    if (distinct.size < 2) {
      held.DEFINITION_OFFSET = (held.DEFINITION_OFFSET ?? 0) + 1;
      continue;
    }
    const pick = pickRepresentativeSupply(group.variants);
    if (!pick) {
      held.NO_HOUSEHOLD = (held.NO_HOUSEHOLD ?? 0) + 1;
      continue;
    }
    decisions.push({
      complexId: group.complexId,
      exclusiveCents: group.exclusiveCents,
      ...pick,
      label: pyeongRangeLabel(pick.variants.map((v) => v.supplyCents)),
    });
  }
  const summary = {
    realVariantExclusives: groups.size,
    decided: decisions.length,
    complexes: new Set(decisions.map((d) => d.complexId)).size,
    withRangeLabel: decisions.filter((d) => d.label.includes("~")).length,
    complexesWithRangeLabel: new Set(decisions.filter((d) => d.label.includes("~")).map((d) => d.complexId)).size,
    held,
  };
  if (!apply) {
    writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), summary, sample: decisions.slice(0, 20), decisions }, null, 1));
    console.log(JSON.stringify({ apply: false, ...summary }));
    return;
  }
  await db.executeMultiple(readFileSync(MIGRATION, "utf8"));
  const now = new Date().toISOString();
  const statements = decisions.map((row) => ({
    sql: `INSERT INTO apt_unit_supply_representative (
            complex_id, exclusive_cents, representative_supply_cents, representative_household_count,
            variant_count, variants_json, rule, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(complex_id, exclusive_cents) DO NOTHING`,
    args: [
      row.complexId,
      row.exclusiveCents,
      row.representativeSupplyCents,
      row.representativeHouseholdCount,
      row.variants.length,
      JSON.stringify(row.variants),
      RULE,
      now,
    ] as InArgs,
  }));
  let inserted = 0;
  for (let i = 0; i < statements.length; i += 100) {
    const results = await db.batch(statements.slice(i, i + 100), "write");
    inserted += results.reduce((n, r) => n + r.rowsAffected, 0);
  }
  const stored = await db.execute(`SELECT COUNT(*) n, COUNT(DISTINCT complex_id) c FROM apt_unit_supply_representative`);
  console.log(JSON.stringify({ apply: true, inserted, stored: num(stored.rows[0]?.n), storedComplexes: num(stored.rows[0]?.c), ...summary }));
}

main();

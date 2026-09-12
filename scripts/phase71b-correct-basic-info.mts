#!/usr/bin/env npx tsx
/**
 * Phase 7.1b — corrective writes for incorrect BASIC_INFO READY states.
 * Only complexes without KAPT source link / actual basic-info source.
 * Default dry-run. Pass --apply to write.
 */
import { createClient } from "@libsql/client";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const APPLY = process.argv.includes("--apply");
const OUT = join(process.cwd(), "data/poc/phase71b");
mkdirSync(OUT, { recursive: true });

async function main() {
  const cohort = JSON.parse(
    readFileSync("data/poc/phase71/sample-cohort.json", "utf8"),
  ) as { complexes: Array<{ complex_id: string; apt_name: string }> };
  const ids = cohort.complexes.map((c) => c.complex_id);
  const ph = ids.map(() => "?").join(",");
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });

  const links = await db.execute({
    sql: `SELECT complex_id FROM apt_complex_source_links
          WHERE source='KAPT' AND complex_id IN (${ph})`,
    args: ids,
  });
  const hasKapt = new Set(links.rows.map((r) => String(r.complex_id)));

  const ready = await db.execute({
    sql: `SELECT e.complex_id, m.apt_name, e.status, e.reason_code
          FROM apt_complex_enrichment_state e
          JOIN apt_complex_master m ON m.complex_id=e.complex_id
          WHERE e.domain='BASIC_INFO' AND e.status='READY'
            AND e.complex_id IN (${ph})`,
    args: ids,
  });

  const targets = ready.rows.filter((r) => !hasKapt.has(String(r.complex_id)));
  const ts = new Date().toISOString();
  const plan = {
    mode: APPLY ? "APPLY" : "DRY-RUN",
    expected_updates: targets.length,
    targets: targets.map((r) => ({
      complex_id: r.complex_id,
      apt_name: r.apt_name,
      from: { status: r.status, reason_code: r.reason_code },
      to: { status: "PENDING", reason_code: "BASIC_SOURCE_MISSING" },
    })),
  };

  if (APPLY) {
    for (const t of targets) {
      await db.execute({
        sql: `UPDATE apt_complex_enrichment_state
              SET status='PENDING',
                  reason_code='BASIC_SOURCE_MISSING',
                  updated_at=?
              WHERE complex_id=? AND domain='BASIC_INFO' AND status='READY'`,
        args: [ts, t.complex_id],
      });
    }
  }

  writeFileSync(join(OUT, "corrective-basic-info.json"), JSON.stringify(plan, null, 2));
  console.log(JSON.stringify(plan, null, 2));
  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

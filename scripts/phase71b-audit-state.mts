#!/usr/bin/env npx tsx
/**
 * Phase 7.1b — read-only audit of enrichment READY semantics for sample cohort.
 */
import { createClient } from "@libsql/client";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const OUT = join(process.cwd(), "data/poc/phase71b");
mkdirSync(OUT, { recursive: true });

async function main() {
  const cohort = JSON.parse(
    readFileSync("data/poc/phase71/sample-cohort.json", "utf8"),
  ) as {
    complexes: Array<{
      complex_id: string;
      apt_name: string;
      kapt_code: string | null;
    }>;
  };
  const ids = cohort.complexes.map((c) => c.complex_id);
  const ph = ids.map(() => "?").join(",");
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });

  const enrich = await db.execute({
    sql: `SELECT e.complex_id, m.apt_name, e.domain, e.status, e.reason_code,
                 e.data_version, e.processed_at
          FROM apt_complex_enrichment_state e
          JOIN apt_complex_master m ON m.complex_id=e.complex_id
          WHERE e.complex_id IN (${ph})
          ORDER BY m.apt_name, e.domain`,
    args: ids,
  });
  const links = await db.execute({
    sql: `SELECT l.complex_id, m.apt_name, l.source, l.source_key, l.source_version
          FROM apt_complex_source_links l
          JOIN apt_complex_master m ON m.complex_id=l.complex_id
          WHERE l.complex_id IN (${ph})
          ORDER BY m.apt_name, l.source`,
    args: ids,
  });
  const profiles = await db.execute({
    sql: `SELECT p.complex_id, m.apt_name, p.source, p.source_version,
                 p.household_count, p.building_count, p.heating_type,
                 p.management_type, p.approval_date, p.max_floor
          FROM apt_complex_profile p
          JOIN apt_complex_master m ON m.complex_id=p.complex_id
          WHERE p.complex_id IN (${ph})`,
    args: ids,
  });
  const fees = await db.execute({
    sql: `SELECT complex_id, COUNT(*) n
          FROM apt_complex_mgmt_fee_monthly
          WHERE complex_id IN (${ph})
          GROUP BY complex_id`,
    args: ids,
  });
  const counts = await db.execute({
    sql: `SELECT domain, status, COUNT(*) n
          FROM apt_complex_enrichment_state
          WHERE complex_id IN (${ph})
          GROUP BY domain, status
          ORDER BY domain, status`,
    args: ids,
  });

  const kaptByComplex = new Map<string, boolean>();
  for (const row of links.rows) {
    if (String(row.source) === "KAPT") kaptByComplex.set(String(row.complex_id), true);
  }
  const feeByComplex = new Set(fees.rows.map((r) => String(r.complex_id)));

  const incorrect: Array<Record<string, unknown>> = [];
  for (const row of enrich.rows) {
    const cid = String(row.complex_id);
    const domain = String(row.domain);
    const status = String(row.status);
    if (domain === "BASIC_INFO" && status === "READY") {
      // READY only when actual KAPT/basic source data was available and persisted.
      const hasKaptLink = kaptByComplex.has(cid);
      const cohortKapt = cohort.complexes.find((c) => c.complex_id === cid)?.kapt_code;
      if (!hasKaptLink) {
        incorrect.push({
          complex_id: cid,
          apt_name: row.apt_name,
          domain,
          status,
          issue:
            "BASIC_INFO marked READY without KAPT source link / actual basic-info source",
          corrective: "set status=PENDING, reason_code=BASIC_SOURCE_MISSING",
          cohort_kapt_code: cohortKapt,
        });
      }
    }
    if (domain === "MANAGEMENT_FEE" && status === "READY" && !feeByComplex.has(cid)) {
      incorrect.push({
        complex_id: cid,
        apt_name: row.apt_name,
        domain,
        status,
        issue: "MANAGEMENT_FEE READY with zero fee months",
        corrective: "set status=PENDING, reason_code=FEE_MONTHS_EMPTY",
      });
    }
  }

  // Also flag cohort members missing MANAGEMENT_FEE row entirely (expected)
  const domainsPresent = new Set(
    enrich.rows.map((r) => `${r.complex_id}|${r.domain}`),
  );
  for (const c of cohort.complexes) {
    if (!domainsPresent.has(`${c.complex_id}|MANAGEMENT_FEE`)) {
      // not incorrect — lazy row may be absent
    }
  }

  const report = {
    phase: "7.1b-audit",
    cohort_size: ids.length,
    counts: counts.rows,
    incorrect_count: incorrect.length,
    incorrect,
    enrich: enrich.rows,
    links: links.rows,
    profiles: profiles.rows,
    fees: fees.rows,
  };
  writeFileSync(join(OUT, "state-audit.json"), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      {
        counts: counts.rows,
        incorrect_count: incorrect.length,
        incorrect: incorrect.map((i) => ({
          apt_name: i.apt_name,
          domain: i.domain,
          issue: i.issue,
          corrective: i.corrective,
        })),
      },
      null,
      2,
    ),
  );
  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

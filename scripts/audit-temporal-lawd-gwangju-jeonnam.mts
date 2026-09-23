/**
 * Dry-run audit: Gwangju/Jeonnam canonical↔historical crosswalk coverage.
 *   npx tsx scripts/audit-temporal-lawd-gwangju-jeonnam.mts
 */
import { createClient } from "@libsql/client";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  canonicalLawdFromHistoricalAdmin,
  gwangjuJeonnamAptTradeRequestLawds,
  gwangjuJeonnamMappingCoverage,
  historicalAdminLawdFromCanonical,
  temporalCrosswalkDoc,
} from "../src/lib/molit/temporal-lawd";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN!,
});

async function main() {
  const cov = gwangjuJeonnamMappingCoverage();
  const doc = temporalCrosswalkDoc();
  const master = await db.execute(
    `SELECT lawd_cd, sigungu, COUNT(*) AS n
     FROM apt_complex_master WHERE sido = '전남광주통합특별시'
     GROUP BY 1, 2`,
  );

  let exact = 0;
  let ambiguous = 0;
  let unmapped = 0;
  const rows = [];
  for (const r of master.rows) {
    const canonical = String(r.lawd_cd);
    const hist = historicalAdminLawdFromCanonical(canonical);
    const back = hist ? canonicalLawdFromHistoricalAdmin(hist) : null;
    let status: "exact" | "ambiguous" | "unmapped" = "unmapped";
    if (hist && back === canonical) {
      status = "exact";
      exact += Number(r.n);
    } else if (hist && back !== canonical) {
      status = "ambiguous";
      ambiguous += Number(r.n);
    } else {
      unmapped += Number(r.n);
    }
    rows.push({
      canonical_lawd: canonical,
      sigungu: String(r.sigungu),
      complexes: Number(r.n),
      historical_lawd: hist,
      roundtrip: back,
      status,
    });
  }

  const out = {
    dryRun: true,
    apiCalls: 0,
    effectiveDate: doc.effective_date,
    officialCoverage: cov,
    masterComplexes: rows.reduce((s, r) => s + r.complexes, 0),
    masterExactComplexes: exact,
    masterAmbiguousComplexes: ambiguous,
    masterUnmappedComplexes: unmapped,
    masterLawdRows: rows,
    requestLawds: gwangjuJeonnamAptTradeRequestLawds(),
    applyGate:
      cov.ambiguous === 0 &&
      cov.unmapped === 0 &&
      unmapped === 0 &&
      ambiguous === 0
        ? "PASS"
        : "HOLD",
  };

  const path = resolve("data/poc/temporal-lawd/gwangju-jeonnam-audit.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(out, null, 2) + "\n");
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

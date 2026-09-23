/**
 * Closeout QA: coverage slice + idempotency probe (no bulk).
 *   npx tsx scripts/qa-temporal-lawd-closeout.mts
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });
config({ quiet: true });

import { createClient } from "@libsql/client";
import { metroFromLawdNationwide } from "../src/lib/constants/nationwide-lawd";
import { replaceMonthTransactions } from "../src/lib/db/repository";
import { fetchOneTradeForSync } from "../src/lib/molit/client";
import {
  classifyIncheonNodataCode,
  gwangjuJeonnamAptTradeRequestLawds,
  incheonAptTradeBackfillLawds,
  incheonTrueNodataLawds,
} from "../src/lib/molit/temporal-lawd";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN!,
});

async function q(sql: string, args: Array<string | number> = []) {
  return (await db.execute({ sql, args })).rows as Array<
    Record<string, unknown>
  >;
}

async function cov(lawds: string[]) {
  if (!lawds.length) return { lawds: 0, covered: 0, cells: 0 };
  const cells = await q(
    `SELECT lawd_cd AS l, COUNT(*) AS c FROM sync_months
     WHERE deal_kind='trade' AND year_month>='202301' AND year_month<='202609'
       AND lawd_cd IN (${lawds.map(() => "?").join(",")})
     GROUP BY 1`,
    lawds,
  );
  const map = Object.fromEntries(
    cells.map((r) => [String(r.l), Number(r.c)]),
  );
  return {
    lawds: lawds.length,
    covered: lawds.filter((l) => map[l]).length,
    cells: lawds.reduce((s, l) => s + (map[l] || 0), 0),
  };
}

async function main() {
  process.env.MOLIT_SYNCING = "1";
  const masterBefore = Number(
    (await q(`SELECT COUNT(*) AS n FROM apt_complex_master`))[0]!.n,
  );
  const allGj = gwangjuJeonnamAptTradeRequestLawds();
  const gw = allGj.filter((c) => metroFromLawdNationwide(c) === "gwangju");
  const jn = allGj.filter((c) => metroFromLawdNationwide(c) === "jeonnam");
  const icn = incheonAptTradeBackfillLawds();

  const cx = await q(
    `SELECT lawd_cd AS l, COUNT(*) AS n FROM apt_complex_master
     WHERE lawd_cd IN (${[...gw, ...jn].map(() => "?").join(",")})
     GROUP BY 1`,
    [...gw, ...jn],
  );
  const cxMap = Object.fromEntries(
    cx.map((r) => [String(r.l), Number(r.n)]),
  );

  // Idempotency: re-fetch 2 representative completed cells
  const probes = [
    { lawdCd: "12210", yearMonth: "202405" },
    { lawdCd: "12110", yearMonth: "202301" },
  ];
  const idem: Array<Record<string, unknown>> = [];
  for (const p of probes) {
    const items = await fetchOneTradeForSync(p.lawdCd, p.yearMonth);
    const result = await replaceMonthTransactions({
      lawdCd: p.lawdCd,
      yearMonth: p.yearMonth,
      dealKind: "trade",
      items,
      setFirstSeenOnInsert: false,
      dryRun: false,
      skipDelete: true,
    });
    idem.push({
      ...p,
      rows: items.length,
      inserted: result.inserted,
      updated: result.updated,
      unchanged: result.unchanged,
      deleted: result.deleted,
    });
  }

  const masterAfter = Number(
    (await q(`SELECT COUNT(*) AS n FROM apt_complex_master`))[0]!.n,
  );

  const out = {
    masterComplexes: { before: masterBefore, after: masterAfter, delta: masterAfter - masterBefore },
    gwangju: {
      ...(await cov(gw)),
      complexes: gw.reduce((s, l) => s + (cxMap[l] || 0), 0),
      currentCodes: gw,
    },
    jeonnam: {
      ...(await cov(jn)),
      complexes: jn.reduce((s, l) => s + (cxMap[l] || 0), 0),
      currentCodes: jn,
    },
    incheonBackfill: await cov(icn),
    incheonClassifications: ["28110", "28140", "28260", "28720"].map(
      classifyIncheonNodataCode,
    ),
    trueNodata: incheonTrueNodataLawds(),
    idempotency: idem,
  };
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

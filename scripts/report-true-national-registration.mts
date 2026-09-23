/**
 * Post-expansion coverage report (read-only).
 *   npx tsx scripts/report-true-national-registration.mts
 */
import { createClient } from "@libsql/client";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  METRO_LABELS,
  NATIONWIDE_LAWD_ROWS,
  metroFromLawdNationwide,
  type NationwideMetro,
} from "../src/lib/constants/nationwide-lawd";
import {
  aptTradeMappingStatus,
  isAptTradeMappingHoldLawd,
  runnableAptTradeRequestLawds,
  toAptTradeRequestLawds,
} from "../src/lib/molit/aptrade-lawd-mapping";
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

const REPORT_METROS: NationwideMetro[] = [
  "seoul",
  "gyeonggi",
  "incheon",
  "busan",
  "daegu",
  "daejeon",
  "gwangju",
  "ulsan",
  "sejong",
  "gangwon",
  "chungbuk",
  "chungnam",
  "jeonbuk",
  "jeonnam",
  "gyeongbuk",
  "gyeongnam",
  "jeju",
];

const MASTER_SIDO_TO_METRO: Record<string, NationwideMetro | "merged"> = {
  서울특별시: "seoul",
  경기도: "gyeonggi",
  인천광역시: "incheon",
  부산광역시: "busan",
  대구광역시: "daegu",
  대전광역시: "daejeon",
  전남광주통합특별시: "merged",
  광주광역시: "gwangju",
  울산광역시: "ulsan",
  세종특별자치시: "sejong",
  강원특별자치도: "gangwon",
  충청북도: "chungbuk",
  충청남도: "chungnam",
  전북특별자치도: "jeonbuk",
  전라남도: "jeonnam",
  경상북도: "gyeongbuk",
  경상남도: "gyeongnam",
  제주특별자치도: "jeju",
};

function pct(n: number, d: number): number {
  if (!d) return 0;
  return Math.round((n / d) * 1000) / 10;
}

async function q(sql: string, args: Array<string | number> = []) {
  const r = await db.execute({ sql, args });
  return r.rows as Array<Record<string, unknown>>;
}

async function main() {
  const mapping = aptTradeMappingStatus();
  const catalog = NATIONWIDE_LAWD_ROWS.map((r) => r.code);
  // A: current/canonical geography (catalog codes as stored; 29/46 still cataloged)
  const canonicalGeography = new Set(catalog);
  // B: historically / currently requestable AptTrade geography (temporal + prefix remap)
  const expectedLawds = new Set(runnableAptTradeRequestLawds());
  const holdLawds = mapping.holdLawds;
  const nationalExpectedWithHold = new Set([
    ...expectedLawds,
    ...holdLawds,
  ]);

  const masterSido = await q(
    `SELECT sido, COUNT(*) AS complexes FROM apt_complex_master GROUP BY 1`,
  );
  const masterByMetro = new Map<string, number>();
  for (const r of masterSido) {
    const m = MASTER_SIDO_TO_METRO[String(r.sido)];
    if (m === "merged") continue;
    if (m) masterByMetro.set(m, (masterByMetro.get(m) ?? 0) + Number(r.complexes ?? 0));
  }
  // Split 전남광주통합특별시 by canonical lawd (12xxx) via metroFromLawdNationwide
  const mergedByLawd = await q(
    `SELECT lawd_cd AS lawd, COUNT(*) AS complexes
     FROM apt_complex_master
     WHERE sido = '전남광주통합특별시'
     GROUP BY 1`,
  );
  let gwangjuCx = masterByMetro.get("gwangju") ?? 0;
  let jeonnamCx = masterByMetro.get("jeonnam") ?? 0;
  for (const r of mergedByLawd) {
    const lawd = String(r.lawd);
    const n = Number(r.complexes ?? 0);
    const metro = metroFromLawdNationwide(lawd);
    if (metro === "gwangju") gwangjuCx += n;
    else if (metro === "jeonnam") jeonnamCx += n;
  }
  masterByMetro.set("gwangju", gwangjuCx);
  masterByMetro.set("jeonnam", jeonnamCx);

  const syncCells = await q(
    `SELECT lawd_cd AS lawd, year_month AS ym, row_count
     FROM sync_months
     WHERE deal_kind='trade' AND year_month>='202301' AND year_month<='202609'`,
  );
  const syncLawds = new Set(syncCells.map((r) => String(r.lawd)));
  const cellsByLawd = new Map<string, number>();
  for (const r of syncCells) {
    const l = String(r.lawd);
    cellsByLawd.set(l, (cellsByLawd.get(l) ?? 0) + 1);
  }

  const txByLawd = await q(
    `SELECT lawd_cd AS lawd, COUNT(*) AS rows,
            SUM(CASE WHEN rgst_date IS NOT NULL AND trim(rgst_date)!='' THEN 1 ELSE 0 END) AS filled
     FROM transactions
     WHERE deal_type='trade' AND deal_date>='2023-01-01'
     GROUP BY 1`,
  );
  const txMap = new Map(
    txByLawd.map((r) => [
      String(r.lawd),
      { rows: Number(r.rows ?? 0), filled: Number(r.filled ?? 0) },
    ]),
  );

  const byYear = await q(
    `SELECT substr(deal_date,1,4) AS y, COUNT(*) AS rows,
            SUM(CASE WHEN rgst_date IS NOT NULL AND trim(rgst_date)!='' THEN 1 ELSE 0 END) AS filled
     FROM transactions
     WHERE deal_type='trade' AND deal_date>='2023-01-01'
     GROUP BY 1 ORDER BY 1`,
  );

  const warehouseRows = [...txMap.values()].reduce((s, v) => s + v.rows, 0);
  const warehouseFilled = [...txMap.values()].reduce((s, v) => s + v.filled, 0);

  // include sync extras in expected for geographic B (request geography)
  for (const l of syncLawds) {
    expectedLawds.add(l);
    nationalExpectedWithHold.add(l);
  }

  const held = holdLawds;
  const trueNodata = new Set(incheonTrueNodataLawds());
  const missingRunnable = [...expectedLawds].filter((c) => !syncLawds.has(c));
  const missingHeld = held.filter((c) => !syncLawds.has(c));
  // Persistent MOLIT NODATA (probe-backed TRUE_NODATA only — not obsolete catalog codes)
  const persistentNodataLawds = missingRunnable.filter((c) => trueNodata.has(c));
  const missingRunnableNonNodata = missingRunnable.filter(
    (c) => !persistentNodataLawds.includes(c),
  );

  const byRegion: Record<string, unknown> = {};
  for (const metro of REPORT_METROS) {
    const catalogTargets = catalog
      .filter((c) => metroFromLawdNationwide(c) === metro)
      .flatMap((c) =>
        isAptTradeMappingHoldLawd(c) ? [c] : toAptTradeRequestLawds(c),
      );
    const syncInMetro = [...syncLawds].filter(
      (c) => metroFromLawdNationwide(c) === metro,
    );
    const targets = [...new Set([...catalogTargets, ...syncInMetro])];
    let cells = 0;
    let rows = 0;
    let filled = 0;
    for (const c of syncInMetro) {
      cells += cellsByLawd.get(c) ?? 0;
      const t = txMap.get(c);
      rows += t?.rows ?? 0;
      filled += t?.filled ?? 0;
    }
    byRegion[METRO_LABELS[metro]] = {
      canonicalComplexes: masterByMetro.get(metro) ?? 0,
      targetLawds: targets.length,
      coveredLawds: syncInMetro.length,
      cells,
      transactionRows: rows,
      rgstPopulated: filled,
      rgstUnresolved: rows - filled,
      coveragePct: pct(filled, rows),
      mappingHold: false,
    };
  }

  const gwReq = gwangjuJeonnamAptTradeRequestLawds().filter(
    (c) => metroFromLawdNationwide(c) === "gwangju",
  );
  const jnReq = gwangjuJeonnamAptTradeRequestLawds().filter(
    (c) => metroFromLawdNationwide(c) === "jeonnam",
  );
  const icnClass = ["28110", "28140", "28260", "28720"].map((c) =>
    classifyIncheonNodataCode(c),
  );

  const lag = await q(
    `SELECT
       CAST((julianday(rgst_date) - julianday(deal_date)) AS INTEGER) AS lag_days
     FROM transactions
     WHERE deal_type='trade'
       AND deal_date >= '2023-01-01'
       AND rgst_date IS NOT NULL AND trim(rgst_date) != ''
       AND lawd_cd = '11710'
     ORDER BY lag_days`,
  );
  const lags = lag.map((r) => Number(r.lag_days)).filter((n) => Number.isFinite(n) && n >= 0);
  function pctile(arr: number[], p: number) {
    if (!arr.length) return null;
    const i = Math.min(arr.length - 1, Math.floor((arr.length - 1) * p));
    return arr[i];
  }

  const pre2023 = Number(
    (
      await q(
        `SELECT COUNT(*) AS n FROM transactions
         WHERE deal_type='trade' AND deal_date < '2023-01-01'
           AND rgst_date IS NOT NULL AND trim(rgst_date) != ''`,
      )
    )[0]?.n ?? 0,
  );

  const invalid = Number(
    (
      await q(
        `SELECT COUNT(*) AS n FROM transactions
         WHERE deal_type='trade'
           AND rgst_date IS NOT NULL AND trim(rgst_date) != ''
           AND rgst_date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`,
      )
    )[0]?.n ?? 0,
  );

  const coveredDataBearing = [...syncLawds].filter((c) => {
    const t = txMap.get(c);
    return (t?.rows ?? 0) > 0 || (cellsByLawd.get(c) ?? 0) > 0;
  });

  const out = {
    mapping,
    DENOMINATORS: {
      A_EXPECTED_CURRENT_CANONICAL_GEOGRAPHY: {
        count: canonicalGeography.size,
        note: "Nationwide catalog codes (may still list pre-change 29/46/28110…)",
      },
      B_HISTORICALLY_REQUESTABLE_APTTRADE_GEOGRAPHY: {
        count: expectedLawds.size,
        note: "Temporal + prefix remapped MOLIT request lawds (12xxx, 51/52, Incheon successors)",
        gwangjuRequestLawds: gwReq.length,
        jeonnamRequestLawds: jnReq.length,
        incheonBackfillLawds: incheonAptTradeBackfillLawds(),
      },
      C_ACTUAL_DATA_BEARING_COVERED_GEOGRAPHY: {
        coveredSyncLawds: syncLawds.size,
        dataBearingLawds: coveredDataBearing.length,
        unresolvedRequestLawds: missingRunnableNonNodata,
        documentedNodata: [
          ...new Set([
            ...persistentNodataLawds,
            ...incheonTrueNodataLawds().filter(
              (c) => !syncLawds.has(c) || (txMap.get(c)?.rows ?? 0) === 0,
            ),
          ]),
        ],
      },
    },
    GEOGRAPHIC_COVERAGE: {
      expectedRunnableLawds: expectedLawds.size,
      nationalExpectedWithHold: nationalExpectedWithHold.size,
      coveredLawds: syncLawds.size,
      missingRunnable: missingRunnable.length,
      missingRunnableNonNodata: missingRunnableNonNodata.length,
      persistentNodataLawds,
      missingHeld: missingHeld.length,
      geographicCoveragePctVsRunnable: pct(syncLawds.size, expectedLawds.size),
      geographicCoveragePctVsNationalWithHold: pct(
        syncLawds.size,
        nationalExpectedWithHold.size,
      ),
      cells2023to202609: syncCells.length,
    },
    TEMPORAL_CROSSWALK: {
      effectiveDate: mapping.temporalEffectiveDate,
      gwangju: {
        requestLawds: gwReq,
        covered: gwReq.filter((c) => syncLawds.has(c)).length,
      },
      jeonnam: {
        requestLawds: jnReq,
        covered: jnReq.filter((c) => syncLawds.has(c)).length,
      },
      incheonNodataClassification: icnClass,
    },
    WAREHOUSE_REGISTRATION: {
      rows: warehouseRows,
      rgstPopulated: warehouseFilled,
      unresolved: warehouseRows - warehouseFilled,
      coveragePct: pct(warehouseFilled, warehouseRows),
    },
    BY_REGION: byRegion,
    YEAR: Object.fromEntries(
      byYear.map((r) => [
        String(r.y),
        {
          rows: Number(r.rows),
          filled: Number(r.filled),
          unresolved: Number(r.rows) - Number(r.filled),
          pct: pct(Number(r.filled), Number(r.rows)),
        },
      ]),
    ),
    REGISTRATION_LAG_SONGPA: {
      n: lags.length,
      median: pctile(lags, 0.5),
      p75: pctile(lags, 0.75),
      p90: pctile(lags, 0.9),
      p95: pctile(lags, 0.95),
    },
    SAFETY: {
      pre2023RgstPopulated: pre2023,
      invalidRgstDates: invalid,
    },
    VERDICT: (() => {
      const documentedNodata = incheonTrueNodataLawds().filter(
        (c) => !syncLawds.has(c) || (txMap.get(c)?.rows ?? 0) === 0,
      );
      if (
        missingRunnableNonNodata.length === 0 &&
        missingHeld.length === 0 &&
        documentedNodata.length > 0
      ) {
        return "TRUE_NATIONAL_WITH_DOCUMENTED_NODATA";
      }
      if (missingRunnableNonNodata.length === 0 && missingHeld.length > 0) {
        return "TRUE_NATIONAL_PARTIAL";
      }
      if (missingRunnableNonNodata.length === 0 && missingHeld.length === 0) {
        return "TRUE_NATIONAL_COMPLETE";
      }
      return "TARGETED_RETRY";
    })(),
  };

  const path = resolve("data/poc/true-national-registration-final.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(out, null, 2) + "\n");
  console.log(JSON.stringify(out, null, 2));
  console.error(`wrote ${path}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

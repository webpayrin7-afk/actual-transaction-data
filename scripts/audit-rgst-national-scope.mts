/**
 * READ ONLY: reconcile registration "national" warehouse coverage vs true geography.
 * MOLIT API = 0. DB writes = 0.
 *
 *   npx tsx scripts/audit-rgst-national-scope.mts
 */
import { createClient } from "@libsql/client";
import {
  METRO_LABELS,
  NATIONWIDE_LAWD_ROWS,
  metroFromLawdNationwide,
  type NationwideMetro,
} from "../src/lib/constants/nationwide-lawd";
import { allCapitalLawdCodes } from "../src/lib/constants/regions-registry";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

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

/** Master sido → report metro. 전남광주통합특별시 is DB naming for merged Gwangju+Jeonnam. */
const MASTER_SIDO_TO_METRO: Record<string, NationwideMetro | "gwangju_jeonnam_merged"> = {
  서울특별시: "seoul",
  경기도: "gyeonggi",
  인천광역시: "incheon",
  부산광역시: "busan",
  대구광역시: "daegu",
  대전광역시: "daejeon",
  전남광주통합특별시: "gwangju_jeonnam_merged",
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

const MONTHS_SCOPE = 45; // 202301..202609 inclusive calendar span in warehouse

function pct(n: number, d: number): number {
  if (!d) return 0;
  return Math.round((n / d) * 1000) / 10;
}

async function q(sql: string, args: Array<string | number> = []) {
  const r = await db.execute({ sql, args });
  return r.rows as Array<Record<string, unknown>>;
}

async function main() {
  const catalogLawds = NATIONWIDE_LAWD_ROWS.map((r) => r.code);
  const catalogSet = new Set(catalogLawds);
  const catalogByMetro = new Map<NationwideMetro, string[]>();
  for (const row of NATIONWIDE_LAWD_ROWS) {
    const m = metroFromLawdNationwide(row.code);
    const list = catalogByMetro.get(m) ?? [];
    list.push(row.code);
    catalogByMetro.set(m, list);
  }

  const masterSido = await q(
    `SELECT sido, COUNT(*) AS complexes,
            COUNT(DISTINCT CASE WHEN lawd_cd IS NOT NULL AND trim(lawd_cd) != '' THEN lawd_cd END) AS lawds
     FROM apt_complex_master
     GROUP BY 1 ORDER BY complexes DESC`,
  );
  const masterTotal = Number(
    (await q(`SELECT COUNT(*) AS n FROM apt_complex_master`))[0]?.n ?? 0,
  );

  // Master lawds for Gwangju/Jeonnam use non-MOLIT 12xxx prefixes — capture evidence.
  const gwangjuJeonnamMasterLawds = await q(
    `SELECT DISTINCT lawd_cd AS lawd, COUNT(*) AS n
     FROM apt_complex_master
     WHERE sido = '전남광주통합특별시'
       AND lawd_cd IS NOT NULL AND trim(lawd_cd) != ''
     GROUP BY 1`,
  );
  const mergedMasterLawdPrefixes = [
    ...new Set(
      gwangjuJeonnamMasterLawds.map((r) => String(r.lawd).trim().slice(0, 2)),
    ),
  ];

  const syncCells = await q(
    `SELECT lawd_cd AS lawd, year_month AS ym, row_count
     FROM sync_months
     WHERE deal_kind = 'trade' AND year_month >= '202301' AND year_month <= '202609'`,
  );
  const syncLawdSet = new Set(syncCells.map((r) => String(r.lawd)));
  const syncYmSet = new Set(syncCells.map((r) => String(r.ym)));
  const cellsByLawd = new Map<string, number>();
  const rowCountSumByLawd = new Map<string, number>();
  for (const r of syncCells) {
    const lawd = String(r.lawd);
    cellsByLawd.set(lawd, (cellsByLawd.get(lawd) ?? 0) + 1);
    rowCountSumByLawd.set(
      lawd,
      (rowCountSumByLawd.get(lawd) ?? 0) + Number(r.row_count ?? 0),
    );
  }

  const txByLawd = await q(
    `SELECT lawd_cd AS lawd,
            COUNT(*) AS rows,
            SUM(CASE WHEN rgst_date IS NOT NULL AND trim(rgst_date) != '' THEN 1 ELSE 0 END) AS filled
     FROM transactions
     WHERE deal_type = 'trade' AND deal_date >= '2023-01-01'
     GROUP BY 1`,
  );
  const txLawdMap = new Map(
    txByLawd.map((r) => [
      String(r.lawd),
      {
        rows: Number(r.rows ?? 0),
        filled: Number(r.filled ?? 0),
      },
    ]),
  );

  const warehouseRows = [...txLawdMap.values()].reduce((s, v) => s + v.rows, 0);
  const warehouseFilled = [...txLawdMap.values()].reduce(
    (s, v) => s + v.filled,
    0,
  );

  // AptTrade target universe = nationwide MOLIT catalog (254).
  // Do NOT require master∩catalog: master Gwangju/Jeonnam uses 12xxx, not MOLIT 29/46.
  const expectedTradeLawds = new Set<string>(catalogLawds);
  // Include sync-backed extras already in warehouse (e.g. gyeonggi 41190/41590).
  for (const c of syncLawdSet) expectedTradeLawds.add(c);

  const coveredLawds = [...syncLawdSet];
  const missingCatalogLawds = catalogLawds.filter((c) => !syncLawdSet.has(c));
  const missingLawds = [...expectedTradeLawds].filter((c) => !syncLawdSet.has(c));

  type RegionRow = {
    metro: string;
    label: string;
    canonicalComplexes: number;
    expectedTradeLawds: number;
    syncLawds: number;
    missingLawds: number;
    syncCells2023plus: number;
    txRows2023plus: number;
    rgstFilled: number;
    warehouseCoveragePct: number;
    incompleteCause: string[];
    notes?: string;
  };

  const masterComplexByMetro = new Map<string, number>();
  const masterLawdCountByMetro = new Map<string, number>();
  let mergedGwangjuJeonnamComplexes = 0;
  let mergedGwangjuJeonnamMasterLawds = 0;
  for (const r of masterSido) {
    const sido = String(r.sido ?? "");
    const metro = MASTER_SIDO_TO_METRO[sido];
    if (metro === "gwangju_jeonnam_merged") {
      mergedGwangjuJeonnamComplexes += Number(r.complexes ?? 0);
      mergedGwangjuJeonnamMasterLawds += Number(r.lawds ?? 0);
      continue;
    }
    if (!metro) continue;
    masterComplexByMetro.set(
      metro,
      (masterComplexByMetro.get(metro) ?? 0) + Number(r.complexes ?? 0),
    );
    masterLawdCountByMetro.set(
      metro,
      (masterLawdCountByMetro.get(metro) ?? 0) + Number(r.lawds ?? 0),
    );
  }
  // Attribute merged DB sido to Gwangju report line (DB naming); Jeonnam separate = 0 complexes.
  masterComplexByMetro.set("gwangju", mergedGwangjuJeonnamComplexes);
  masterLawdCountByMetro.set("gwangju", mergedGwangjuJeonnamMasterLawds);
  masterComplexByMetro.set("jeonnam", 0);
  masterLawdCountByMetro.set("jeonnam", 0);

  const byRegion: RegionRow[] = [];
  for (const metro of REPORT_METROS) {
    const catalog = catalogByMetro.get(metro) ?? [];
    const expected = [...new Set(catalog)];
    // sync extras in this metro
    for (const c of syncLawdSet) {
      if (metroFromLawdNationwide(c) === metro && !expected.includes(c)) {
        expected.push(c);
      }
    }
    const syncAll = [...syncLawdSet].filter(
      (c) => metroFromLawdNationwide(c) === metro,
    );
    const missing = expected.filter((c) => !syncLawdSet.has(c));
    let cells = 0;
    let rows = 0;
    let filled = 0;
    for (const c of syncAll) {
      cells += cellsByLawd.get(c) ?? 0;
      const t = txLawdMap.get(c);
      rows += t?.rows ?? 0;
      filled += t?.filled ?? 0;
    }
    const causes: string[] = [];
    if (syncAll.length === 0) causes.push("sync_months absent");
    if (rows === 0 && syncAll.length === 0) causes.push("warehouse absent");
    if (syncAll.length > 0 && cells < syncAll.length * 20) {
      causes.push("partial history");
    }
    if (missing.length > 0 && syncAll.length > 0) {
      causes.push("partial geography vs catalog");
    }
    if (
      metro === "gwangju" ||
      metro === "jeonnam"
    ) {
      causes.push("master lawd mapping non-MOLIT (12xxx under 전남광주통합특별시)");
    }
    if (causes.length === 0 && missing.length === 0) {
      causes.push("complete in warehouse scope");
    }

    const notes =
      metro === "gwangju"
        ? `DB sido=전남광주통합특별시 complexes=${mergedGwangjuJeonnamComplexes}; master lawd prefixes=${mergedMasterLawdPrefixes.join(",")}; MOLIT catalog lawds=${catalog.length}`
        : metro === "jeonnam"
          ? `no separate sido in master; folded into 전남광주통합특별시; MOLIT catalog lawds=${catalog.length}`
          : undefined;

    byRegion.push({
      metro,
      label: METRO_LABELS[metro],
      canonicalComplexes: masterComplexByMetro.get(metro) ?? 0,
      expectedTradeLawds: expected.length,
      syncLawds: syncAll.length,
      missingLawds: missing.length,
      syncCells2023plus: cells,
      txRows2023plus: rows,
      rgstFilled: filled,
      warehouseCoveragePct: pct(filled, rows),
      incompleteCause: [...new Set(causes)],
      notes,
    });
  }

  // Explain the exact 75 lawds
  const backfillLawds = [...syncLawdSet].sort();
  const backfillByMetro: Record<string, { count: number; lawds: string[] }> = {};
  for (const lawd of backfillLawds) {
    const m = metroFromLawdNationwide(lawd);
    const slot = backfillByMetro[m] ?? { count: 0, lawds: [] };
    slot.count += 1;
    slot.lawds.push(lawd);
    backfillByMetro[m] = slot;
  }

  // Expansion cells: missing catalog lawds × calendar span
  // + remaining months only for NON capital partial lawds (Busan).
  // Seoul/Gyeonggi are launch-complete — do not count their sparse months as expansion.
  const monthsInScope = [...syncYmSet].sort();
  const calendarMonths = MONTHS_SCOPE;
  const capitalMetros = new Set<NationwideMetro>(["seoul", "gyeonggi"]);
  let additionalCellsExact = missingCatalogLawds.length * calendarMonths;
  let reusablePartialOutsideCapital = 0;
  let partialOutsideCapitalRemaining = 0;
  const partialOutsideCapital: Array<{
    lawd: string;
    have: number;
    need: number;
  }> = [];
  for (const lawd of syncLawdSet) {
    const metro = metroFromLawdNationwide(lawd);
    if (capitalMetros.has(metro)) continue;
    const have = cellsByLawd.get(lawd) ?? 0;
    if (have < calendarMonths) {
      const need = calendarMonths - have;
      additionalCellsExact += need;
      partialOutsideCapitalRemaining += need;
      reusablePartialOutsideCapital += have;
      partialOutsideCapital.push({ lawd, have, need });
    }
  }
  const observedMonthCount = monthsInScope.length || calendarMonths;

  // Row estimate — capital-biased observed density; discount for non-capital.
  const coveredCatalogLawds = catalogLawds.filter((c) => syncLawdSet.has(c));
  const coveredComplexes =
    (masterComplexByMetro.get("seoul") ?? 0) +
    (masterComplexByMetro.get("gyeonggi") ?? 0);
  const uncoveredComplexes = masterTotal - coveredComplexes;
  const rowsPerCoveredComplex =
    coveredComplexes > 0 ? warehouseRows / coveredComplexes : 0;
  // low: complexes-proportional * 0.45 density discount (non-capital trade intensity)
  // mid: complexes-proportional * 0.7
  // high: complexes-proportional * 1.0 (same intensity as capital)
  const estimatedRowsLow = Math.round(uncoveredComplexes * rowsPerCoveredComplex * 0.45);
  const estimatedRowsMid = Math.round(uncoveredComplexes * rowsPerCoveredComplex * 0.7);
  const estimatedRowsHigh = Math.round(uncoveredComplexes * rowsPerCoveredComplex * 1.0);

  const rateLow = 45;
  const rateHigh = 55;
  const runtimeLowMin = Math.ceil(additionalCellsExact / rateHigh);
  const runtimeHighMin = Math.ceil(additionalCellsExact / rateLow);

  const capitalLawds = new Set(allCapitalLawdCodes());
  const seoulGg = byRegion.filter(
    (r) => r.metro === "seoul" || r.metro === "gyeonggi",
  );
  const seoulGgRows = seoulGg.reduce((s, r) => s + r.txRows2023plus, 0);
  const seoulGgFilled = seoulGg.reduce((s, r) => s + r.rgstFilled, 0);

  const busan = byRegion.find((r) => r.metro === "busan")!;
  const incheon = byRegion.find((r) => r.metro === "incheon")!;
  const busanCellsDetail = syncCells
    .filter((r) => String(r.lawd).startsWith("26"))
    .map((r) => ({
      lawd: String(r.lawd),
      ym: String(r.ym),
      row_count: Number(r.row_count ?? 0),
    }));

  const out = {
    readOnly: true,
    molitApiCalls: 0,
    dbWrites: 0,
    CURRENT_BACKFILL: {
      lawds: backfillLawds.length,
      lawdList: backfillLawds,
      byMetro: Object.fromEntries(
        Object.entries(backfillByMetro).map(([k, v]) => [
          METRO_LABELS[k as NationwideMetro] ?? k,
          { count: v.count, lawds: v.lawds },
        ]),
      ),
      explain75:
        "서울 25 + 경기 49 + 부산 1(해운대 26350) = 75. Capital sync_months universe, not national catalog.",
      cells: syncCells.length,
      warehouseRows2023plus: warehouseRows,
      rgstPopulated: warehouseFilled,
      warehouseCoveragePct: pct(warehouseFilled, warehouseRows),
      note: "Prior report 86.9% = WAREHOUSE COVERAGE (A), NOT national geographic coverage (B)",
    },
    GEOGRAPHIC_COVERAGE: {
      nationalCanonicalComplexes: masterTotal,
      nationwideCatalogLawds: catalogLawds.length,
      expectedTradeLawds: expectedTradeLawds.size,
      coveredLawdsInSyncMonths: syncLawdSet.size,
      missingLawds: missingLawds.length,
      missingCatalogLawds: missingCatalogLawds.length,
      geographicCoveragePct: pct(syncLawdSet.size, expectedTradeLawds.size),
      catalogGeographicCoveragePct: pct(
        coveredCatalogLawds.length,
        catalogLawds.length,
      ),
      monthsPresentInWarehouse2023to202609: observedMonthCount,
      capitalLawdCodesInRegistry: capitalLawds.size,
      gwangjuJeonnamMasterMapping: {
        dbSido: "전남광주통합특별시",
        masterComplexes: mergedGwangjuJeonnamComplexes,
        masterDistinctLawds: mergedGwangjuJeonnamMasterLawds,
        masterLawdPrefixes: mergedMasterLawdPrefixes,
        molitCatalogGwangju: (catalogByMetro.get("gwangju") ?? []).length,
        molitCatalogJeonnam: (catalogByMetro.get("jeonnam") ?? []).length,
        note: "Master stores non-MOLIT 12xxx lawd_cd; AptTrade targets remain catalog 29xxx/46xxx",
      },
    },
    DENOMINATORS: {
      A_WAREHOUSE_COVERAGE: {
        definition:
          "rgst populated / 2023+ AptTrade rows already in transactions warehouse",
        value: `${warehouseFilled} / ${warehouseRows} = ${pct(warehouseFilled, warehouseRows)}%`,
        reclassifiesPrior869: true,
      },
      B_NATIONAL_GEOGRAPHIC_COVERAGE: {
        definition:
          "lawds with 2023+ sync_months trade cells / MOLIT nationwide catalog AptTrade lawd universe",
        value: `${syncLawdSet.size} / ${expectedTradeLawds.size} = ${pct(syncLawdSet.size, expectedTradeLawds.size)}%`,
      },
    },
    BY_REGION: Object.fromEntries(
      byRegion.map((r) => [
        r.label,
        {
          canonicalComplexes: r.canonicalComplexes,
          expectedTradeLawds: r.expectedTradeLawds,
          syncLawds: r.syncLawds,
          missingLawds: r.missingLawds,
          syncCells2023plus: r.syncCells2023plus,
          txRows2023plus: r.txRows2023plus,
          rgstFilled: r.rgstFilled,
          warehouseCoveragePct: r.warehouseCoveragePct,
          incompleteCause: r.incompleteCause,
          ...(r.notes ? { notes: r.notes } : {}),
        },
      ]),
    ),
    INCOMPLETE_CAUSES: {
      sync_months_absent: byRegion
        .filter((r) => r.incompleteCause.includes("sync_months absent"))
        .map((r) => r.label),
      partial_history: byRegion
        .filter((r) => r.incompleteCause.includes("partial history"))
        .map((r) => ({
          region: r.label,
          syncLawds: r.syncLawds,
          cells: r.syncCells2023plus,
          avgCellsPerLawd:
            r.syncLawds === 0
              ? 0
              : Math.round(r.syncCells2023plus / r.syncLawds),
        })),
      warehouse_absent: byRegion
        .filter((r) => r.txRows2023plus === 0)
        .map((r) => r.label),
      mapping: {
        method: "master sido via MASTER_SIDO_TO_METRO; AptTrade lawds via nationwide catalog prefix",
        gwangjuJeonnam:
          "master lawd_cd uses 12xxx under 전남광주통합특별시 — not usable as MOLIT AptTrade lawd; target 29xxx/46xxx from catalog",
      },
      incheonDetail: {
        syncLawds: incheon.syncLawds,
        txRows: incheon.txRows2023plus,
        expectedTradeLawds: incheon.expectedTradeLawds,
        canonicalComplexes: incheon.canonicalComplexes,
        cause:
          "sync_months absent for all lawd 28xxx; master has complexes but zero AptTrade warehouse cells → 0/0",
      },
      busanDetail: {
        syncLawds: busan.syncLawds,
        syncCells: busan.syncCells2023plus,
        expectedTradeLawds: busan.expectedTradeLawds,
        missingLawds: busan.missingLawds,
        txRows: busan.txRows2023plus,
        rgstFilled: busan.rgstFilled,
        cells: busanCellsDetail,
        cause:
          "partial geography (1/16 lawds) + partial history (only 202608/202609 for 26350) — not full 2023+ national backfill",
      },
    },
    TRUE_NATIONAL_EXPANSION: {
      additionalLawds: missingCatalogLawds.length,
      additionalLawdsIncludingPartialMonths: missingCatalogLawds.length,
      existingReusableCells: syncCells.length,
      reusablePartialCellsOnIncompleteNonCapitalLawds:
        reusablePartialOutsideCapital,
      partialOutsideCapital,
      monthsInWarehouseScope: observedMonthCount,
      additionalCellsEstimate: {
        value: additionalCellsExact,
        method: `missing_catalog_lawds(${missingCatalogLawds.length})*${calendarMonths} + remaining months on non-capital partial sync lawds (${partialOutsideCapital.map((p) => `${p.lawd}:${p.need}`).join(",") || "none"})`,
        note: "Seoul/Gyeonggi treated as launch-complete; their <45-month sync tails are NOT counted as national expansion",
      },
      estimatedApiCalls: {
        value: additionalCellsExact,
        note: "1 MOLIT AptTrade call per lawd-month cell (trade ingest + rgst fill jointly)",
      },
      estimatedRows: {
        low: estimatedRowsLow,
        mid: estimatedRowsMid,
        high: estimatedRowsHigh,
        method: `uncovered_complexes(${uncoveredComplexes}) * rows_per_covered_complex(${rowsPerCoveredComplex.toFixed(1)}) * density{0.45,0.7,1.0}; capital-biased so low/mid preferred`,
      },
      estimatedWrites: {
        low: estimatedRowsLow,
        high: estimatedRowsHigh,
        note: "First-time geography needs INSERT of trade rows then rgst UPDATE; counts ≈ new trade rows (rgst populated on insert)",
      },
      estimatedRuntimeMinutes: {
        low: runtimeLowMin,
        high: runtimeHighMin,
        assumedRateCellsPerMin: `${rateLow}-${rateHigh} (prior national Seoul/Gyeonggi run)`,
        approxHours: {
          low: Math.round((runtimeLowMin / 60) * 10) / 10,
          high: Math.round((runtimeHighMin / 60) * 10) / 10,
        },
      },
      caveat:
        "Missing geographies have no AptTrade warehouse history. True national registration requires trade-month sync for those lawds first (or jointly), not rgst_date column fill alone.",
    },
    OPTIONS: {
      SEOUL_GYEONGGI_LAUNCH: {
        ready: true,
        warehouseRows: seoulGgRows,
        rgstFilled: seoulGgFilled,
        warehouseCoveragePct: pct(seoulGgFilled, seoulGgRows),
        seoul: {
          filled: byRegion.find((r) => r.metro === "seoul")!.rgstFilled,
          total: byRegion.find((r) => r.metro === "seoul")!.txRows2023plus,
        },
        gyeonggi: {
          filled: byRegion.find((r) => r.metro === "gyeonggi")!.rgstFilled,
          total: byRegion.find((r) => r.metro === "gyeonggi")!.txRows2023plus,
        },
        additionalApiCalls: 0,
        additionalWrites: 0,
        note: "Use current warehouse; 2026 unresolved = publication lag",
      },
      TRUE_NATIONAL: {
        ready: false,
        additionalLawds: missingCatalogLawds.length,
        additionalCells: additionalCellsExact,
        estimatedApiCalls: additionalCellsExact,
        estimatedRows: {
          low: estimatedRowsLow,
          mid: estimatedRowsMid,
          high: estimatedRowsHigh,
        },
        estimatedRuntimeMinutes: {
          low: runtimeLowMin,
          high: runtimeHighMin,
        },
        prerequisite: "ingest AptTrade months for missing lawds into warehouse",
      },
      tradeoff:
        "A ships Seoul+Gyeonggi now with honest warehouse coverage (~87%). B needs ~8k additional lawd-month cells and first-time trade ingest outside capital region; geographic coverage today is ~30%.",
    },
    ROLLING_REFRESH: {
      windowMonths: 6,
      lagSupports6M: true,
      lagMedianDays: 86,
      lagP75Days: 105,
      lagP90Days: 123,
      lagP95Days: 139,
      initialBackfillReplacement: false,
      note: "p95 lag 139d < 6M window — operational refresh is reasonable for already-synced lawds. Does NOT discover or fill missing national geography.",
    },
    VERDICT: "NATIONAL_EXPANSION_REQUIRED",
  };

  const json = JSON.stringify(out, null, 2);
  console.log(json);

  const outPath = join(
    process.cwd(),
    "data/poc/rgst-national-scope-audit.json",
  );
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, json + "\n");
  console.error(`wrote ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

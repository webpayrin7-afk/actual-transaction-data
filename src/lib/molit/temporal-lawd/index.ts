/**
 * Source-specific TEMPORAL LAWD crosswalk for MOLIT AptTrade.
 *
 * Separates:
 * - CANONICAL region identity (apt_complex_master.lawd_cd — never mutated here)
 * - HISTORICAL admin lawd (MOIS pre-2026-07 codes)
 * - MOLIT AptTrade request lawd (live API; may equal canonical successor)
 *
 * Effective boundary: 2026-07-01 (MOIS official change notice).
 * Do not scatter this date outside this module.
 */
import crosswalkJson from "./mois-20260701-crosswalk.json";

export const APTTRADE_ADMIN_EFFECTIVE_DATE = "2026-07-01";
export const APTTRADE_ADMIN_EFFECTIVE_YM = "202607";

export type TemporalLawdPair = {
  historical_name: string;
  historical_lawd: string;
  canonical_name: string;
  canonical_lawd: string;
  apttrade_request_lawd?: string;
  relation?: string;
  note?: string;
  evidence?: string;
};

type CrosswalkDoc = {
  version: number;
  effective_date: string;
  sources: Array<{ id: string; title: string; url: string }>;
  molit_aptrade_behavior: { summary: string; implication: string };
  gwangju_jeonnam: {
    pairs: TemporalLawdPair[];
    exact: number;
    ambiguous: number;
    unmapped: number;
  };
  incheon: {
    pairs: TemporalLawdPair[];
    aptrade_request_lawds_to_backfill: string[];
    true_nodata: string[];
    obsolete_catalog_nodata: string[];
  };
};

const DOC = crosswalkJson as CrosswalkDoc;

export function temporalCrosswalkDoc(): CrosswalkDoc {
  return DOC;
}

/** Official admin effective date (YYYY-MM-DD). */
export function adminEffectiveDate(): string {
  return DOC.effective_date;
}

export function isYmBeforeAdminChange(yearMonth: string): boolean {
  return yearMonth < APTTRADE_ADMIN_EFFECTIVE_YM;
}

/** Canonical 12xxx → historical admin 29/46 (MOIS). */
export function historicalAdminLawdFromCanonical(
  canonicalLawd: string,
): string | null {
  const hit = DOC.gwangju_jeonnam.pairs.find(
    (p) => p.canonical_lawd === canonicalLawd,
  );
  return hit?.historical_lawd ?? null;
}

/** Historical admin 29/46 → canonical 12xxx (MOIS). */
export function canonicalLawdFromHistoricalAdmin(
  historicalLawd: string,
): string | null {
  const hit = DOC.gwangju_jeonnam.pairs.find(
    (p) => p.historical_lawd === historicalLawd,
  );
  return hit?.canonical_lawd ?? null;
}

/**
 * MOLIT AptTrade request LAWD for a deal month.
 *
 * Probe evidence: obsolete admin codes return 0 for pre- and post-change
 * months; successor/canonical codes return rows for both. Therefore the
 * request lawd is the canonical/successor code for all months in scope.
 */
export function aptTradeRequestLawdForMonth(params: {
  canonicalOrCatalogLawd: string;
  yearMonth: string;
}): string {
  const { canonicalOrCatalogLawd } = params;
  // Gwangju/Jeonnam catalog still lists 29/46 — map to canonical request.
  const fromHist = canonicalLawdFromHistoricalAdmin(canonicalOrCatalogLawd);
  if (fromHist) return fromHist;

  // Already canonical 12xxx
  if (
    DOC.gwangju_jeonnam.pairs.some(
      (p) => p.canonical_lawd === canonicalOrCatalogLawd,
    )
  ) {
    return canonicalOrCatalogLawd;
  }

  // Incheon obsolete catalog → all successors (caller may expand set)
  const icn = DOC.incheon.pairs.filter(
    (p) => p.historical_lawd === canonicalOrCatalogLawd,
  );
  if (icn.length === 1) return icn[0]!.canonical_lawd;
  if (icn.length > 1) {
    // Split: return first; use aptTradeRequestLawdsForCatalog for full set
    return icn[0]!.canonical_lawd;
  }

  // Gangwon/Jeonbuk prefix remap (delegated from apttrade-lawd-mapping)
  const prefix = canonicalOrCatalogLawd.slice(0, 2);
  if (prefix === "42") return `51${canonicalOrCatalogLawd.slice(2)}`;
  if (prefix === "45") return `52${canonicalOrCatalogLawd.slice(2)}`;

  return canonicalOrCatalogLawd;
}

/** Expand a catalog/obsolete lawd into all AptTrade request targets. */
export function aptTradeRequestLawdsForCatalog(lawdCd: string): string[] {
  const fromHist = canonicalLawdFromHistoricalAdmin(lawdCd);
  if (fromHist) return [fromHist];

  const icn = DOC.incheon.pairs
    .filter((p) => p.historical_lawd === lawdCd)
    .map((p) => p.canonical_lawd);
  if (icn.length) return [...new Set(icn)];

  return [aptTradeRequestLawdForMonth({ canonicalOrCatalogLawd: lawdCd, yearMonth: "202301" })];
}

/** All Gwangju/Jeonnam AptTrade request lawds (canonical 12xxx). */
export function gwangjuJeonnamAptTradeRequestLawds(): string[] {
  return DOC.gwangju_jeonnam.pairs.map((p) => p.canonical_lawd);
}

export function incheonAptTradeBackfillLawds(): string[] {
  return [...DOC.incheon.aptrade_request_lawds_to_backfill];
}

export function incheonTrueNodataLawds(): string[] {
  return [...DOC.incheon.true_nodata];
}

export function gwangjuJeonnamMappingCoverage(): {
  exact: number;
  ambiguous: number;
  unmapped: number;
  historicalRequestLawds: number;
  canonicalCodes: number;
} {
  return {
    exact: DOC.gwangju_jeonnam.exact,
    ambiguous: DOC.gwangju_jeonnam.ambiguous,
    unmapped: DOC.gwangju_jeonnam.unmapped,
    historicalRequestLawds: DOC.gwangju_jeonnam.pairs.length,
    canonicalCodes: new Set(
      DOC.gwangju_jeonnam.pairs.map((p) => p.canonical_lawd),
    ).size,
  };
}

export function classifyIncheonNodataCode(lawdCd: string): {
  code: string;
  classification:
    | "TEMPORAL_CODE_ISSUE"
    | "TRUE_NODATA"
    | "UNKNOWN";
  successors: string[];
  note: string;
} {
  if (DOC.incheon.true_nodata.includes(lawdCd)) {
    return {
      code: lawdCd,
      classification: "TRUE_NODATA",
      successors: [lawdCd],
      note: "Unchanged under 2026-07-01 reform; AptTrade returns 0",
    };
  }
  const successors = DOC.incheon.pairs
    .filter((p) => p.historical_lawd === lawdCd)
    .map((p) => p.canonical_lawd);
  if (successors.length) {
    return {
      code: lawdCd,
      classification: "TEMPORAL_CODE_ISSUE",
      successors,
      note: "Obsolete catalog code; MOLIT serves successor lawds for pre/post months",
    };
  }
  return {
    code: lawdCd,
    classification: "UNKNOWN",
    successors: [],
    note: "Not in MOIS 2026-07-01 Incheon change set",
  };
}

/** Normalize catalog/sync lawd → MOLIT AptTrade request lawd for a deal month. */
export function planAptTradeRequestLawd(
  lawdCd: string,
  yearMonth: string,
): string {
  return aptTradeRequestLawdForMonth({
    canonicalOrCatalogLawd: lawdCd,
    yearMonth,
  });
}

/**
 * Validate a rolling-refresh cell plan against the temporal crosswalk.
 * Flags obsolete catalog codes still stored in sync_months.
 */
export function validateTemporalRollingPlan(
  cells: Array<{ lawdCd: string; yearMonth: string }>,
): {
  temporalAware: true;
  boundarySamples: Array<{
    catalogOrSyncLawd: string;
    yearMonth: string;
    requestLawd: string;
  }>;
  mismatched: Array<{
    catalogOrSyncLawd: string;
    yearMonth: string;
    expected: string;
    stored: string;
  }>;
} {
  const boundarySamples: Array<{
    catalogOrSyncLawd: string;
    yearMonth: string;
    requestLawd: string;
  }> = [];
  const mismatched: Array<{
    catalogOrSyncLawd: string;
    yearMonth: string;
    expected: string;
    stored: string;
  }> = [];

  for (const cell of cells) {
    const request = planAptTradeRequestLawd(cell.lawdCd, cell.yearMonth);
    if (
      cell.yearMonth === "202606" ||
      cell.yearMonth === "202607" ||
      cell.yearMonth === "202608"
    ) {
      boundarySamples.push({
        catalogOrSyncLawd: cell.lawdCd,
        yearMonth: cell.yearMonth,
        requestLawd: request,
      });
    }
    if (
      (cell.lawdCd.startsWith("29") ||
        cell.lawdCd.startsWith("46") ||
        cell.lawdCd === "28110" ||
        cell.lawdCd === "28140" ||
        cell.lawdCd === "28260") &&
      request !== cell.lawdCd
    ) {
      mismatched.push({
        catalogOrSyncLawd: cell.lawdCd,
        yearMonth: cell.yearMonth,
        expected: request,
        stored: cell.lawdCd,
      });
    }
  }

  const reps = [
    { lawdCd: "29110", yearMonth: "202606" },
    { lawdCd: "29110", yearMonth: "202607" },
    { lawdCd: "46110", yearMonth: "202606" },
    { lawdCd: "46110", yearMonth: "202608" },
    { lawdCd: "12210", yearMonth: "202606" },
    { lawdCd: "12210", yearMonth: "202607" },
    { lawdCd: "28110", yearMonth: "202606" },
    { lawdCd: "28110", yearMonth: "202608" },
  ];
  for (const r of reps) {
    boundarySamples.push({
      catalogOrSyncLawd: r.lawdCd,
      yearMonth: r.yearMonth,
      requestLawd: planAptTradeRequestLawd(r.lawdCd, r.yearMonth),
    });
  }

  return { temporalAware: true, boundarySamples, mismatched };
}

/**
 * Separates CANONICAL region identity from MOLIT AptTrade request LAWD_CD.
 *
 * Temporal admin changes (2026-07-01) live in temporal-lawd/.
 * This module remains the request-lawd façade used by sync/expand jobs.
 */
import {
  NATIONWIDE_LAWD_ROWS,
  metroFromLawdNationwide,
  type NationwideMetro,
} from "../constants/nationwide-lawd";
import {
  aptTradeRequestLawdForMonth,
  aptTradeRequestLawdsForCatalog,
  gwangjuJeonnamAptTradeRequestLawds,
  incheonAptTradeBackfillLawds,
  incheonTrueNodataLawds,
} from "./temporal-lawd";

/**
 * Legacy administrative prefix → current MOLIT AptTrade prefix.
 * Verified by live AptTrade probe (legacy returns 0; remapped returns rows).
 */
const LEGACY_TO_APTTRADE_PREFIX: Record<string, string> = {
  "42": "51", // 강원 → 강원특별자치도
  "45": "52", // 전북 → 전북특별자치도
};

/** @deprecated Prefer temporal-lawd planner; kept for status reporting. */
export const APTTRADE_MAPPING_HOLD_METROS: ReadonlySet<NationwideMetro> =
  new Set();

export function isAptTradeMappingHoldLawd(_lawdCd: string): boolean {
  // Gwangju/Jeonnam HOLD lifted after MOIS 2026-07-01 crosswalk + MOLIT probe.
  return false;
}

/** Map catalog/canonical lawd to the LAWD_CD MOLIT AptTrade expects. */
export function toAptTradeRequestLawd(lawdCd: string): string {
  return aptTradeRequestLawdForMonth({
    canonicalOrCatalogLawd: lawdCd,
    yearMonth: "202301",
  });
}

export function toAptTradeRequestLawds(lawdCd: string): string[] {
  return aptTradeRequestLawdsForCatalog(lawdCd);
}

/** MOLIT AptTrade request lawds that are runnable. */
export function runnableAptTradeLawds(): string[] {
  const fromCatalog = NATIONWIDE_LAWD_ROWS.map((r) => r.code).flatMap((c) =>
    toAptTradeRequestLawds(c),
  );
  const extra = [
    ...gwangjuJeonnamAptTradeRequestLawds(),
    ...incheonAptTradeBackfillLawds(),
  ];
  return [...new Set([...fromCatalog, ...extra])].filter(
    (c) => !incheonTrueNodataLawds().includes(c),
  );
}

export function runnableAptTradeRequestLawds(): string[] {
  return runnableAptTradeLawds();
}

export function mappingHoldLawds(): string[] {
  return [];
}

export function aptTradeMappingStatus(): {
  gwangju: "TEMPORAL_CROSSWALK_PASS";
  jeonnam: "TEMPORAL_CROSSWALK_PASS";
  sourceSpecificLawdMapping: true;
  legacyPrefixRemap: Record<string, string>;
  temporalEffectiveDate: string;
  reason: string;
  holdLawds: string[];
} {
  return {
    gwangju: "TEMPORAL_CROSSWALK_PASS",
    jeonnam: "TEMPORAL_CROSSWALK_PASS",
    sourceSpecificLawdMapping: true,
    legacyPrefixRemap: { ...LEGACY_TO_APTTRADE_PREFIX },
    temporalEffectiveDate: "2026-07-01",
    reason:
      "MOIS 2026-07-01 official pairs: 29/46↔12xxx exact 27/27. Live MOLIT AptTrade serves canonical 12xxx (and Incheon successors) for pre/post months; obsolete catalog codes return 0.",
    holdLawds: [],
  };
}

export { metroFromLawdNationwide };

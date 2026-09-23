/**
 * Separates CANONICAL region identity (apt_complex_master.lawd_cd /
 * nationwide catalog) from MOLIT AptTrade request LAWD_CD.
 *
 * Gwangju/Jeonnam master currently stores non-MOLIT `12xxx` under
 * sido=`전남광주통합특별시`. MOLIT AptTrade uses `29xxx` / `46xxx`.
 * No deterministic bridge without mutating complex_id — MAPPING_HOLD.
 *
 * Gangwon/Jeonbuk: catalog still lists legacy 42xxx/45xxx, but live MOLIT
 * AptTrade (verified) and apt_complex_master use 51xxx/52xxx. Deterministic
 * prefix remap only — not a guess.
 */
import {
  NATIONWIDE_LAWD_ROWS,
  metroFromLawdNationwide,
  type NationwideMetro,
} from "../constants/nationwide-lawd";

/** Metros held until a deterministic canonical↔AptTrade lawd bridge exists. */
export const APTTRADE_MAPPING_HOLD_METROS: ReadonlySet<NationwideMetro> =
  new Set(["gwangju", "jeonnam"]);

/**
 * Legacy administrative prefix → current MOLIT AptTrade prefix.
 * Verified by live AptTrade probe (legacy returns 0; remapped returns rows).
 */
const LEGACY_TO_APTTRADE_PREFIX: Record<string, string> = {
  "42": "51", // 강원 → 강원특별자치도
  "45": "52", // 전북 → 전북특별자치도
};

export function isAptTradeMappingHoldLawd(lawdCd: string): boolean {
  const metro = metroFromLawdNationwide(lawdCd);
  return APTTRADE_MAPPING_HOLD_METROS.has(metro);
}

/** Map catalog/canonical lawd to the LAWD_CD MOLIT AptTrade expects. */
export function toAptTradeRequestLawd(lawdCd: string): string {
  const prefix = lawdCd.slice(0, 2);
  const mapped = LEGACY_TO_APTTRADE_PREFIX[prefix];
  if (!mapped) return lawdCd;
  return `${mapped}${lawdCd.slice(2)}`;
}

/** MOLIT AptTrade request lawds that are runnable (not on mapping hold). */
export function runnableAptTradeLawds(): string[] {
  return NATIONWIDE_LAWD_ROWS.map((r) => r.code).filter(
    (c) => !isAptTradeMappingHoldLawd(c),
  );
}

/** Distinct request LAWDs for runnable catalog rows (after legacy remap). */
export function runnableAptTradeRequestLawds(): string[] {
  return [
    ...new Set(runnableAptTradeLawds().map((c) => toAptTradeRequestLawd(c))),
  ];
}

export function mappingHoldLawds(): string[] {
  return NATIONWIDE_LAWD_ROWS.map((r) => r.code).filter((c) =>
    isAptTradeMappingHoldLawd(c),
  );
}

export function aptTradeMappingStatus(): {
  gwangju: "MAPPING_HOLD";
  jeonnam: "MAPPING_HOLD";
  sourceSpecificLawdMapping: true;
  legacyPrefixRemap: Record<string, string>;
  reason: string;
  holdLawds: string[];
} {
  return {
    gwangju: "MAPPING_HOLD",
    jeonnam: "MAPPING_HOLD",
    sourceSpecificLawdMapping: true,
    legacyPrefixRemap: { ...LEGACY_TO_APTTRADE_PREFIX },
    reason:
      "Gwangju/Jeonnam: master 12xxx under 전남광주통합특별시 ↔ MOLIT 29/46 has no deterministic bridge without complex_id rewrite (HOLD). Gangwon/Jeonbuk: catalog 42/45 → AptTrade+master 51/52 via verified prefix remap.",
    holdLawds: mappingHoldLawds(),
  };
}

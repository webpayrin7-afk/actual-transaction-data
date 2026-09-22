/**
 * Separates CANONICAL region identity (apt_complex_master.lawd_cd)
 * from MOLIT AptTrade request LAWD_CD.
 *
 * Gwangju/Jeonnam master currently stores non-MOLIT `12xxx` under
 * sido=`전남광주통합특별시`. MOLIT AptTrade uses `29xxx` / `46xxx`.
 * No deterministic source-specific mapping exists without mutating
 * canonical complex_id — those metros are MAPPING_HOLD for expansion.
 */
import {
  NATIONWIDE_LAWD_ROWS,
  metroFromLawdNationwide,
  type NationwideMetro,
} from "../constants/nationwide-lawd";

/** Metros held until a deterministic canonical↔AptTrade lawd bridge exists. */
export const APTTRADE_MAPPING_HOLD_METROS: ReadonlySet<NationwideMetro> =
  new Set(["gwangju", "jeonnam"]);

export function isAptTradeMappingHoldLawd(lawdCd: string): boolean {
  const metro = metroFromLawdNationwide(lawdCd);
  return APTTRADE_MAPPING_HOLD_METROS.has(metro);
}

/** MOLIT AptTrade request lawds that are runnable (not on mapping hold). */
export function runnableAptTradeLawds(): string[] {
  return NATIONWIDE_LAWD_ROWS.map((r) => r.code).filter(
    (c) => !isAptTradeMappingHoldLawd(c),
  );
}

export function mappingHoldLawds(): string[] {
  return NATIONWIDE_LAWD_ROWS.map((r) => r.code).filter((c) =>
    isAptTradeMappingHoldLawd(c),
  );
}

export function aptTradeMappingStatus(): {
  gwangju: "MAPPING_HOLD";
  jeonnam: "MAPPING_HOLD";
  sourceSpecificLawdMapping: false;
  reason: string;
  holdLawds: string[];
} {
  return {
    gwangju: "MAPPING_HOLD",
    jeonnam: "MAPPING_HOLD",
    sourceSpecificLawdMapping: false,
    reason:
      "apt_complex_master uses lawd_cd 12xxx under 전남광주통합특별시; MOLIT AptTrade requires 29xxx/46xxx. No deterministic bridge without complex_id rewrite.",
    holdLawds: mappingHoldLawds(),
  };
}

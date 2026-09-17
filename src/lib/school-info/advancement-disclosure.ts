/**
 * SchoolInfo official disclosure “13-다. 졸업생의 진로 현황” (openData APITYPE=52).
 *
 * Pilot status: HOLD for product UI.
 * - openData APITYPE=52 raw records match schools (e.g. 잠실중학교 2025).
 * - TOTAL* → official Korean label binding remains UNCONFIRMED:
 *   opendata.js case "52" headers are empty; open-data UI omits item 52;
 *   school-page/Excel header endpoints were unavailable (서비스 일시 중단).
 * - Do not invent labels, do not show “자사고” for TOTAL9, do not aggregate 특목고.
 *
 * See `apitype52-total-mapping-report.json` for the full investigation.
 */

import pilot from "./advancement-disclosure-pilot.json";

export type AdvancementDisclosureStatus = "HOLD" | "PASS";

export type AdvancementDisclosurePilot = typeof pilot;

export const ADVANCEMENT_DISCLOSURE_STATUS: AdvancementDisclosureStatus =
  pilot.status === "HOLD" ? "HOLD" : "PASS";

export function getAdvancementDisclosurePilot(): AdvancementDisclosurePilot {
  return pilot;
}

/** Product UI must stay omitted until categoryFieldMapping is confirmed. */
export function canRenderAdvancementSection(): boolean {
  return (
    ADVANCEMENT_DISCLOSURE_STATUS === "PASS" &&
    pilot.categoryFieldMapping !== "UNCONFIRMED"
  );
}

/**
 * SchoolInfo official disclosure “13-다. 졸업생의 진로 현황” (openData APITYPE=52).
 *
 * Middle schools: ADVANCEMENT_API52 = PASS (STRUCTURALLY_CONFIRMED bindings).
 * High schools: separate schema; career mapping HOLD (do not reuse middle map).
 * Elementary: NOT_APPLICABLE (openData apiType52 empty for schulKndCode=02).
 *
 * SOT: `./apitype52-total-mapping-report.json`, `./middle-advancement-mapping.ts`
 */

import pilot from "./advancement-disclosure-pilot.json";

export type AdvancementApi52Status =
  | "HOLD_UNCONFIRMED_FIELD_MAPPING"
  | "PASS"
  | "PASS_STRUCTURALLY_CONFIRMED";

export type AdvancementDisclosurePilot = typeof pilot;

export const ADVANCEMENT_API52: AdvancementApi52Status =
  pilot.status === "PASS" || pilot.status === "PASS_STRUCTURALLY_CONFIRMED"
    ? "PASS_STRUCTURALLY_CONFIRMED"
    : "HOLD_UNCONFIRMED_FIELD_MAPPING";

/** @deprecated Use ADVANCEMENT_API52 */
export const ADVANCEMENT_DISCLOSURE_STATUS =
  ADVANCEMENT_API52 === "HOLD_UNCONFIRMED_FIELD_MAPPING" ? "HOLD" : "PASS";

export function getAdvancementDisclosurePilot(): AdvancementDisclosurePilot {
  return pilot;
}

/** Middle-school 진학현황 may render when STRUCTURALLY_CONFIRMED (or stronger). */
export function canRenderAdvancementSection(): boolean {
  return (
    (ADVANCEMENT_API52 === "PASS" ||
      ADVANCEMENT_API52 === "PASS_STRUCTURALLY_CONFIRMED") &&
    pilot.categoryFieldMapping !== "UNCONFIRMED"
  );
}

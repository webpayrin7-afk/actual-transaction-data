/**
 * SchoolInfo official disclosure “13-다. 졸업생의 진로 현황” (openData APITYPE=52).
 *
 * Pilot status: HOLD for product UI.
 * - Source + school match verified for 잠신중학교 (2025).
 * - TOTAL* category → label mapping is UNCONFIRMED (item-52 headers empty in
 *   official open-data client JS; Excel/header panel unavailable).
 * Do not invent labels or aggregate a “특목고” metric.
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

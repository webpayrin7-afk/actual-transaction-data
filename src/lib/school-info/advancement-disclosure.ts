/**
 * SchoolInfo official disclosure “13-다. 졸업생의 진로 현황” (openData APITYPE=52).
 *
 * Product status: ADVANCEMENT_API52 = HOLD_UNCONFIRMED_FIELD_MAPPING
 *
 * Locked decisions (do not violate):
 * - No product UI for advancement / 진학현황
 * - No TOTAL* → category hardcode mapping
 * - No DB ingest of apiType52
 * - No regional aggregation
 * - No bulk rediscovery of TOTAL labels from observation alone
 *
 * SOT investigation: `./apitype52-total-mapping-report.json`
 *
 * UNBLOCK if one of:
 * - 학교알리미 공식 TOTAL2~14 header 확보
 * - 공식 다운로드 파일에서 column binding 확인
 * - 공식 frontend/header definition 확인
 * - 학교알리미 공식 문서로 field mapping 확인
 *
 * Observational value matches alone must NOT unblock.
 */

import pilot from "./advancement-disclosure-pilot.json";

export type AdvancementApi52Status =
  | "HOLD_UNCONFIRMED_FIELD_MAPPING"
  | "PASS";

export type AdvancementDisclosurePilot = typeof pilot;

/** Product constant — keep HOLD until SOT report flips. */
export const ADVANCEMENT_API52: AdvancementApi52Status =
  pilot.status === "HOLD_UNCONFIRMED_FIELD_MAPPING" ||
  pilot.status === "HOLD"
    ? "HOLD_UNCONFIRMED_FIELD_MAPPING"
    : "PASS";

/** @deprecated Use ADVANCEMENT_API52 */
export const ADVANCEMENT_DISCLOSURE_STATUS =
  ADVANCEMENT_API52 === "PASS" ? "PASS" : "HOLD";

export function getAdvancementDisclosurePilot(): AdvancementDisclosurePilot {
  return pilot;
}

/**
 * Advancement / 진학현황 must not render while mapping is unconfirmed.
 * Always false under HOLD_UNCONFIRMED_FIELD_MAPPING.
 */
export function canRenderAdvancementSection(): boolean {
  return (
    ADVANCEMENT_API52 === "PASS" &&
    pilot.categoryFieldMapping !== "UNCONFIRMED"
  );
}

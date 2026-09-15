/**
 * Portal OpenAPI catalogs for management-fee derivation.
 * Op names verified against data.go.kr catalogs 15057937 / 15059469 / 15059160.
 * Service path tokens match Phase 7.1c live calls.
 * Do NOT use K-apt internal web endpoints.
 */

export const PORTAL_BASE = "https://apis.data.go.kr/1613000";

export const PORTAL_COMMON_SERVICE = "AptCmnuseManageCostServiceV3";
export const PORTAL_INDIVIDUAL_SERVICE = "AptIndvdlzManageCostServiceV3";
export const PORTAL_REPAIRS_SERVICE = "AptRepairsCostServiceV3";
export const PORTAL_BASIS_SERVICE = "AptBasisInfoServiceV5";
export const PORTAL_RESERVE_OP = "getHsmpMonthFeeInfoV3";
export const PORTAL_BASS_OP = "getAphusBassInfoV5";

export const PORTAL_FEE_SOURCE = "MOLIT_PORTAL_OPENAPI";
export const PORTAL_FEE_SOURCE_VERSION = "commonV3+indivV3+reserveV3+bassV5/phase26";

/** Legacy 잠실엘스 constants (Phase 2.6). Expansion pilots resolve kapt/privArea at ingest. */
export const PILOT_KAPT_CODE = "A13822004";
export const PILOT_COMPLEX_ID = "cx_4c63d9a100973c60";
/** getAphusBassInfoV5.privArea — 잠실엘스 verified */
export const PILOT_PRIV_AREA_M2 = 470_139.94;

/** Expansion allowlist by exact apt_name_norm. No nationwide scan. */
export const EXPANSION_PILOT_APT_NAMES = [
  "파크리오",
  "반포자이",
  "은마",
  "헬리오시티",
  "래미안안양메가트리아",
] as const;

/**
 * 공용관리비 V3 — 17 operations.
 * Amount fields are all numeric item keys except kaptCode/kaptName (summed at fetch).
 */
export const COMMON_OPERATIONS = [
  { op: "getHsmpCleaningCostInfoV3", fields: ["cleanCost"] },
  { op: "getHsmpGuardCostInfoV3", fields: ["guardCost"] },
  { op: "getHsmpDisinfectionCostInfoV3", fields: ["disinfCost"] },
  { op: "getHsmpElevatorMntncCostInfoV3", fields: ["elevCost"] },
  { op: "getHsmpRepairsCostInfoV3", fields: ["lrefCost1"] },
  { op: "getHsmpFacilityMntncCostInfoV3", fields: ["lrefCost2"] },
  { op: "getHsmpSafetyCheckUpCostInfoV3", fields: ["lrefCost3"] },
  { op: "getHsmpDisasterPreventionCostInfoV3", fields: ["lrefCost4"] },
  { op: "getHsmpConsignManageFeeInfoV3", fields: ["manageCost"] },
  {
    op: "getHsmpOfcrkCostInfoV3",
    fields: ["officeSupply", "bookSupply", "transportCost"],
  },
  { op: "getHsmpClothingCostInfoV3", fields: ["clothesCost"] },
  { op: "getHsmpEduTraingCostInfoV3", fields: ["eduCost"] },
  {
    op: "getHsmpVhcleMntncCostInfoV3",
    fields: ["fuelCost", "refairCost", "carInsurance", "carEtc"],
  },
  { op: "getHsmpHomeNetworkMntncCostInfoV3", fields: ["hnetwCost"] },
  {
    op: "getHsmpLaborCostInfoV3",
    fields: [
      "pay",
      "sundryCost",
      "bonus",
      "pension",
      "accidentPremium",
      "employPremium",
      "nationalPension",
      "healthPremium",
      "welfareBenefit",
    ],
  },
  {
    op: "getHsmpTaxdueInfoV3",
    fields: ["electCost", "telCost", "postageCost", "taxrestCost"],
  },
  {
    op: "getHsmpEtcCostInfoV3",
    fields: ["careItemCost", "accountingCost", "hiddenCost"],
  },
] as const;

/** 개별사용료 V3 — 10 operations (TV방송수신료 not provided by OpenAPI) */
export const INDIVIDUAL_OPERATIONS = [
  { op: "getHsmpElectricityCostInfoV3", fields: ["electC", "electP"] },
  { op: "getHsmpWaterCostInfoV3", fields: ["waterCoolC", "waterCoolP"] },
  { op: "getHsmpHeatCostInfoV3", fields: ["heatC", "heatP"] },
  { op: "getHsmpHotWaterCostInfoV3", fields: ["waterHotC", "waterHotP"] },
  { op: "getHsmpGasRentalFeeInfoV3", fields: ["gasC", "gasP"] },
  { op: "getHsmpWaterPurifierTankFeeInfoV3", fields: ["purifi"] },
  { op: "getHsmpDomesticWasteFeeInfoV3", fields: ["scrap"] },
  { op: "getHsmpBuildingInsuranceFeeInfoV3", fields: ["buildInsu"] },
  { op: "getHsmpElectionOrpnsInfoV3", fields: ["electionMng"] },
  { op: "getHsmpMovingInRepresentationMtgInfoV3", fields: ["preMeet"] },
] as const;

/** @deprecated prefer COMMON_OPERATIONS */
export const PORTAL_COMMON_OPS = COMMON_OPERATIONS.map((o) => o.op);
/** @deprecated prefer INDIVIDUAL_OPERATIONS */
export const PORTAL_INDIVIDUAL_OPS = INDIVIDUAL_OPERATIONS.map((o) => o.op);

export const PORTAL_KNOWN_MISSING =
  "개별사용료 OpenAPI에 TV방송수신료 항목이 제공되지 않음 (잠실엘스 2026-07 기준 K-apt 완성값 대비 약 -0.68%)";

export type PortalFeeStatus = "COMPLETE" | "INCOMPLETE";

export type PortalOpResult = {
  op: string;
  ok: boolean;
  sum: number;
  error?: string;
};

export type PortalMonthTotals = {
  searchDate: string;
  kaptCode: string;
  privArea: number;
  commonTotal: number;
  individualTotal: number;
  reserveTotal: number;
  portalTotal: number;
  perAreaCommon: number | null;
  perAreaIndividual: number | null;
  perAreaReserve: number | null;
  perAreaTotal: number | null;
  status: PortalFeeStatus;
  commonOps: PortalOpResult[];
  individualOps: PortalOpResult[];
  reserveOk: boolean;
  reserveError?: string;
};

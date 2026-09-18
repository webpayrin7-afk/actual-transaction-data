/**
 * Operation-name adapter.
 *
 * Identifiers only. This is not a copy of phase26 fetch/parse/ALTER code
 * and it does not import portal-mgmt-fee-ops.ts.
 *
 * - main: op names called by scripts/phase71c-sample-fee-apply.mts
 * - reference: op names from the historical phase26 catalog (4920f57)
 *
 * Completeness for the canonical dry-run uses the reference list.
 */

export type FeeService = "common" | "individual" | "reserve";

export type CatalogOp = {
  op: string;
  service: FeeService;
};

export type CatalogDiff = {
  reference_ops: string[];
  main_ops: string[];
  shared: string[];
  main_only: string[];
  reference_only: string[];
};

/** phase71c COMMON_OPS, in source order. */
const PHASE71C_COMMON: CatalogOp[] = [
  { op: "getHsmpCleaningCostInfoV3", service: "common" },
  { op: "getHsmpGuardCostInfoV3", service: "common" },
  { op: "getHsmpDisinfectCostInfoV3", service: "common" },
  { op: "getHsmpElevatorCostInfoV3", service: "common" },
  { op: "getHsmpLiquifiedTaxCostInfoV3", service: "common" },
  { op: "getHsmpManageCostInfoV3", service: "common" },
  { op: "getHsmpDomesticWasteCostInfoV3", service: "common" },
  { op: "getHsmpMeetingCostInfoV3", service: "common" },
  { op: "getHsmpBuildingInsuranceCostInfoV3", service: "common" },
  { op: "getHsmpOtherCostInfoV3", service: "common" },
  { op: "getHsmpElectricityCostInfoV3", service: "common" },
  { op: "getHsmpWaterCostInfoV3", service: "common" },
  { op: "getHsmpHeatingCostInfoV3", service: "common" },
  { op: "getHsmpHotWaterCostInfoV3", service: "common" },
  { op: "getHsmpGasCostInfoV3", service: "common" },
  { op: "getHsmpPurificationCostInfoV3", service: "common" },
  { op: "getHsmpLaborCostInfoV3", service: "common" },
];

/** phase71c INDIVIDUAL_OPS. These names are also present in COMMON_OPS. */
const PHASE71C_INDIVIDUAL: CatalogOp[] = [
  { op: "getHsmpElectricityCostInfoV3", service: "individual" },
  { op: "getHsmpWaterCostInfoV3", service: "individual" },
  { op: "getHsmpHeatingCostInfoV3", service: "individual" },
  { op: "getHsmpHotWaterCostInfoV3", service: "individual" },
  { op: "getHsmpGasCostInfoV3", service: "individual" },
];

const RESERVE: CatalogOp = {
  op: "getHsmpMonthFeeInfoV3",
  service: "reserve",
};

/** Historical phase26 common ops (identifiers only). */
const PHASE26_COMMON: CatalogOp[] = [
  { op: "getHsmpCleaningCostInfoV3", service: "common" },
  { op: "getHsmpGuardCostInfoV3", service: "common" },
  { op: "getHsmpDisinfectionCostInfoV3", service: "common" },
  { op: "getHsmpElevatorMntncCostInfoV3", service: "common" },
  { op: "getHsmpRepairsCostInfoV3", service: "common" },
  { op: "getHsmpFacilityMntncCostInfoV3", service: "common" },
  { op: "getHsmpSafetyCheckUpCostInfoV3", service: "common" },
  { op: "getHsmpDisasterPreventionCostInfoV3", service: "common" },
  { op: "getHsmpConsignManageFeeInfoV3", service: "common" },
  { op: "getHsmpOfcrkCostInfoV3", service: "common" },
  { op: "getHsmpClothingCostInfoV3", service: "common" },
  { op: "getHsmpEduTraingCostInfoV3", service: "common" },
  { op: "getHsmpVhcleMntncCostInfoV3", service: "common" },
  { op: "getHsmpHomeNetworkMntncCostInfoV3", service: "common" },
  { op: "getHsmpLaborCostInfoV3", service: "common" },
  { op: "getHsmpTaxdueInfoV3", service: "common" },
  { op: "getHsmpEtcCostInfoV3", service: "common" },
];

/** Historical phase26 individual ops (identifiers only). */
const PHASE26_INDIVIDUAL: CatalogOp[] = [
  { op: "getHsmpElectricityCostInfoV3", service: "individual" },
  { op: "getHsmpWaterCostInfoV3", service: "individual" },
  { op: "getHsmpHeatCostInfoV3", service: "individual" },
  { op: "getHsmpHotWaterCostInfoV3", service: "individual" },
  { op: "getHsmpGasRentalFeeInfoV3", service: "individual" },
  { op: "getHsmpWaterPurifierTankFeeInfoV3", service: "individual" },
  { op: "getHsmpDomesticWasteFeeInfoV3", service: "individual" },
  { op: "getHsmpBuildingInsuranceFeeInfoV3", service: "individual" },
  { op: "getHsmpElectionOrpnsInfoV3", service: "individual" },
  { op: "getHsmpMovingInRepresentationMtgInfoV3", service: "individual" },
];

function uniqueOps(rows: readonly CatalogOp[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.op)) continue;
    seen.add(row.op);
    out.push(row.op);
  }
  return out;
}

export const MAIN_CATALOG: readonly CatalogOp[] = [
  ...PHASE71C_COMMON,
  ...PHASE71C_INDIVIDUAL,
  RESERVE,
];

export const REFERENCE_CATALOG: readonly CatalogOp[] = [
  ...PHASE26_COMMON,
  ...PHASE26_INDIVIDUAL,
  RESERVE,
];

export const MAIN_OP_NAMES: readonly string[] = uniqueOps(MAIN_CATALOG);
export const REFERENCE_OP_NAMES: readonly string[] = uniqueOps(REFERENCE_CATALOG);

export function compareOpCatalogs(
  reference: readonly string[] = REFERENCE_OP_NAMES,
  main: readonly string[] = MAIN_OP_NAMES,
): CatalogDiff {
  const referenceSet = new Set(reference);
  const mainSet = new Set(main);
  const shared = reference.filter((op) => mainSet.has(op));
  const reference_only = reference.filter((op) => !mainSet.has(op));
  const main_only = main.filter((op) => !referenceSet.has(op));
  return {
    reference_ops: [...reference],
    main_ops: [...main],
    shared,
    main_only,
    reference_only,
  };
}

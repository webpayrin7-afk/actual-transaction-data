/** Phase 5 unit-type master types (pilot). */

export type UnitTypeClassification =
  | "auto-safe"
  | "group-safe-label-unknown"
  | "ambiguous"
  | "registry-abnormal";

export type SingogaMode = "market_group" | "exclusive_area_fallback";

export type GroupDisplayMode = "label+range" | "range_only" | "exclusive_only";

export type AptComplexClassification = {
  complexKey: string;
  aptNameNorm: string;
  lawdCd: string;
  gu: string;
  classification: UnitTypeClassification;
  singogaMode: SingogaMode;
  labelConfidence: number | null;
  groupConfidenceHigh: boolean;
  sourcePhase: string;
  provenanceJson: string;
  updatedAt: string;
};

export type AptUnitTypeRow = {
  unitTypeKey: string;
  complexKey: string;
  supplyAreaSqm: number | null;
  exclusiveAreaMin: number;
  exclusiveAreaMax: number;
  householdCount: number | null;
  mappingConfidence: string | null;
  exclusiveIncludesPartialCommon: boolean;
  source: string;
};

export type AptPyeongGroupRow = {
  groupKey: string;
  complexKey: string;
  marketLabel: number | null;
  displayMode: GroupDisplayMode;
  supplyAreaMin: number | null;
  supplyAreaMax: number | null;
  exclusiveAreaMin: number;
  exclusiveAreaMax: number;
  householdCount: number | null;
  confidence: string | null;
  groupConfidenceHigh: boolean;
  labelNullReason: string | null;
  sortOrder: number;
  source: string;
};

export type AptUnitTypeGroupLinkRow = {
  unitTypeKey: string;
  groupKey: string;
  complexKey: string;
  isOutlier: boolean;
};

export type UnitTypeMasterBundle = {
  classification: AptComplexClassification;
  unitTypes: AptUnitTypeRow[];
  groups: AptPyeongGroupRow[];
  links: AptUnitTypeGroupLinkRow[];
};

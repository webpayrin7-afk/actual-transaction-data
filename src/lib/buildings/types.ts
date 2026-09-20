export const BUILDING_STATUSES = [
  "EXACT",
  "PARTIAL",
  "AMBIGUOUS",
  "NO_SOURCE",
] as const;
export type BuildingStatus = (typeof BUILDING_STATUSES)[number];

export const DONG_LABEL_STATUSES = [
  "EXACT_DONG_LABEL",
  "MISSING_DONG_LABEL",
] as const;
export type DongLabelStatus = (typeof DONG_LABEL_STATUSES)[number];

export const GEOMETRY_STATUSES = [
  "EXACT_FOOTPRINT",
  "POINT_ONLY",
  "NO_GEOMETRY",
] as const;
export type GeometryStatus = (typeof GEOMETRY_STATUSES)[number];

export const LINK_STATUSES = [
  "EXACT",
  "PARTIAL",
  "AMBIGUOUS",
  "NO_SOURCE",
  "TYPE_VARIANT_AMBIGUOUS",
] as const;
export type LinkStatus = (typeof LINK_STATUSES)[number];

export const PARITY_CLASSES = [
  "PARITY",
  "MINOR_SCOPE_DIFF",
  "PARTIAL_SOURCE",
  "MAJOR_MISMATCH",
  "NO_SOURCE",
] as const;
export type ParityClass = (typeof PARITY_CLASSES)[number];

export type TitleRow = {
  mgmBldrgstPk?: string | number;
  bldNm?: string;
  dongNm?: string;
  mainAtchGbCd?: string;
  mainAtchGbCdNm?: string;
  mainPurpsCd?: string;
  mainPurpsCdNm?: string;
  etcPurps?: string;
  hhldCnt?: string | number;
  hoCnt?: string | number;
  grndFlrCnt?: string | number;
  crtnDay?: string;
  sigunguCd?: string;
  bjdongCd?: string;
  platGbCd?: string;
  bun?: string;
  ji?: string;
};

export type ParcelRef = {
  sigunguCd: string;
  bjdongCd: string;
  platGbCd: string;
  bun: string;
  ji: string;
};

export type ComplexParcel = {
  complexId: string;
  aptName: string;
  sido: string | null;
  sidoCode: string | null;
  lawdCd: string;
  bjdongCd: string;
  jibun: string;
  parcel: ParcelRef | null;
  parcelKey: string | null;
  cadastralPnu: string | null;
  hubPnu: string | null;
  kaptCode: string | null;
  kaptHousehold: number | null;
  priority: number;
};

export type BuildingRecord = {
  buildingId: string;
  complexId: string;
  officialBuildingKey: string;
  mgmBldrgstPk: string | null;
  dongLabel: string | null;
  dongLabelStatus: DongLabelStatus;
  buildingName: string | null;
  mainUsage: string | null;
  mainUsageCode: string | null;
  mainAtchType: string | null;
  residentialFlag: boolean;
  householdCount: number | null;
  floorCount: number | null;
  source: string;
  sourceKey: string;
  sourceAsOf: string;
  status: BuildingStatus;
};

import { buildingIdFromOfficialKey, officialKeyFromTitlePk } from "./identity";
import { officialDongLabel } from "./dong-label";
import { isResidentialBuilding } from "./residential";
import { heightAttrsFromTitle } from "./height";
import type { BuildingRecord, TitleRow } from "./types";

function num(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function str(value: unknown): string | null {
  const s = value == null ? "" : String(value).trim();
  return s || null;
}

export function buildingFromTitleRow(
  row: TitleRow,
  complexId: string,
  sourceAsOf: string,
): BuildingRecord | null {
  const pk = officialKeyFromTitlePk(row.mgmBldrgstPk ?? "");
  if (!pk) return null;
  const dong = officialDongLabel(row.dongNm);
  const residential = isResidentialBuilding(row);
  const hhld = num(row.hhldCnt);
  const ho = num(row.hoCnt);
  const household = hhld && hhld > 0 ? hhld : ho && ho > 0 ? ho : null;
  const height = heightAttrsFromTitle(row);
  return {
    buildingId: buildingIdFromOfficialKey(pk),
    complexId,
    officialBuildingKey: pk,
    mgmBldrgstPk: pk,
    dongLabel: dong.dongLabel,
    dongLabelStatus: dong.status,
    buildingName: str(row.bldNm),
    mainUsage: height.mainUsage ?? str(row.mainPurpsCdNm),
    mainUsageCode: str(row.mainPurpsCd),
    mainAtchType: str(row.mainAtchGbCdNm),
    residentialFlag: residential,
    householdCount: household,
    floorCount: height.groundFloorCount,
    heightM: height.heightM,
    undergroundFloorCount: height.undergroundFloorCount,
    structureType: height.structureType,
    roofType: height.roofType,
    archArea: height.archArea,
    totArea: height.totArea,
    heightStatus: height.heightStatus,
    threeDReadiness: "NO_GEOMETRY",
    source: "BldRgstHubService.getBrTitleInfo",
    sourceKey: pk,
    sourceAsOf,
    status: residential ? "EXACT" : "EXACT",
  };
}

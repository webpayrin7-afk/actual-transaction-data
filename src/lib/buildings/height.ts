import type { HeightStatus } from "./types";

export type { HeightStatus };
export { HEIGHT_STATUSES } from "./types";

export type HeightAttrs = {
  heightM: number | null;
  groundFloorCount: number | null;
  undergroundFloorCount: number | null;
  mainUsage: string | null;
  structureType: string | null;
  roofType: string | null;
  archArea: number | null;
  totArea: number | null;
  heightStatus: HeightStatus;
};

function num(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function str(value: unknown): string | null {
  const s = value == null ? "" : String(value).trim();
  return s || null;
}

/** Official numeric height only. Zero/blank is missing — never floor×assumed height. */
export function officialHeightM(value: unknown): number | null {
  const n = num(value);
  if (n == null || n <= 0) return null;
  if (n > 1000) return null;
  return n;
}

export function heightAttrsFromTitle(row: {
  heit?: unknown;
  grndFlrCnt?: unknown;
  ugrndFlrCnt?: unknown;
  mainPurpsCdNm?: unknown;
  strctCdNm?: unknown;
  etcStrct?: unknown;
  roofCdNm?: unknown;
  etcRoof?: unknown;
  archArea?: unknown;
  totArea?: unknown;
}): HeightAttrs {
  const heightM = officialHeightM(row.heit);
  const groundFloorCount = num(row.grndFlrCnt);
  const usableFloors = groundFloorCount != null && groundFloorCount > 0 ? groundFloorCount : null;
  const heightStatus: HeightStatus = heightM != null
    ? "OFFICIAL_HEIGHT"
    : usableFloors != null
      ? "FLOOR_COUNT_ONLY"
      : "HEIGHT_MISSING";
  return {
    heightM,
    groundFloorCount: usableFloors,
    undergroundFloorCount: num(row.ugrndFlrCnt),
    mainUsage: str(row.mainPurpsCdNm),
    structureType: str(row.strctCdNm) ?? str(row.etcStrct),
    roofType: str(row.roofCdNm) ?? str(row.etcRoof),
    archArea: num(row.archArea),
    totArea: num(row.totArea),
    heightStatus,
  };
}

export function classifyHeightStatus(input: {
  heightM: number | null;
  groundFloorCount: number | null;
}): HeightStatus {
  if (input.heightM != null && input.heightM > 0) return "OFFICIAL_HEIGHT";
  if (input.groundFloorCount != null && input.groundFloorCount > 0) return "FLOOR_COUNT_ONLY";
  return "HEIGHT_MISSING";
}

import type { TitleRow } from "./types";

function num(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function str(value: unknown): string {
  return value == null ? "" : String(value).trim();
}

/** Official 주건축물 vs 부속건축물. Name strings are not used. */
export function isMainBuilding(row: TitleRow): boolean {
  const code = str(row.mainAtchGbCd);
  const name = str(row.mainAtchGbCdNm);
  if (code === "0" || name === "주건축물") return true;
  if (code === "1" || name === "부속건축물") return false;
  return false;
}

/**
 * Residential apartment dong from official usage/type fields only.
 * 공동주택(02*) with household/ho count. Does not inspect building names.
 */
export function isResidentialBuilding(row: TitleRow): boolean {
  if (!isMainBuilding(row)) return false;
  const usageCode = str(row.mainPurpsCd);
  const usageName = str(row.mainPurpsCdNm);
  const collective = usageCode.startsWith("02") || usageName === "공동주택";
  if (!collective) return false;
  return num(row.hhldCnt) > 0 || num(row.hoCnt) > 0;
}

/**
 * Presentation-only HERO compact meta. Does not invent, backfill, or acquire fields.
 */

export type ComplexHeroMetaLines = {
  /** "서울특별시 송파구 잠실동" — shown beside the title (titleSuffix). */
  location: string | null;
  line1: string[];
  line2: string[];
  line3: string[];
};

function positiveNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function trimmed(value: string | null | undefined): string | null {
  const t = value?.trim();
  return t ? t : null;
}

/** Year only. Does not correct incomplete or out-of-range dates. */
export function occupancyYearLabel(
  approvalDate: string | null | undefined,
  buildYear?: number | null,
): string | null {
  const raw = trimmed(approvalDate);
  if (raw) {
    const digits = raw.replace(/\D/g, "");
    if (digits.length >= 4) {
      const year = Number(digits.slice(0, 4));
      if (year >= 1900 && year <= 2100) return `${year}년 입주`;
    }
  }
  if (buildYear != null && Number.isFinite(buildYear)) {
    const year = Math.round(buildYear);
    if (year >= 1900 && year <= 2100) return `${year}년 입주`;
  }
  return null;
}

export function formatHeroPercent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

export function formatParkingPerHouseholdLabel(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `주차 ${text}대/세대`;
}

export function complexHeroMeta(params: {
  sido?: string | null;
  sigungu?: string | null;
  legalDongName?: string | null;
  approvalDate?: string | null;
  buildYear?: number | null;
  householdCount?: number | null;
  buildingCount?: number | null;
  maxFloor?: number | null;
  parkingPerHousehold?: number | null;
  farRatio?: number | null;
  bcrRatio?: number | null;
  heatingType?: string | null;
  locationFallback?: string | null;
}): ComplexHeroMetaLines {
  const location = [params.sido, params.sigungu, params.legalDongName]
    .map((part) => trimmed(part))
    .filter((part): part is string => part != null);
  const fallback = trimmed(params.locationFallback);
  const occupancy = occupancyYearLabel(params.approvalDate, params.buildYear);
  const locationLabel = location.length ? location.join(" ") : fallback;
  const line1 = [
    ...(locationLabel ? [locationLabel] : []),
    ...(occupancy ? [occupancy] : []),
  ];

  const line2: string[] = [];
  const households = positiveNumber(params.householdCount);
  if (households != null) {
    line2.push(`${Math.round(households).toLocaleString("ko-KR")}세대`);
  }
  const buildings = positiveNumber(params.buildingCount);
  if (buildings != null) line2.push(`${Math.round(buildings)}동`);
  const maxFloor = positiveNumber(params.maxFloor);
  if (maxFloor != null) line2.push(`최고 ${Math.round(maxFloor)}층`);
  const parking = positiveNumber(params.parkingPerHousehold);
  if (parking != null) line2.push(formatParkingPerHouseholdLabel(parking));

  const line3: string[] = [];
  const far = positiveNumber(params.farRatio);
  if (far != null) line3.push(`용적률 ${formatHeroPercent(far)}%`);
  const bcr = positiveNumber(params.bcrRatio);
  if (bcr != null) line3.push(`건폐율 ${formatHeroPercent(bcr)}%`);
  const heating = trimmed(params.heatingType);
  if (heating) line3.push(heating);

  // Title suffix drops the 시·도 ("송파구 잠실동"); falls back to the full label.
  const shortLocation = [params.sigungu, params.legalDongName]
    .map((part) => trimmed(part))
    .filter((part): part is string => part != null)
    .join(" ");
  return { location: shortLocation || locationLabel || null, line1, line2, line3 };
}

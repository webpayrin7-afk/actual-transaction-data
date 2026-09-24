/**
 * Phase 1.4B pilot fixture — 잠실엘스 UNIT_EXACT from MOLIT bulk dataset 3073746.
 * Extracted from official 2025 ZIP CSV (no scraping, no nationwide ingest).
 */

export const MOLIT_PUBLIC_PRICE_SOURCE = "MOLIT_PUBLIC_PRICE_BULK" as const;
export const MOLIT_PUBLIC_PRICE_DATASET = "3073746" as const;

/** Existing ZIPLAB area float policy (±0.005㎡). Do not invent new tolerance. */
export const PUBLIC_PRICE_AREA_EPS = 0.005;

export type PublicPriceFixtureUnit = {
  year: number;
  month: number;
  officialPriceDate: string;
  dongRaw: string;
  dongNorm: string;
  hoRaw: string;
  hoNorm: string;
  exclusiveArea: number;
  officialPriceWon: number;
  buildingRegisterPk: string;
  complexCode: string;
  dongCode: string;
  hoCode: string;
};

export type PublicPriceComplexSourceLink = {
  complexId: string;
  nameNorm: string;
  roadAddress: string;
  lotAddress: string;
};

export const JAMSIL_ELS_PUBLIC_PRICE_LINK: PublicPriceComplexSourceLink = {
  complexId: "cx_4c63d9a100973c60",
  nameNorm: "잠실엘스",
  roadAddress: "서울특별시 송파구 올림픽로 99",
  lotAddress: "서울특별시 송파구 잠실동 19",
};

export const JAMSIL_ELS_PUBLIC_PRICE_2025: PublicPriceFixtureUnit = {
  year: 2025,
  month: 1,
  officialPriceDate: "2025-01-01",
  dongRaw: "131",
  dongNorm: "131",
  hoRaw: "101",
  hoNorm: "101",
  exclusiveArea: 84.97,
  officialPriceWon: 1_716_000_000,
  buildingRegisterPk: "10251100214253",
  complexCode: "20107304",
  dongCode: "31",
  hoCode: "5",
};

export const JAMSIL_ELS_PUBLIC_PRICE_YEARS: Readonly<
  Record<number, PublicPriceFixtureUnit>
> = {
  2025: JAMSIL_ELS_PUBLIC_PRICE_2025,
};

export const JAMSIL_ELS_LATEST_BULK_YEAR = 2025;

export function normalizeDongHoToken(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .trim()
    .replace(/동$/u, "")
    .replace(/호$/u, "")
    .replace(/\s+/g, "");
}

export function normalizeComplexName(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw.replace(/\s+/g, "").replace(/아파트$/u, "").trim();
}

export function areaMatchesFixture(
  exclusiveArea: number,
  minSqm?: number | null,
  maxSqm?: number | null,
  exactSqm?: number | null,
): boolean {
  if (exactSqm != null && Number.isFinite(exactSqm)) {
    return Math.abs(exactSqm - exclusiveArea) <= PUBLIC_PRICE_AREA_EPS;
  }
  if (minSqm == null && maxSqm == null) return false;
  const lo = (minSqm ?? maxSqm)! - PUBLIC_PRICE_AREA_EPS;
  const hi = (maxSqm ?? minSqm)! + PUBLIC_PRICE_AREA_EPS;
  return exclusiveArea >= lo && exclusiveArea <= hi;
}

/**
 * Deterministic pilot source-link. Name-only open matching is forbidden;
 * name is accepted only because this record already binds road+lot identity.
 */
export function resolveJamsilElsSourceLink(query: {
  complexId?: string | null;
  complexName?: string | null;
}): PublicPriceComplexSourceLink | null {
  const id = query.complexId?.trim() || "";
  if (id && id === JAMSIL_ELS_PUBLIC_PRICE_LINK.complexId) {
    return JAMSIL_ELS_PUBLIC_PRICE_LINK;
  }
  const name = normalizeComplexName(query.complexName);
  if (name && name === JAMSIL_ELS_PUBLIC_PRICE_LINK.nameNorm) {
    return JAMSIL_ELS_PUBLIC_PRICE_LINK;
  }
  return null;
}

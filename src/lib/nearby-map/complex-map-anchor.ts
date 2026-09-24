/**
 * 2D NAVER map complex anchor resolver (pilot).
 * Priority: NAVER_POI (Local Search) > NAVER_GEOCODE > none.
 * No coordinate hardcoding. No canonical GIS / DB overwrite.
 */

import { geocodeAddressWithNaver } from "@/lib/nearby-map/naver-sdk";
import type { LatLng } from "@/lib/nearby-map/geo";
import { JAMSIL_ELS_MAP_PILOT } from "@/lib/nearby-map/jamsil-els-pilot";

export type ComplexMapAnchorType = "NAVER_POI" | "NAVER_GEOCODE";

export type ComplexMapAnchorResult =
  | {
      ok: true;
      coordinate: LatLng;
      anchorType: ComplexMapAnchorType;
      addressUsed: string;
      matchedAddress: string;
      /** Local Search / Place Search availability for this run */
      poiLookup: "PASS" | "HOLD";
      poiLookupReason: string | null;
    }
  | {
      ok: false;
      reason: string;
      poiLookup: "HOLD";
      poiLookupReason: string;
    };

/** Official Seoul Metro line colors (1–9) for 2D markers / list badges. */
export const SEOUL_METRO_LINE_COLORS: Record<string, string> = {
  "1": "#0052A4",
  "2": "#00A84D",
  "3": "#EF7C1C",
  "4": "#00A5DE",
  "5": "#996CAC",
  "6": "#CD7C2F",
  "7": "#747F00",
  "8": "#E6186C",
  "9": "#BDB092",
};

export function subwayLineColor(lineOrSubcategory: string): string {
  const m = lineOrSubcategory.match(/(\d+)\s*호선/) || lineOrSubcategory.match(/^(\d+)$/);
  const n = m?.[1];
  return (n && SEOUL_METRO_LINE_COLORS[n]) || "#b45309";
}

function isJamsilElsName(aptName: string): boolean {
  const n = aptName.replace(/\s+/g, "");
  return n === "잠실엘스" || n === "잠실엘스아파트";
}

/**
 * Build geocode query candidates. Prefer road, then jibun.
 * For 잠실엘스 pilot, use known road when master.road_address is null
 * (address string only — never a hardcoded lat/lng).
 */
export function buildMapAnchorAddressCandidates(
  aptName: string,
  identity?: {
    roadAddress?: string | null;
    sido?: string | null;
    sigungu?: string | null;
    legalDongName?: string | null;
    jibun?: string | null;
  } | null,
  apiAddress?: string | null,
): string[] {
  const out: string[] = [];
  const push = (s: string | null | undefined) => {
    const t = s?.trim();
    if (t && !out.includes(t)) out.push(t);
  };

  push(identity?.roadAddress);
  if (isJamsilElsName(aptName)) {
    push(JAMSIL_ELS_MAP_PILOT.roadAddress);
  }
  const jibunParts = [
    identity?.sido?.trim(),
    identity?.sigungu?.trim(),
    identity?.legalDongName?.trim(),
    identity?.jibun?.trim(),
  ].filter(Boolean);
  if (jibunParts.length >= 4) push(jibunParts.join(" "));
  if (isJamsilElsName(aptName)) {
    push(JAMSIL_ELS_MAP_PILOT.jibunAddress);
  }
  push(apiAddress);
  return out;
}

/**
 * Resolve 2D map anchor. Local Search credentials are not configured
 * (Maps JS key only) → POI lookup HOLD; use NAVER Geocode.
 */
export async function resolveComplexMapAnchor(opts: {
  aptName: string;
  identity?: {
    roadAddress?: string | null;
    sido?: string | null;
    sigungu?: string | null;
    legalDongName?: string | null;
    jibun?: string | null;
  } | null;
  apiAddress?: string | null;
}): Promise<ComplexMapAnchorResult> {
  const poiLookupReason =
    "NAVER Local/Place Search credential not configured (Maps JS key only)";

  const candidates = buildMapAnchorAddressCandidates(
    opts.aptName,
    opts.identity,
    opts.apiAddress,
  );
  if (candidates.length === 0) {
    return {
      ok: false,
      reason: "no canonical address for map anchor",
      poiLookup: "HOLD",
      poiLookupReason,
    };
  }

  let lastReason = "geocode failed";
  for (const address of candidates) {
    const result = await geocodeAddressWithNaver(address);
    if (result.ok) {
      return {
        ok: true,
        coordinate: result.coordinate,
        anchorType: "NAVER_GEOCODE",
        addressUsed: address,
        matchedAddress: result.matchedAddress,
        poiLookup: "HOLD",
        poiLookupReason,
      };
    }
    lastReason = result.reason;
  }

  return {
    ok: false,
    reason: lastReason,
    poiLookup: "HOLD",
    poiLookupReason,
  };
}

/**
 * Price position V2.2.
 * Same P2 / T0 / S1 / exact-complex contract as V2.1.
 * Region cohort is the supply market-pyeong decade, not an exclusive-area window.
 * V2.1 rows stay stored.
 */
import {
  buildPricePositionV21,
  PRICE_POSITION_V21_AS_OF,
  type PricePositionBodyV21,
} from "./price-position-v21";
import type { ComplexIdentityV2, SupplySalePoint } from "./price-position-v2";

export const PRICE_POSITION_V22_VERSION = "price-position-v2.2";
export const PRICE_POSITION_V22_AS_OF = PRICE_POSITION_V21_AS_OF;

export const METHODOLOGY_FINGERPRINT_V22 =
  "v2.2|P2-median-complex-means|T0-matched-median-change|S1-prefer-previous|region-all-decade-cohorts|complex-exact-market-label|horizons-6M-1Y-2Y-5Y";

export const DECADE_COHORTS_V22 = [
  { key: "10", min: 10, max: 20, label: "10평대" },
  { key: "20", min: 20, max: 30, label: "20평대" },
  { key: "30", min: 30, max: 40, label: "30평대" },
  { key: "40", min: 40, max: 50, label: "40평대" },
  { key: "50", min: 50, max: 60, label: "50평대" },
  { key: "60", min: 60, max: 70, label: "60평대" },
  { key: "70", min: 70, max: 80, label: "70평대" },
  { key: "80", min: 80, max: 90, label: "80평대" },
  { key: "90", min: 90, max: 100, label: "90평대" },
  { key: "100", min: 100, max: 10000, label: "100평+" },
] as const;

export type DecadeCohortV22 = (typeof DECADE_COHORTS_V22)[number];
export type DecadeKeyV22 = DecadeCohortV22["key"];

const LEGACY_BAND_TO_DECADE: Record<string, DecadeKeyV22> = {
  "59": "20",
  "84": "30",
  "114": "40",
};

export function pricePositionV22SnapshotId(asOf: string = PRICE_POSITION_V22_AS_OF): string {
  return `${PRICE_POSITION_V22_VERSION}|${asOf}`;
}

export function decadeCohortForLabel(label: number): DecadeCohortV22 | null {
  return DECADE_COHORTS_V22.find((cohort) => label >= cohort.min && label < cohort.max) ?? null;
}

export function decadeKeyFromLegacyAreaBand(areaBand: string): DecadeKeyV22 | null {
  return LEGACY_BAND_TO_DECADE[areaBand] ?? null;
}

export function decadeCohortByKey(key: string): DecadeCohortV22 | null {
  return DECADE_COHORTS_V22.find((cohort) => cohort.key === key) ?? null;
}

/** Legacy 59/84/114 or an already-canonical decade key. Never infers from exclusive ㎡. */
export function decadeKeyFromAreaBandParam(areaBandRaw: string): DecadeKeyV22 | null {
  return decadeKeyFromLegacyAreaBand(areaBandRaw) ?? decadeCohortByKey(areaBandRaw)?.key ?? null;
}

export type V22RequestResolution =
  | {
      ok: true;
      decadeKey: DecadeKeyV22;
      regionPyeongDecade: string;
      exclusiveArea: number | null;
    }
  | { ok: false; reason: "UNSUPPORTED_AREA" | "AREA_BAND_REQUIRED" | "COHORT_CONFLICT" };

/**
 * Storage cohort for a public read.
 * A resolved market_pyeong_label selects the decade.
 * Legacy area_band is accepted only when it names that same decade.
 * Exclusive area never selects a decade by itself.
 */
export function resolveV22PricePositionRequest(input: {
  areaBandRaw: string;
  exclusiveArea: number | null;
  label:
    | { kind: "exact"; marketPyeongLabel: number }
    | { kind: "ambiguous" }
    | { kind: "missing" }
    | null;
}): V22RequestResolution {
  const fromBand = input.areaBandRaw ? decadeKeyFromAreaBandParam(input.areaBandRaw) : null;
  if (input.exclusiveArea != null && input.label?.kind === "exact") {
    const cohort = decadeCohortForLabel(input.label.marketPyeongLabel);
    if (!cohort) return { ok: false, reason: "UNSUPPORTED_AREA" };
    if (input.areaBandRaw && fromBand !== cohort.key) return { ok: false, reason: "COHORT_CONFLICT" };
    return {
      ok: true,
      decadeKey: cohort.key,
      regionPyeongDecade: cohort.label,
      exclusiveArea: input.exclusiveArea,
    };
  }
  if (input.exclusiveArea != null && !fromBand) {
    return { ok: false, reason: input.areaBandRaw ? "UNSUPPORTED_AREA" : "AREA_BAND_REQUIRED" };
  }
  if (!fromBand) {
    return { ok: false, reason: input.areaBandRaw ? "UNSUPPORTED_AREA" : "AREA_BAND_REQUIRED" };
  }
  const cohort = decadeCohortByKey(fromBand);
  if (!cohort) return { ok: false, reason: "UNSUPPORTED_AREA" };
  return {
    ok: true,
    decadeKey: cohort.key,
    regionPyeongDecade: cohort.label,
    exclusiveArea: input.exclusiveArea,
  };
}

export function buildPricePositionV22(params: {
  cohort: DecadeCohortV22;
  points: readonly SupplySalePoint[];
  identities: ReadonlyMap<string, ComplexIdentityV2>;
  transactionAsOf?: string;
}): { bodies: PricePositionBodyV21[]; ambiguousExcluded: number; exactMapped: number } {
  return buildPricePositionV21({
    areaBand: params.cohort.key,
    points: params.points,
    identities: params.identities,
    transactionAsOf: params.transactionAsOf,
    cohort: params.cohort,
    version: PRICE_POSITION_V22_VERSION,
    methodologyFingerprint: METHODOLOGY_FINGERPRINT_V22,
  });
}

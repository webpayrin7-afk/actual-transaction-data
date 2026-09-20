import { SEOUL_REGIONS } from "../constants/regions-registry";
import type { RankingReader } from "./query";
import { activeAreaBand, type RegionalAreaBandId } from "./area-band";
import { PRICE_POSITION_AS_OF } from "./price-position";
import { PRICE_POSITION_V2_VERSION } from "./price-position-v2";
import { exclusiveCents } from "../unit-type/canonical";
import { marketPyeongLabelInteger } from "../unit-type/supply-label";
import {
  applyExactComplexMarketLabel,
  COMPLEX_PRICE_DEFINITION_V21,
  METHODOLOGY_FINGERPRINT_V21,
  PRICE_COPY_V21,
  PRICE_LEVEL_DEFINITION_V21,
  PRICE_POSITION_V21_AS_OF,
  PRICE_POSITION_V21_VERSION,
  pricePositionV21SnapshotId,
  REGION_TREND_DEFINITION_V21,
  TREND_COPY_V21,
  type PricePositionBodyV21,
} from "./price-position-v21";

/**
 * Public pointer is V2.1 only after publication.
 * Missing V2.1 is unavailable. V2 rows stay stored and are not a fallback.
 */
export const PRICE_POSITION_PUBLIC_VERSION = PRICE_POSITION_V21_VERSION;
export const PRICE_POSITION_PUBLIC_AS_OF = PRICE_POSITION_V21_AS_OF;

export function seoulGuName(lawdCd: string): string | null {
  for (const region of SEOUL_REGIONS) {
    if (region.lawdCodes.includes(lawdCd)) return region.name;
  }
  return null;
}

export function seoulLawdCodes(): string[] {
  return SEOUL_REGIONS.flatMap((region) => region.lawdCodes);
}

export type SelectedMarketLabelResolution =
  | { kind: "exact"; marketPyeongLabel: number }
  | { kind: "ambiguous" }
  | { kind: "missing" };

/**
 * Resolve exclusive_area → market_pyeong_label for COMPLEX scope overlay.
 * Deterministic when EXACT_SINGLE or all supply variants share one integer label.
 * Does not invent a label when multiple market labels are possible.
 */
export async function resolveSelectedMarketPyeongLabel(
  db: RankingReader,
  query: { complexId: string; exclusiveArea: number },
): Promise<SelectedMarketLabelResolution> {
  const cents = exclusiveCents(query.exclusiveArea);
  if (cents < 0) return { kind: "missing" };
  const rows = await db.execute({
    sql: `SELECT supply_area, status
          FROM apt_canonical_unit_types
          WHERE complex_id = ? AND exclusive_cents = ? AND supply_cents >= 0
            AND status IN ('EXACT_SINGLE', 'AMBIGUOUS_MULTI')`,
    args: [query.complexId, cents],
  });
  if (!rows.rows.length) return { kind: "missing" };

  const exact = rows.rows.filter((row) => String(row.status) === "EXACT_SINGLE");
  if (exact.length === 1) {
    const label = marketPyeongLabelInteger(Number(exact[0]!.supply_area));
    if (label == null) return { kind: "missing" };
    return { kind: "exact", marketPyeongLabel: label };
  }

  const labels = [
    ...new Set(
      rows.rows
        .map((row) => marketPyeongLabelInteger(Number(row.supply_area)))
        .filter((label): label is number => label != null),
    ),
  ];
  if (labels.length === 1) return { kind: "exact", marketPyeongLabel: labels[0]! };
  if (labels.length > 1) return { kind: "ambiguous" };
  return { kind: "missing" };
}

export async function readComplexPricePosition(
  db: RankingReader,
  query: { complexId: string; areaBand: RegionalAreaBandId; exclusiveArea?: number | null },
): Promise<
  | { kind: "missing" }
  | { kind: "outside-seoul" }
  | { kind: "body"; body: PricePositionBodyV21 }
> {
  const v21 = await db.execute({
    sql: `SELECT payload_json
          FROM complex_region_price_position
          WHERE snapshot_id = ? AND complex_id = ? AND area_band = ?`,
    args: [pricePositionV21SnapshotId(), query.complexId, query.areaBand],
  });
  if (v21.rows[0]?.payload_json) {
    let body = JSON.parse(String(v21.rows[0].payload_json)) as PricePositionBodyV21;
    activeAreaBand(body.areaBand);
    // Backward-compatible defaults for payloads written before exact-label fields.
    if (body.complexExactByMarketLabel == null) body.complexExactByMarketLabel = {};
    if (body.selectedMarketPyeongLabel === undefined) body.selectedMarketPyeongLabel = null;
    if (body.complexScopeBasis == null) body.complexScopeBasis = "decade_cohort";

    if (query.exclusiveArea != null && Number.isFinite(query.exclusiveArea)) {
      const resolved = await resolveSelectedMarketPyeongLabel(db, {
        complexId: query.complexId,
        exclusiveArea: query.exclusiveArea,
      });
      if (resolved.kind === "exact") {
        body = applyExactComplexMarketLabel(body, resolved.marketPyeongLabel, "exact");
      } else if (resolved.kind === "ambiguous") {
        body = applyExactComplexMarketLabel(body, null, "ambiguous");
      } else {
        body = applyExactComplexMarketLabel(body, null, "missing");
      }
    }
    return { kind: "body", body };
  }

  const master = await db.execute({
    sql: `SELECT lawd_cd, legal_dong_name, apt_name
          FROM apt_complex_master WHERE complex_id = ?`,
    args: [query.complexId],
  });
  const row = master.rows[0];
  if (!row) return { kind: "missing" };
  const lawd = String(row.lawd_cd);
  if (!seoulGuName(lawd)) return { kind: "outside-seoul" };
  const unavailable: PricePositionBodyV21 = {
    status: "unavailable",
    version: PRICE_POSITION_V21_VERSION,
    complexId: query.complexId,
    aptName: row.apt_name == null ? null : String(row.apt_name),
    areaBand: query.areaBand,
    supplyPyeongCohort: "",
    areaBandVersion: "",
    transactionAsOf: PRICE_POSITION_PUBLIC_AS_OF,
    referenceMonth: null,
    selectedMarketPyeongLabel: null,
    complexScopeBasis: "unavailable",
    changeUnit: "percentage_points",
    priceLevelDefinition: PRICE_LEVEL_DEFINITION_V21,
    complexPriceDefinition: COMPLEX_PRICE_DEFINITION_V21,
    complexTrendDefinition: "calendar_month_mean_deal_per_market_pyeong_label",
    regionTrendDefinition: REGION_TREND_DEFINITION_V21,
    areaBasis: "SUPPLY_PYEONG_LABEL",
    pyeongLabelVersion: "canonical-supply-pyeong-round-v1",
    methodologyFingerprint: METHODOLOGY_FINGERPRINT_V21,
    methodologyCopy: {
      price: PRICE_COPY_V21,
      trend: TREND_COPY_V21,
    },
    priceLevel: [],
    trends: { "6M": [], "1Y": [], "2Y": [], "5Y": [] },
    complexExactByMarketLabel: {},
    maxAvailableValue: { priceLevel: null, trends: { "6M": null, "1Y": null, "2Y": null, "5Y": null } },
    coverage: { exactMappedTrades: 0, ambiguousExcluded: 0 },
  };
  return { kind: "body", body: unavailable };
}

export { PRICE_POSITION_AS_OF, PRICE_POSITION_V2_VERSION, PRICE_POSITION_V21_VERSION };

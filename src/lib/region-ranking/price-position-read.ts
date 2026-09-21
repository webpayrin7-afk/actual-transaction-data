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
  PRICE_COPY_V21,
  PRICE_LEVEL_DEFINITION_V21,
  PRICE_POSITION_V21_AS_OF,
  PRICE_POSITION_V21_VERSION,
  TREND_COPY_V21,
  type PricePositionBodyV21,
} from "./price-position-v21";
import {
  METHODOLOGY_FINGERPRINT_V23,
  PRICE_POSITION_V23_VERSION,
  pricePositionStorageBand,
  pricePositionV23SnapshotId,
  REGION_TREND_DEFINITION_V23,
} from "./price-position-v23";
import { decadeCohortByKey } from "./ranking-v3";

/**
 * Public read pointer is V2.3.
 * Missing V2.3 is unavailable. V2 / V2.1 / V2.2 rows stay stored and are never a fallback.
 */
export const PRICE_POSITION_PUBLIC_VERSION = PRICE_POSITION_V23_VERSION;
export const PRICE_POSITION_PUBLIC_AS_OF = PRICE_POSITION_V21_AS_OF;
const PUBLIC_SNAPSHOT_ID = pricePositionV23SnapshotId();

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
  query: {
    complexId: string;
    areaBand: RegionalAreaBandId | string;
    exclusiveArea?: number | null;
    marketPyeongLabel?: number | null;
  },
): Promise<
  | { kind: "missing" }
  | { kind: "outside-seoul" }
  | { kind: "body"; body: PricePositionBodyV21 }
> {
  const storageBand = pricePositionStorageBand(query.areaBand);
  const published = await db.execute({
    sql: `SELECT payload_json
          FROM complex_region_price_position
          WHERE snapshot_id = ? AND complex_id = ? AND area_band = ?`,
    args: [PUBLIC_SNAPSHOT_ID, query.complexId, storageBand],
  });
  if (published.rows[0]?.payload_json) {
    let body = JSON.parse(String(published.rows[0].payload_json)) as PricePositionBodyV21;
    if (body.areaBand === "59" || body.areaBand === "84" || body.areaBand === "114") {
      activeAreaBand(body.areaBand);
    }
    // Backward-compatible defaults for payloads written before exact-label fields.
    if (body.complexExactByMarketLabel == null) body.complexExactByMarketLabel = {};
    if (body.selectedMarketPyeongLabel === undefined) body.selectedMarketPyeongLabel = null;
    if (body.complexScopeBasis == null) body.complexScopeBasis = "decade_cohort";
    body.version = PRICE_POSITION_V23_VERSION as typeof body.version;
    (body as { snapshotId?: string }).snapshotId = PUBLIC_SNAPSHOT_ID;

    const selectedLabel =
      query.marketPyeongLabel != null &&
      Number.isFinite(query.marketPyeongLabel) &&
      query.marketPyeongLabel > 0
        ? Math.round(query.marketPyeongLabel)
        : null;
    if (selectedLabel != null) {
      body = applyExactComplexMarketLabel(body, selectedLabel, "exact");
      body.version = PRICE_POSITION_V23_VERSION as typeof body.version;
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
  const cohort = decadeCohortByKey(storageBand);
  const unavailable = {
    status: "unavailable",
    version: PRICE_POSITION_V23_VERSION,
    snapshotId: PUBLIC_SNAPSHOT_ID,
    complexId: query.complexId,
    aptName: row.apt_name == null ? null : String(row.apt_name),
    areaBand: storageBand,
    supplyPyeongCohort: cohort?.label ?? "",
    areaBandVersion: "",
    transactionAsOf: PRICE_POSITION_PUBLIC_AS_OF,
    referenceMonth: null,
    selectedMarketPyeongLabel: null,
    complexScopeBasis: "unavailable",
    changeUnit: "percentage_points",
    priceLevelDefinition: PRICE_LEVEL_DEFINITION_V21,
    complexPriceDefinition: COMPLEX_PRICE_DEFINITION_V21,
    complexTrendDefinition: "calendar_month_mean_deal_per_market_pyeong_label",
    regionTrendDefinition: REGION_TREND_DEFINITION_V23,
    areaBasis: "SUPPLY_PYEONG_LABEL",
    pyeongLabelVersion: "canonical-supply-pyeong-round-v1",
    methodologyFingerprint: METHODOLOGY_FINGERPRINT_V23,
    methodologyCopy: {
      price: PRICE_COPY_V21,
      trend: TREND_COPY_V21,
    },
    priceLevel: [],
    trends: { "6M": [], "1Y": [], "2Y": [], "5Y": [] },
    complexExactByMarketLabel: {},
    maxAvailableValue: { priceLevel: null, trends: { "6M": null, "1Y": null, "2Y": null, "5Y": null } },
    coverage: { exactMappedTrades: 0, ambiguousExcluded: 0 },
  } as unknown as PricePositionBodyV21;
  return { kind: "body", body: unavailable };
}

export { PRICE_POSITION_AS_OF, PRICE_POSITION_V2_VERSION, PRICE_POSITION_V21_VERSION, PRICE_POSITION_V23_VERSION };

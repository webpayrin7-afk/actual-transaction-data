import { SEOUL_REGIONS } from "../constants/regions-registry";
import type { RankingReader } from "./query";
import { activeAreaBand, type RegionalAreaBandId } from "./area-band";
import {
  PRICE_POSITION_AS_OF,
} from "./price-position";
import {
  PRICE_POSITION_V2_AS_OF,
  PRICE_POSITION_V2_VERSION,
  pricePositionV2SnapshotId,
  type PricePositionBodyV2,
} from "./price-position-v2";

/**
 * Public pointer is V2 only after publication.
 * Missing V2 is unavailable. V1 rows stay stored and are not a fallback.
 */
export const PRICE_POSITION_PUBLIC_VERSION = PRICE_POSITION_V2_VERSION;
export const PRICE_POSITION_PUBLIC_AS_OF = PRICE_POSITION_V2_AS_OF;

export function seoulGuName(lawdCd: string): string | null {
  for (const region of SEOUL_REGIONS) {
    if (region.lawdCodes.includes(lawdCd)) return region.name;
  }
  return null;
}

export function seoulLawdCodes(): string[] {
  return SEOUL_REGIONS.flatMap((region) => region.lawdCodes);
}

export async function readComplexPricePosition(
  db: RankingReader,
  query: { complexId: string; areaBand: RegionalAreaBandId },
): Promise<
  | { kind: "missing" }
  | { kind: "outside-seoul" }
  | { kind: "body"; body: PricePositionBody | PricePositionBodyV2 }
> {
  // Prefer V2 only when materialized for this key.
  const v2 = await db.execute({
    sql: `SELECT payload_json
          FROM complex_region_price_position
          WHERE snapshot_id = ? AND complex_id = ? AND area_band = ?`,
    args: [pricePositionV2SnapshotId(), query.complexId, query.areaBand],
  });
  if (v2.rows[0]?.payload_json) {
    const body = JSON.parse(String(v2.rows[0].payload_json)) as PricePositionBodyV2;
    activeAreaBand(body.areaBand);
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
  const unavailable: PricePositionBodyV2 = {
    status: "unavailable",
    version: PRICE_POSITION_V2_VERSION,
    complexId: query.complexId,
    aptName: row.apt_name == null ? null : String(row.apt_name),
    areaBand: query.areaBand,
    supplyPyeongCohort: "",
    areaBandVersion: "",
    transactionAsOf: PRICE_POSITION_PUBLIC_AS_OF,
    referenceMonth: null,
    changeUnit: "percentage_points",
    priceLevelDefinition: "reference_month_mean_deal_per_market_pyeong_label",
    complexTrendDefinition: "calendar_month_mean_deal_amount",
    regionTrendDefinition: "median_of_matched_complex_changes_same_cohort",
    areaBasis: "SUPPLY_PYEONG_LABEL",
    pyeongLabelVersion: "canonical-supply-pyeong-round-v1",
    priceLevel: [],
    trends: { "3M": [], "6M": [], "1Y": [], "3Y": [] },
    maxAvailableValue: { priceLevel: null, trends: { "3M": null, "6M": null, "1Y": null, "3Y": null } },
    coverage: { exactMappedTrades: 0, ambiguousExcluded: 0 },
  };
  return { kind: "body", body: unavailable };
}

export { PRICE_POSITION_AS_OF, PRICE_POSITION_V2_VERSION };

import { SEOUL_REGIONS } from "../constants/regions-registry";
import type { RankingReader } from "./query";
import { activeAreaBand, type RegionalAreaBandId } from "./area-band";
import { PRICE_POSITION_AS_OF } from "./price-position";
import { PRICE_POSITION_V2_VERSION } from "./price-position-v2";
import {
  PRICE_POSITION_V21_AS_OF,
  PRICE_POSITION_V21_VERSION,
  pricePositionV21SnapshotId,
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

export async function readComplexPricePosition(
  db: RankingReader,
  query: { complexId: string; areaBand: RegionalAreaBandId },
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
    const body = JSON.parse(String(v21.rows[0].payload_json)) as PricePositionBodyV21;
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
    changeUnit: "percentage_points",
    priceLevelDefinition: "median_of_complex_reference_month_mean_deal_per_market_pyeong_label",
    complexPriceDefinition: "reference_month_mean_deal_per_market_pyeong_label",
    complexTrendDefinition: "calendar_month_mean_deal_per_market_pyeong_label",
    regionTrendDefinition: "median_of_matched_complex_changes_same_cohort_s1",
    areaBasis: "SUPPLY_PYEONG_LABEL",
    pyeongLabelVersion: "canonical-supply-pyeong-round-v1",
    methodologyFingerprint:
      "v2.1|P2-median-complex-means|T0-matched-median-change|S1-prefer-previous|cohort-supply-pyeong-decade|horizons-6M-1Y-2Y-5Y",
    methodologyCopy: {
      price: "선택한 평형대의 단지별 실거래 가격을 기준으로 지역 가격 수준을 비교합니다.",
      trend: "동일한 단지의 현재와 과거 실거래 가격을 비교해 지역 가격 변화를 계산합니다.",
    },
    priceLevel: [],
    trends: { "6M": [], "1Y": [], "2Y": [], "5Y": [] },
    maxAvailableValue: { priceLevel: null, trends: { "6M": null, "1Y": null, "2Y": null, "5Y": null } },
    coverage: { exactMappedTrades: 0, ambiguousExcluded: 0 },
  };
  return { kind: "body", body: unavailable };
}

export { PRICE_POSITION_AS_OF, PRICE_POSITION_V2_VERSION, PRICE_POSITION_V21_VERSION };

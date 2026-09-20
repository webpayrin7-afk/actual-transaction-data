import { SEOUL_REGIONS } from "../constants/regions-registry";
import type { RankingReader } from "./query";
import { activeAreaBand, type RegionalAreaBandId } from "./area-band";
import {
  assemblePricePosition,
  pricePositionSnapshotId,
  PRICE_POSITION_AS_OF,
  type PricePositionBody,
  type PriceScope,
} from "./price-position";
import {
  PRICE_POSITION_V2_VERSION,
  pricePositionV2SnapshotId,
  type PricePositionBodyV2,
} from "./price-position-v2";

/**
 * Public pointer stays on V1 until V2 is materialized after Seoul gate PASS.
 * When V2 rows exist for the requested key, prefer V2 (no silent V1 mix-in).
 */
export const PRICE_POSITION_PUBLIC_VERSION = "price-position-v1";
export const PRICE_POSITION_PUBLIC_AS_OF = PRICE_POSITION_AS_OF;

export function seoulGuName(lawdCd: string): string | null {
  for (const region of SEOUL_REGIONS) {
    if (region.lawdCodes.includes(lawdCd)) return region.name;
  }
  return null;
}

export function seoulLawdCodes(): string[] {
  return SEOUL_REGIONS.flatMap((region) => region.lawdCodes);
}

function labelsFor(dongName: string | null, lawdCd: string): Record<PriceScope, string> {
  return {
    COMPLEX: "이 단지",
    DONG: dongName || "동",
    GU: seoulGuName(lawdCd) || "구",
    SEOUL: "서울",
  };
}

function skeleton(params: {
  complexId: string;
  aptName: string | null;
  areaBand: RegionalAreaBandId;
  dongName: string | null;
  lawdCd: string;
}): PricePositionBody {
  return assemblePricePosition({
    complexId: params.complexId,
    aptName: params.aptName,
    areaBand: params.areaBand,
    referenceMonth: null,
    labels: labelsFor(params.dongName, params.lawdCd),
    buckets: [],
  });
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

  const snapshotId = pricePositionSnapshotId();
  const stored = await db.execute({
    sql: `SELECT payload_json
          FROM complex_region_price_position
          WHERE snapshot_id = ? AND complex_id = ? AND area_band = ?`,
    args: [snapshotId, query.complexId, query.areaBand],
  });
  const payload = stored.rows[0]?.payload_json;
  if (payload != null && String(payload).length > 0) {
    const body = JSON.parse(String(payload)) as PricePositionBody;
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
  return {
    kind: "body",
    body: skeleton({
      complexId: query.complexId,
      aptName: row.apt_name == null ? null : String(row.apt_name),
      areaBand: query.areaBand,
      dongName: row.legal_dong_name == null ? null : String(row.legal_dong_name),
      lawdCd: lawd,
    }),
  };
}

export { PRICE_POSITION_AS_OF, PRICE_POSITION_V2_VERSION };

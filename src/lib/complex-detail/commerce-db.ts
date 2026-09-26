/**
 * National commerce snapshot reader (complex_commerce_snapshots + commerce_point_cells).
 * Read-only. Produces the same CommerceSnapshot shape as the 잠실엘스 pilot fixture.
 *
 * Tables: src/lib/db/migrations/20260924_complex_commerce_snapshots.sql
 * Builder: scripts/commerce/materialize-complex-commerce.py (query_cells / encode_cell mirror)
 */
import type { Client } from "@libsql/client";
import type {
  CommerceCompositionKey,
  CommerceFacilities,
  CommerceMapPoints,
  CommerceSnapshot,
} from "@/lib/complex-detail/commerce-snapshot";

/** commerce_bucket_v1 — composition_json order. Index 0..5 == map categoryIdx. */
export const COMMERCE_BUCKET_ORDER_V1: CommerceCompositionKey[] = [
  "음식/외식",
  "쇼핑/소매",
  "생활서비스",
  "교육",
  "여가/체육",
  "의료/건강",
  "기타",
];

/** commerce_facility_v1 — facilities_json order. */
export const COMMERCE_FACILITY_ORDER_V1: Array<keyof CommerceFacilities> = [
  "병원/의원",
  "약국",
  "편의점",
  "마트/슈퍼",
  "카페",
  "음식점",
  "미용",
  "학원",
  "체육",
];

export const COMMERCE_DB_RADII = [500, 1000] as const;
export type CommerceDbRadius = (typeof COMMERCE_DB_RADII)[number];

const EARTH_R = 6371000;

export function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Grid cells overlapping the radius bbox. Mirror of query_cells() in the materializer. */
export function commerceQueryCells(
  lat: number,
  lng: number,
  radiusM = 1000,
): number[] {
  const dlat = (radiusM + 5) / 110000;
  const dlng = (radiusM + 5) / (110000 * Math.cos((lat * Math.PI) / 180));
  const la0 = Math.floor((lat - dlat) * 100);
  const la1 = Math.floor((lat + dlat) * 100);
  const ln0 = Math.floor((lng - dlng) * 100);
  const ln1 = Math.floor((lng + dlng) * 100);
  const out: number[] = [];
  for (let a = la0; a <= la1; a++) {
    for (let b = ln0; b <= ln1; b++) out.push(a * 100000 + b);
  }
  return out;
}

/**
 * Decode stored cells → meter-offset point cloud within radius of the center.
 * points_json: flattened [dLatE6, dLngE6, bucketIdx, ...] relative to the cell corner.
 */
export function decodeCommerceMapPoints(
  cells: Array<{ cellKey: number; pointsJson: string }>,
  center: { lat: number; lng: number },
  radiusM: number,
): CommerceMapPoints {
  const offsetsM: number[] = [];
  const categoryIdx: number[] = [];
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos((center.lat * Math.PI) / 180);
  for (const { cellKey, pointsJson } of cells) {
    const lat100 = Math.floor(cellKey / 100000);
    const lng100 = cellKey - lat100 * 100000;
    const vals = JSON.parse(pointsJson) as number[];
    for (let i = 0; i + 2 < vals.length; i += 3) {
      const lat = (lat100 * 10000 + vals[i]) / 1e6;
      const lng = (lng100 * 10000 + vals[i + 1]) / 1e6;
      if (haversineMeters(center.lat, center.lng, lat, lng) > radiusM) continue;
      offsetsM.push(
        Math.round((lng - center.lng) * mPerDegLng),
        Math.round((lat - center.lat) * mPerDegLat),
      );
      categoryIdx.push(vals[i + 2]);
    }
  }
  return {
    originLat: center.lat,
    originLng: center.lng,
    encoding: "meter-offset-int-v1",
    pointCount: categoryIdx.length,
    offsetsM,
    categoryIdx,
    categoryEncoding: "presentation-bucket-idx-v1",
  };
}

/** "SEMAS_2026Q2" → "2026Q2" / "2026년 2분기". */
export function commercePeriodFromSourceVersion(sourceVersion: string): {
  period: string;
  label: string;
} {
  const m = /(\d{4})Q([1-4])/.exec(sourceVersion);
  if (!m) return { period: sourceVersion, label: sourceVersion };
  return { period: `${m[1]}Q${m[2]}`, label: `${m[1]}년 ${m[2]}분기` };
}

function toIntArray(json: string, length: number): number[] {
  const parsed = JSON.parse(json) as unknown;
  if (!Array.isArray(parsed) || parsed.length !== length) {
    throw new Error("commerce snapshot array shape mismatch");
  }
  return parsed.map((v) => Number(v));
}

export async function readCommerceSnapshot(
  db: Client,
  complexId: string,
  radiusM: CommerceDbRadius = 1000,
  opts: { withMapPoints?: boolean } = {},
): Promise<CommerceSnapshot | null> {
  const pub = await db.execute(
    `SELECT source_version, snapshot_version, population_rule_version, source_as_of
     FROM complex_commerce_publications
     WHERE is_current = 1
     ORDER BY built_at DESC
     LIMIT 1`,
  );
  const p = pub.rows[0];
  if (!p) return null;
  const sourceVersion = String(p.source_version);
  const snapshotVersion = String(p.snapshot_version);

  const rs = await db.execute({
    sql: `SELECT p0_total, p2_total, composition_json, facilities_json,
                 center_lat, center_lng, coordinate_source, population_rule_version,
                 source_as_of, built_at
          FROM complex_commerce_snapshots
          WHERE complex_id = ? AND source_version = ? AND snapshot_version = ? AND radius_m = ?`,
    args: [complexId, sourceVersion, snapshotVersion, radiusM],
  });
  const row = rs.rows[0];
  if (!row) return null;

  const p2Total = Number(row.p2_total);
  const comp = toIntArray(String(row.composition_json), COMMERCE_BUCKET_ORDER_V1.length);
  const fac = toIntArray(String(row.facilities_json), COMMERCE_FACILITY_ORDER_V1.length);
  const composition = Object.fromEntries(
    COMMERCE_BUCKET_ORDER_V1.map((key, i) => [
      key,
      {
        count: comp[i],
        share: p2Total ? Number(((comp[i] / p2Total) * 100).toFixed(2)) : 0,
      },
    ]),
  ) as CommerceSnapshot["composition"];
  const facilities = Object.fromEntries(
    COMMERCE_FACILITY_ORDER_V1.map((key, i) => [key, fac[i]]),
  ) as CommerceFacilities;

  // 지도 중심은 현재 단지 좌표(complex_map_anchor, 도로명 기준 재측정)를 쓴다 — 스냅샷에 저장된 center는
  // 재측정 전 값이라 단지 마커·주변 역과 어긋난다. 점은 절대 좌표 셀에서 다시 풀므로 새 중심 기준으로 맞는다.
  let center = { lat: Number(row.center_lat), lng: Number(row.center_lng) };
  try {
    const a = await db.execute({
      sql: `SELECT lat, lng FROM complex_map_anchor WHERE complex_id = ? LIMIT 1`,
      args: [complexId],
    });
    const hit = a.rows[0];
    if (hit && Number.isFinite(Number(hit.lat)) && Number.isFinite(Number(hit.lng))) {
      center = { lat: Number(hit.lat), lng: Number(hit.lng) };
    }
  } catch {
    /* anchor table optional */
  }
  let mapPoints: CommerceMapPoints | null = null;
  if (opts.withMapPoints !== false) {
    const keys = commerceQueryCells(center.lat, center.lng, radiusM);
    const cellRs = await db.execute({
      sql: `SELECT cell_key, points_json FROM commerce_point_cells
            WHERE source_version = ? AND snapshot_version = ?
              AND cell_key IN (${keys.map(() => "?").join(",")})`,
      args: [sourceVersion, snapshotVersion, ...keys],
    });
    mapPoints = decodeCommerceMapPoints(
      cellRs.rows.map((r) => ({
        cellKey: Number(r.cell_key),
        pointsJson: String(r.points_json),
      })),
      center,
      radiusM,
    );
  }

  const { period, label } = commercePeriodFromSourceVersion(sourceVersion);
  return {
    complexId,
    complexName: "",
    source: "semas",
    sourcePeriod: period,
    sourcePeriodLabel: label,
    radiusM,
    distanceMetric: "straight-line",
    populationVersion: "daily_commerce_core_v1",
    populationRuleVersion: String(row.population_rule_version),
    p0Total: Number(row.p0_total),
    p2Total,
    composition,
    topCategories: [],
    facilities,
    mapPoints,
    sourceDate: String(row.source_as_of),
    computedAt: String(row.built_at),
    coordinateSource: String(row.coordinate_source),
  };
}

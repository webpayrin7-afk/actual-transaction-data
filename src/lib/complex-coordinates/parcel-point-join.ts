/**
 * Exact PNU join against a bulk parcel representative-point table.
 * Does not pick the first row when a PNU is duplicated with different coordinates,
 * and does not pick the first PNU when a complex has several parcels.
 */

export type ParcelPointRow = {
  pnu: string;
  lat: number;
  lng: number;
  sourceDate: string;
  method: string;
};

export type IndexedParcel = {
  pnu: string;
  lat: number;
  lng: number;
  sourceDate: string;
  method: string;
  rowCount: number;
  status: "UNIQUE" | "DUPLICATE_IDENTICAL" | "DUPLICATE_CONFLICT";
};

const COORD_EPS = 1e-8;

export function indexParcelPoints(rows: ParcelPointRow[]): Map<string, IndexedParcel> {
  const map = new Map<string, IndexedParcel>();
  for (const row of rows) {
    const cur = map.get(row.pnu);
    if (!cur) {
      map.set(row.pnu, {
        pnu: row.pnu,
        lat: row.lat,
        lng: row.lng,
        sourceDate: row.sourceDate,
        method: row.method,
        rowCount: 1,
        status: "UNIQUE",
      });
      continue;
    }
    cur.rowCount += 1;
    const same =
      Math.abs(cur.lat - row.lat) < COORD_EPS &&
      Math.abs(cur.lng - row.lng) < COORD_EPS &&
      cur.method === row.method &&
      cur.sourceDate === row.sourceDate;
    if (!same || cur.status === "DUPLICATE_CONFLICT") {
      cur.status = "DUPLICATE_CONFLICT";
      cur.lat = Number.NaN;
      cur.lng = Number.NaN;
      cur.method = "";
      cur.sourceDate = "";
    } else if (cur.status === "UNIQUE") {
      cur.status = "DUPLICATE_IDENTICAL";
    }
  }
  return map;
}

export type ExactJoinStatus =
  | "EXACT_PNU"
  | "MULTI_PARCEL_IDENTICAL"
  | "MULTI_PARCEL"
  | "PNU_NOT_FOUND"
  | "DUPLICATE_GEOMETRY"
  | "INVALID_GEOMETRY"
  | "NO_PNU";

export type ExactJoinResult = {
  status: ExactJoinStatus;
  lat: number | null;
  lng: number | null;
  spatialPnu: string | null;
  spatialPnus: string[];
};

function usable(hit: IndexedParcel | undefined): hit is IndexedParcel {
  return Boolean(
    hit &&
      hit.status !== "DUPLICATE_CONFLICT" &&
      Number.isFinite(hit.lat) &&
      Number.isFinite(hit.lng),
  );
}

/**
 * Join one complex's official full PNU list to the parcel index.
 * Multiple PNUs are resolved only when every parcel point is the same coordinate.
 */
export function joinExactPnu(
  fullPnus: string[],
  index: Map<string, IndexedParcel>,
  validPoint: (lat: number, lng: number) => boolean,
): ExactJoinResult {
  const pnus = [...new Set(fullPnus)];
  if (pnus.length === 0) {
    return { status: "NO_PNU", lat: null, lng: null, spatialPnu: null, spatialPnus: [] };
  }
  const hits = pnus.map((pnu) => index.get(pnu));
  if (hits.some((h) => h?.status === "DUPLICATE_CONFLICT")) {
    return {
      status: "DUPLICATE_GEOMETRY",
      lat: null,
      lng: null,
      spatialPnu: null,
      spatialPnus: pnus.filter((pnu) => index.get(pnu)?.status === "DUPLICATE_CONFLICT"),
    };
  }
  if (pnus.length > 1) {
    if (!hits.every((h) => usable(h))) {
      return { status: "MULTI_PARCEL", lat: null, lng: null, spatialPnu: null, spatialPnus: pnus };
    }
    const first = hits[0]!;
    const identical = hits.every(
      (h) =>
        Math.abs(h!.lat - first.lat) < COORD_EPS && Math.abs(h!.lng - first.lng) < COORD_EPS,
    );
    if (!identical || !validPoint(first.lat, first.lng)) {
      return { status: "MULTI_PARCEL", lat: null, lng: null, spatialPnu: null, spatialPnus: pnus };
    }
    return {
      status: "MULTI_PARCEL_IDENTICAL",
      lat: first.lat,
      lng: first.lng,
      spatialPnu: pnus.slice().sort()[0] ?? null,
      spatialPnus: pnus.slice().sort(),
    };
  }
  const hit = hits[0];
  if (!hit) {
    return { status: "PNU_NOT_FOUND", lat: null, lng: null, spatialPnu: null, spatialPnus: [] };
  }
  if (!usable(hit) || !validPoint(hit.lat, hit.lng)) {
    return { status: "INVALID_GEOMETRY", lat: null, lng: null, spatialPnu: hit.pnu, spatialPnus: [hit.pnu] };
  }
  return {
    status: "EXACT_PNU",
    lat: hit.lat,
    lng: hit.lng,
    spatialPnu: hit.pnu,
    spatialPnus: [hit.pnu],
  };
}

export function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  const w = pos - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

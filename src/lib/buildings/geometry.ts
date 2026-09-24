import { createHash } from "node:crypto";

export type LngLat = [number, number];

export type GeoJsonPolygon = {
  type: "Polygon";
  coordinates: LngLat[][];
};

export type GeoJsonMultiPolygon = {
  type: "MultiPolygon";
  coordinates: LngLat[][][];
};

export type Footprint = GeoJsonPolygon | GeoJsonMultiPolygon;

export type GeometryQuality = {
  valid: boolean;
  empty: boolean;
  selfIntersecting: boolean;
  repaired: boolean;
  repairStatus: "NONE" | "REPAIRED" | "UNREPAIRABLE";
  areaM2: number | null;
  absurdArea: boolean;
  impossibleBounds: boolean;
  reason: string;
};

export const CANONICAL_CRS = "EPSG:4326";

const KOREA = { minLng: 124.0, maxLng: 132.5, minLat: 32.5, maxLat: 39.8 };
const MIN_AREA_M2 = 8;
const MAX_AREA_M2 = 250000;
const DISPLAY_TOLERANCE_M = 0.8;

export function geometryHash(geom: Footprint): string {
  const hex = createHash("sha256")
    .update(JSON.stringify(roundGeom(geom, 7)))
    .digest("hex");
  return hex;
}

function roundGeom(geom: Footprint, digits: number): Footprint {
  const r = (n: number) => Number(n.toFixed(digits));
  if (geom.type === "Polygon") {
    return {
      type: "Polygon",
      coordinates: geom.coordinates.map((ring) => ring.map(([x, y]) => [r(x), r(y)])),
    };
  }
  return {
    type: "MultiPolygon",
    coordinates: geom.coordinates.map((poly) =>
      poly.map((ring) => ring.map(([x, y]) => [r(x), r(y)])),
    ),
  };
}

export function bboxOf(geom: Footprint): {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
} {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  const visit = (pt: LngLat) => {
    minLng = Math.min(minLng, pt[0]);
    minLat = Math.min(minLat, pt[1]);
    maxLng = Math.max(maxLng, pt[0]);
    maxLat = Math.max(maxLat, pt[1]);
  };
  if (geom.type === "Polygon") {
    for (const ring of geom.coordinates) for (const pt of ring) visit(pt);
  } else {
    for (const poly of geom.coordinates) {
      for (const ring of poly) for (const pt of ring) visit(pt);
    }
  }
  return { minLng, minLat, maxLng, maxLat };
}

export function centroidOf(geom: Footprint): { lng: number; lat: number } | null {
  const ring =
    geom.type === "Polygon" ? geom.coordinates[0] : geom.coordinates[0]?.[0];
  if (!ring || ring.length < 3) return null;
  let twiceArea = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    const f = x1 * y2 - x2 * y1;
    twiceArea += f;
    cx += (x1 + x2) * f;
    cy += (y1 + y2) * f;
  }
  if (Math.abs(twiceArea) < 1e-18) {
    const xs = ring.map((p) => p[0]);
    const ys = ring.map((p) => p[1]);
    return {
      lng: (Math.min(...xs) + Math.max(...xs)) / 2,
      lat: (Math.min(...ys) + Math.max(...ys)) / 2,
    };
  }
  return { lng: cx / (3 * twiceArea), lat: cy / (3 * twiceArea) };
}

function ringAreaM2(ring: LngLat[]): number {
  if (ring.length < 4) return 0;
  const lat0 = ring[0][1] * (Math.PI / 180);
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos(lat0);
  let area = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    const x1 = ring[i][0] * mPerDegLng;
    const y1 = ring[i][1] * mPerDegLat;
    const x2 = ring[i + 1][0] * mPerDegLng;
    const y2 = ring[i + 1][1] * mPerDegLat;
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area) / 2;
}

export function footprintAreaM2(geom: Footprint): number {
  if (geom.type === "Polygon") {
    const outer = ringAreaM2(geom.coordinates[0] ?? []);
    const holes = geom.coordinates.slice(1).reduce((n, ring) => n + ringAreaM2(ring), 0);
    return Math.max(0, outer - holes);
  }
  return geom.coordinates.reduce((n, poly) => {
    const outer = ringAreaM2(poly[0] ?? []);
    const holes = poly.slice(1).reduce((h, ring) => h + ringAreaM2(ring), 0);
    return n + Math.max(0, outer - holes);
  }, 0);
}

function closeRing(ring: LngLat[]): LngLat[] {
  if (ring.length === 0) return ring;
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] === last[0] && first[1] === last[1]) return ring;
  return [...ring, first];
}

function segmentsIntersect(
  a: LngLat,
  b: LngLat,
  c: LngLat,
  d: LngLat,
): boolean {
  const det = (p: LngLat, q: LngLat, r: LngLat) =>
    (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const ab = det(a, b, c) * det(a, b, d);
  const cd = det(c, d, a) * det(c, d, b);
  if (ab < 0 && cd < 0) return true;
  return false;
}

function ringSelfIntersects(ring: LngLat[]): boolean {
  const n = ring.length - 1;
  if (n < 4) return false;
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      if (Math.abs(i - j) <= 1 || (i === 0 && j === n - 1)) continue;
      if (segmentsIntersect(ring[i], ring[i + 1], ring[j], ring[j + 1])) return true;
    }
  }
  return false;
}

export function repairFootprint(geom: Footprint): { geom: Footprint; repaired: boolean } {
  let repaired = false;
  const fixRing = (ring: LngLat[]): LngLat[] => {
    const closed = closeRing(ring.filter((pt) => Number.isFinite(pt[0]) && Number.isFinite(pt[1])));
    if (closed.length !== ring.length) repaired = true;
    return closed;
  };
  if (geom.type === "Polygon") {
    const coordinates = geom.coordinates.map(fixRing).filter((ring) => ring.length >= 4);
    return { geom: { type: "Polygon", coordinates }, repaired };
  }
  const coordinates = geom.coordinates
    .map((poly) => poly.map(fixRing).filter((ring) => ring.length >= 4))
    .filter((poly) => poly.length > 0);
  return { geom: { type: "MultiPolygon", coordinates }, repaired };
}

export function validateFootprint(raw: Footprint): {
  geom: Footprint | null;
  quality: GeometryQuality;
} {
  const { geom, repaired } = repairFootprint(raw);
  const rings =
    geom.type === "Polygon" ? geom.coordinates : geom.coordinates.flat();
  const empty = rings.length === 0 || rings.every((ring) => ring.length < 4);
  if (empty) {
    return {
      geom: null,
      quality: {
        valid: false,
        empty: true,
        selfIntersecting: false,
        repaired,
        repairStatus: repaired ? "UNREPAIRABLE" : "UNREPAIRABLE",
        areaM2: null,
        absurdArea: false,
        impossibleBounds: false,
        reason: "empty geometry",
      },
    };
  }
  const box = bboxOf(geom);
  const impossibleBounds =
    box.minLng < KOREA.minLng ||
    box.maxLng > KOREA.maxLng ||
    box.minLat < KOREA.minLat ||
    box.maxLat > KOREA.maxLat;
  const selfIntersecting = rings.some(ringSelfIntersects);
  const areaM2 = footprintAreaM2(geom);
  const absurdArea = areaM2 < MIN_AREA_M2 || areaM2 > MAX_AREA_M2;
  const valid = !impossibleBounds && !absurdArea && !selfIntersecting && areaM2 > 0;
  return {
    geom: valid || (!impossibleBounds && !absurdArea) ? geom : null,
    quality: {
      valid,
      empty: false,
      selfIntersecting,
      repaired,
      repairStatus: selfIntersecting ? "UNREPAIRABLE" : repaired ? "REPAIRED" : "NONE",
      areaM2,
      absurdArea,
      impossibleBounds,
      reason: valid
        ? "ok"
        : [
            selfIntersecting ? "self-intersection" : "",
            impossibleBounds ? "impossible-bounds" : "",
            absurdArea ? "absurd-area" : "",
          ]
            .filter(Boolean)
            .join(","),
    },
  };
}

function perpendicularDistance(p: LngLat, a: LngLat, b: LngLat): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function douglasPeucker(points: LngLat[], tolDeg: number): LngLat[] {
  if (points.length <= 4) return points;
  let maxDist = 0;
  let idx = 0;
  const end = points.length - 1;
  for (let i = 1; i < end; i += 1) {
    const d = perpendicularDistance(points[i], points[0], points[end]);
    if (d > maxDist) {
      idx = i;
      maxDist = d;
    }
  }
  if (maxDist > tolDeg) {
    const left = douglasPeucker(points.slice(0, idx + 1), tolDeg);
    const right = douglasPeucker(points.slice(idx), tolDeg);
    return [...left.slice(0, -1), ...right];
  }
  return [points[0], points[end]];
}

function simplifyRing(ring: LngLat[], tolDeg: number): LngLat[] {
  const closed = closeRing(ring);
  const body = closed.slice(0, -1);
  const simplified = closeRing(douglasPeucker(body, tolDeg));
  return simplified.length >= 4 ? simplified : closed;
}

/** Deterministic display simplification. Canonical geometry stays untouched. */
export const DISPLAY_SIMPLIFY_TOLERANCE_M = DISPLAY_TOLERANCE_M;

export function simplifyFootprint(geom: Footprint, toleranceM = DISPLAY_TOLERANCE_M): Footprint {
  const lat = centroidOf(geom)?.lat ?? 37.5;
  const tolDeg = toleranceM / (111320 * Math.max(0.4, Math.cos(lat * (Math.PI / 180))));
  if (geom.type === "Polygon") {
    return { type: "Polygon", coordinates: geom.coordinates.map((ring) => simplifyRing(ring, tolDeg)) };
  }
  return {
    type: "MultiPolygon",
    coordinates: geom.coordinates.map((poly) => poly.map((ring) => simplifyRing(ring, tolDeg))),
  };
}

export function payloadBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/**
 * Korea 2000 / Unified CS (EPSG:5179) → WGS84. Used when source CRS is 5179.
 * Other Korean TM CRS values must be recorded and transformed with the matching definition.
 */
export function proj5179ToWgs84(x: number, y: number): LngLat {
  const a = 6378137.0;
  const f = 1 / 298.257222101;
  const e2 = 2 * f - f * f;
  const k0 = 0.9996;
  const lon0 = (127.5 * Math.PI) / 180;
  const falseE = 1000000.0;
  const falseN = 2000000.0;
  const xN = x - falseE;
  const yN = y - falseN;
  const m = yN / k0;
  const mu =
    m /
    (a * (1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 * e2 * e2) / 256));
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const j1 = (3 * e1) / 2 - (27 * e1 ** 3) / 32;
  const j2 = (21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32;
  const j3 = (151 * e1 ** 3) / 96;
  const j4 = (1097 * e1 ** 4) / 512;
  const fp =
    mu +
    j1 * Math.sin(2 * mu) +
    j2 * Math.sin(4 * mu) +
    j3 * Math.sin(6 * mu) +
    j4 * Math.sin(8 * mu);
  const e2p = e2 / (1 - e2);
  const c1 = e2p * Math.cos(fp) ** 2;
  const t1 = Math.tan(fp) ** 2;
  const r1 = (a * (1 - e2)) / (1 - e2 * Math.sin(fp) ** 2) ** 1.5;
  const n1 = a / Math.sqrt(1 - e2 * Math.sin(fp) ** 2);
  const d = xN / (n1 * k0);
  const lat =
    fp -
    ((n1 * Math.tan(fp)) / r1) *
      (d ** 2 / 2 -
        ((5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * e2p) * d ** 4) / 24 +
        ((61 + 90 * t1 + 298 * c1 + 45 * t1 ** 2 - 252 * e2p - 3 * c1 ** 2) * d ** 6) / 720);
  const lon =
    lon0 +
    (d -
      ((1 + 2 * t1 + c1) * d ** 3) / 6 +
      ((5 - 2 * c1 + 28 * t1 - 3 * c1 ** 2 + 8 * e2p + 24 * t1 ** 2) * d ** 5) / 120) /
      Math.cos(fp);
  return [(lon * 180) / Math.PI, (lat * 180) / Math.PI];
}

export function transformCoords(
  coords: LngLat[][] | LngLat[][][],
  sourceCrs: string,
): LngLat[][] | LngLat[][][] {
  const crs = sourceCrs.toUpperCase();
  if (crs === "EPSG:4326" || crs === "WGS84" || crs === "CRS:84") return coords;
  if (crs !== "EPSG:5179" && crs !== "5179") {
    throw new Error(`unsupported source CRS ${sourceCrs}`);
  }
  const convertPt = (pt: LngLat): LngLat => proj5179ToWgs84(pt[0], pt[1]);
  const convertRing = (ring: LngLat[]) => ring.map(convertPt);
  if (Array.isArray(coords[0]?.[0]) && typeof (coords[0] as LngLat[])[0]?.[0] === "number") {
    return (coords as LngLat[][]).map(convertRing);
  }
  return (coords as LngLat[][][]).map((poly) => poly.map(convertRing));
}

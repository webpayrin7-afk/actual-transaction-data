/** Straight-line (haversine) distance helpers for Phase 8.1 pilot. */

export type LatLng = { lat: number; lng: number };

const EARTH_RADIUS_M = 6_371_000;

export function haversineMeters(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** UI label — always disclose straight-line, never walking time. */
export function formatStraightDistanceLabel(meters: number): string {
  if (!Number.isFinite(meters) || meters < 0) return "직선거리 —";
  if (meters < 1000) return `직선거리 약 ${Math.round(meters)}m`;
  return `직선거리 약 ${(meters / 1000).toFixed(1)}km`;
}

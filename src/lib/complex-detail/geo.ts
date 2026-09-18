/** Haversine straight-line distance in meters (WGS84). */
export function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function formatStraightDistance(meters: number): string {
  if (!Number.isFinite(meters) || meters < 0) return "—";
  if (meters < 1000) return `직선 ${Math.round(meters)}m`;
  const km = meters / 1000;
  return `직선 ${km < 10 ? km.toFixed(1) : Math.round(km)}km`;
}

export type LatLng = { lat: number; lng: number };

export function isValidLatLng(v: LatLng | null | undefined): v is LatLng {
  return (
    !!v &&
    Number.isFinite(v.lat) &&
    Number.isFinite(v.lng) &&
    Math.abs(v.lat) <= 90 &&
    Math.abs(v.lng) <= 180 &&
    !(v.lat === 0 && v.lng === 0)
  );
}

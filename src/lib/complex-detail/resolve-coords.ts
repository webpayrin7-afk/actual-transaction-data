import { getDb } from "@/lib/db/client";
import { isValidLatLng, type LatLng } from "@/lib/complex-detail/geo";

/**
 * Resolve complex coordinates from existing master columns only.
 * Does not invent / geocode when columns are empty.
 */
export async function resolveComplexCoordinates(params: {
  aptName: string;
  lawdCd?: string | null;
}): Promise<LatLng | null> {
  const db = getDb();
  if (!db) return null;

  try {
    const aptName = params.aptName.trim();
    if (!aptName) return null;

    const withLawd = params.lawdCd?.trim()
      ? await db.execute({
          sql: `SELECT latitude, longitude
                FROM apt_complex_master
                WHERE apt_name = ? AND lawd_cd = ?
                  AND latitude IS NOT NULL AND longitude IS NOT NULL
                LIMIT 1`,
          args: [aptName, params.lawdCd.trim()],
        })
      : null;

    const row =
      withLawd?.rows?.[0] ??
      (
        await db.execute({
          sql: `SELECT latitude, longitude
                FROM apt_complex_master
                WHERE apt_name = ?
                  AND latitude IS NOT NULL AND longitude IS NOT NULL
                LIMIT 1`,
          args: [aptName],
        })
      ).rows?.[0];

    if (!row) return null;
    const lat = Number(row.latitude);
    const lng = Number(row.longitude);
    const coords = { lat, lng };
    return isValidLatLng(coords) ? coords : null;
  } catch {
    return null;
  }
}

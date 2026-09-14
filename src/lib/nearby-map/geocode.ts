/**
 * Resolve 잠실엘스 coordinate without inventing.
 *
 * Priority (architecture for future reuse — no DB write here):
 *   1. apt_complex_master validated lat/lng
 *   2. official GIS-derived complex representative point
 *   3. VWorld geocode fallback
 *   4. UNAVAILABLE
 *
 * Do NOT bind canonical location to NAVER Place ID.
 */

import { createClient } from "@libsql/client";
import { JAMSIL_ELS_MAP_PILOT } from "@/lib/nearby-map/jamsil-els-pilot";
import type { LatLng } from "@/lib/nearby-map/geo";
import { deriveJamsilElsOfficialGisCoordinate } from "@/lib/nearby-map/official-gis";

export type ComplexCoordinateSource =
  | "apt_complex_master"
  | "official_gis_derived"
  | "vworld_geocode"
  | "unavailable";

export type ComplexCoordinateClassification =
  | "APT_COMPLEX_MASTER"
  | "OFFICIAL-GIS-DERIVED"
  | "VWORLD_GEOCODE"
  | "UNAVAILABLE";

export type ComplexCoordinateResult = {
  ok: boolean;
  coordinate: LatLng | null;
  source: ComplexCoordinateSource;
  classification: ComplexCoordinateClassification;
  accuracy:
    | "building"
    | "parcel"
    | "road_address"
    | "jibun_address"
    | "unknown"
    | "none";
  method: string | null;
  sourceArtifact: string | null;
  note: string;
  complexId: string;
};

function dbUrl(): string | null {
  return process.env.TURSO_DATABASE_URL?.trim() || null;
}

function dbAuth(): string | undefined {
  return process.env.TURSO_AUTH_TOKEN?.trim() || undefined;
}

function vworldKey(): string | null {
  return (
    process.env.VWORLD_API_KEY?.trim() ||
    process.env.VWORLD_KEY?.trim() ||
    process.env.VWORLD_2D_DOMAIN_KEY?.trim() ||
    process.env.VWORLD_DOMAIN_KEY?.trim() ||
    null
  );
}

async function fromMaster(): Promise<ComplexCoordinateResult | null> {
  const url = dbUrl();
  if (!url) return null;
  try {
    const client = createClient({ url, authToken: dbAuth() });
    const rs = await client.execute({
      sql: `SELECT complex_id, apt_name, latitude, longitude
            FROM apt_complex_master
            WHERE complex_id = ?
               OR apt_name_norm = ?
               OR apt_name LIKE ?
            LIMIT 5`,
      args: [
        JAMSIL_ELS_MAP_PILOT.complexId,
        JAMSIL_ELS_MAP_PILOT.displayName,
        `%${JAMSIL_ELS_MAP_PILOT.displayName}%`,
      ],
    });
    for (const row of rs.rows) {
      const lat = Number(row.latitude);
      const lng = Number(row.longitude);
      if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) > 1) {
        return {
          ok: true,
          coordinate: { lat, lng },
          source: "apt_complex_master",
          classification: "APT_COMPLEX_MASTER",
          accuracy: "building",
          method: "apt_complex_master.latitude/longitude",
          sourceArtifact: "apt_complex_master",
          note: "apt_complex_master latitude/longitude",
          complexId: String(row.complex_id ?? JAMSIL_ELS_MAP_PILOT.complexId),
        };
      }
    }
    if (rs.rows.length) {
      return {
        ok: false,
        coordinate: null,
        source: "unavailable",
        classification: "UNAVAILABLE",
        accuracy: "none",
        method: null,
        sourceArtifact: "apt_complex_master",
        note: "apt_complex_master row found but latitude/longitude null",
        complexId: String(
          rs.rows[0].complex_id ?? JAMSIL_ELS_MAP_PILOT.complexId
        ),
      };
    }
    return null;
  } catch (e) {
    return {
      ok: false,
      coordinate: null,
      source: "unavailable",
      classification: "UNAVAILABLE",
      accuracy: "none",
      method: null,
      sourceArtifact: null,
      note: `master lookup failed: ${e instanceof Error ? e.message : String(e)}`,
      complexId: JAMSIL_ELS_MAP_PILOT.complexId,
    };
  }
}

async function fromOfficialGis(): Promise<ComplexCoordinateResult> {
  const gis = await deriveJamsilElsOfficialGisCoordinate();
  if (gis.ok && gis.coordinate) {
    return {
      ok: true,
      coordinate: gis.coordinate,
      source: "official_gis_derived",
      classification: "OFFICIAL-GIS-DERIVED",
      accuracy: "building",
      method: gis.method,
      sourceArtifact: gis.sourceArtifact,
      note: gis.note,
      complexId: gis.complexId,
    };
  }
  return {
    ok: false,
    coordinate: null,
    source: "unavailable",
    classification: "UNAVAILABLE",
    accuracy: "none",
    method: null,
    sourceArtifact: gis.sourceArtifact,
    note: gis.note,
    complexId: gis.complexId,
  };
}

async function vworldGetCoord(
  address: string,
  type: "road" | "parcel",
  key: string
): Promise<LatLng | null> {
  const url = new URL("https://api.vworld.kr/req/address");
  url.searchParams.set("service", "address");
  url.searchParams.set("request", "getcoord");
  url.searchParams.set("version", "2.0");
  url.searchParams.set("crs", "epsg:4326");
  url.searchParams.set("address", address);
  url.searchParams.set("type", type);
  url.searchParams.set("format", "json");
  url.searchParams.set("key", key);
  const res = await fetch(url.toString(), { next: { revalidate: 86400 } });
  if (!res.ok) return null;
  const json = (await res.json()) as {
    response?: { result?: { point?: { x?: string; y?: string } } };
  };
  const lng = Number(json.response?.result?.point?.x);
  const lat = Number(json.response?.result?.point?.y);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

async function fromVworldGeocode(): Promise<ComplexCoordinateResult> {
  const key = vworldKey();
  if (!key) {
    return {
      ok: false,
      coordinate: null,
      source: "unavailable",
      classification: "UNAVAILABLE",
      accuracy: "none",
      method: null,
      sourceArtifact: null,
      note: "VWORLD_API_KEY not configured; cannot geocode without inventing",
      complexId: JAMSIL_ELS_MAP_PILOT.complexId,
    };
  }
  try {
    const road = await vworldGetCoord(
      JAMSIL_ELS_MAP_PILOT.roadAddress,
      "road",
      key
    );
    if (road) {
      return {
        ok: true,
        coordinate: road,
        source: "vworld_geocode",
        classification: "VWORLD_GEOCODE",
        accuracy: "road_address",
        method: "VWorld address getcoord (road)",
        sourceArtifact: null,
        note: `VWorld road geocode of ${JAMSIL_ELS_MAP_PILOT.roadAddress} (road centroid — not building footprint)`,
        complexId: JAMSIL_ELS_MAP_PILOT.complexId,
      };
    }
    const jibun = await vworldGetCoord(
      JAMSIL_ELS_MAP_PILOT.jibunAddress,
      "parcel",
      key
    );
    if (jibun) {
      return {
        ok: true,
        coordinate: jibun,
        source: "vworld_geocode",
        classification: "VWORLD_GEOCODE",
        accuracy: "jibun_address",
        method: "VWorld address getcoord (parcel)",
        sourceArtifact: null,
        note: `VWorld parcel geocode of ${JAMSIL_ELS_MAP_PILOT.jibunAddress}`,
        complexId: JAMSIL_ELS_MAP_PILOT.complexId,
      };
    }
    return {
      ok: false,
      coordinate: null,
      source: "unavailable",
      classification: "UNAVAILABLE",
      accuracy: "none",
      method: null,
      sourceArtifact: null,
      note: "VWorld geocode returned empty for road and jibun addresses",
      complexId: JAMSIL_ELS_MAP_PILOT.complexId,
    };
  } catch (e) {
    return {
      ok: false,
      coordinate: null,
      source: "unavailable",
      classification: "UNAVAILABLE",
      accuracy: "none",
      method: null,
      sourceArtifact: null,
      note: `VWorld geocode error: ${e instanceof Error ? e.message : String(e)}`,
      complexId: JAMSIL_ELS_MAP_PILOT.complexId,
    };
  }
}

export async function resolveJamsilElsCoordinate(): Promise<ComplexCoordinateResult> {
  const master = await fromMaster();
  if (master?.ok && master.coordinate) return master;

  const gis = await fromOfficialGis();
  if (gis.ok && gis.coordinate) return gis;

  const geo = await fromVworldGeocode();
  if (geo.ok) return geo;

  return {
    ok: false,
    coordinate: null,
    source: "unavailable",
    classification: "UNAVAILABLE",
    accuracy: "none",
    method: null,
    sourceArtifact: gis.sourceArtifact ?? master?.sourceArtifact ?? null,
    note:
      [
        master?.note,
        gis.note,
        geo.note,
      ]
        .filter(Boolean)
        .join(" | ") ||
      "No verified coordinate — refusing to invent a center",
    complexId:
      master?.complexId ?? gis.complexId ?? JAMSIL_ELS_MAP_PILOT.complexId,
  };
}

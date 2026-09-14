/**
 * Surrounding POI via VWorld (public GIS) — not NAVER Place/Local Search.
 */

import { JAMSIL_ELS_MAP_PILOT } from "@/lib/nearby-map/jamsil-els-pilot";
import { haversineMeters, type LatLng } from "@/lib/nearby-map/geo";

export type PoiCategory = "transit" | "living" | "medical";

export type NearbyPoi = {
  id: string;
  name: string;
  category: PoiCategory;
  subcategory: string;
  lat: number;
  lng: number;
  distanceM: number;
  source: "VWORLD";
};

export type NearbyPoiBundle = {
  ok: boolean;
  transit: NearbyPoi[];
  living: NearbyPoi[];
  medical: NearbyPoi[];
  note: string;
  naverLocalPlaceStatus:
    | "NOT_AVAILABLE_WITH_MAPS_JS_KEY"
    | "SEPARATE_CREDENTIAL_REQUIRED";
};

function vworldKey(): string | null {
  return (
    process.env.VWORLD_API_KEY?.trim() ||
    process.env.VWORLD_KEY?.trim() ||
    process.env.VWORLD_2D_DOMAIN_KEY?.trim() ||
    process.env.VWORLD_DOMAIN_KEY?.trim() ||
    null
  );
}

type VworldPlace = {
  id?: string;
  title?: string;
  category?: string;
  point?: { x?: string; y?: string };
};

async function searchVworld(
  query: string,
  center: LatLng,
  key: string
): Promise<Array<{ name: string; lat: number; lng: number; category: string }>> {
  const url = new URL("https://api.vworld.kr/req/search");
  url.searchParams.set("service", "search");
  url.searchParams.set("request", "search");
  url.searchParams.set("version", "2.0");
  url.searchParams.set("crs", "EPSG:4326");
  url.searchParams.set("size", "20");
  url.searchParams.set("page", "1");
  url.searchParams.set("query", query);
  url.searchParams.set("type", "place");
  url.searchParams.set("format", "json");
  url.searchParams.set("errorformat", "json");
  url.searchParams.set("key", key);
  url.searchParams.set(
    "bbox",
    `${center.lng - 0.03},${center.lat - 0.025},${center.lng + 0.03},${center.lat + 0.025}`
  );

  try {
    const res = await fetch(url.toString(), { next: { revalidate: 86400 } });
    if (!res.ok) return [];
    const json = (await res.json()) as {
      response?: { result?: { items?: VworldPlace[] } };
    };
    const out: Array<{
      name: string;
      lat: number;
      lng: number;
      category: string;
    }> = [];
    for (const it of json.response?.result?.items ?? []) {
      const lng = Number(it.point?.x);
      const lat = Number(it.point?.y);
      const name = String(it.title ?? "").trim();
      if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      out.push({ name, lat, lng, category: String(it.category ?? "") });
    }
    return out;
  } catch {
    return [];
  }
}

function toPoi(
  category: PoiCategory,
  subcategory: string,
  items: Array<{ name: string; lat: number; lng: number }>,
  center: LatLng,
  radiusM: number
): NearbyPoi[] {
  const seen = new Set<string>();
  const out: NearbyPoi[] = [];
  for (const it of items) {
    const distanceM = haversineMeters(center, it);
    if (distanceM > radiusM) continue;
    const key = `${it.name}|${it.lat.toFixed(5)}|${it.lng.toFixed(5)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: `vworld-${category}-${key}`,
      name: it.name,
      category,
      subcategory,
      lat: it.lat,
      lng: it.lng,
      distanceM,
      source: "VWORLD",
    });
  }
  out.sort((a, b) => a.distanceM - b.distanceM);
  return out.slice(0, 12);
}

export async function loadNearbyPois(
  center: LatLng
): Promise<NearbyPoiBundle> {
  const naverLocalPlaceStatus = "NOT_AVAILABLE_WITH_MAPS_JS_KEY" as const;
  const key = vworldKey();
  if (!key) {
    return {
      ok: false,
      transit: [],
      living: [],
      medical: [],
      note: "VWORLD_API_KEY not configured — POI categories hidden",
      naverLocalPlaceStatus,
    };
  }

  const r = JAMSIL_ELS_MAP_PILOT.radiusM;
  const [subway, mart, hospital] = await Promise.all([
    searchVworld("지하철역", center, key),
    searchVworld("대형마트", center, key),
    searchVworld("병원", center, key),
  ]);

  const transitRaw = subway.filter(
    (s) =>
      /역$/.test(s.name) ||
      s.name.includes("지하철") ||
      s.category.toLowerCase().includes("교통")
  );
  const transit = toPoi(
    "transit",
    "지하철",
    transitRaw.length ? transitRaw : subway,
    center,
    r.transit
  );
  const living = toPoi("living", "마트", mart, center, r.living);
  const medical = toPoi("medical", "병원", hospital, center, r.medical);
  const ok = transit.length + living.length + medical.length > 0;
  return {
    ok,
    transit,
    living,
    medical,
    note: ok
      ? "VWorld place search (public GIS) — not NAVER Local/Place"
      : "VWorld place search returned no in-radius items",
    naverLocalPlaceStatus,
  };
}

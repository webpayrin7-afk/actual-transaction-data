import {
  formatStraightDistance,
  haversineMeters,
  type LatLng,
} from "@/lib/complex-detail/geo";
import { vworldApiKey } from "@/lib/complex-detail/source-status";

export type SurroundingCategory =
  | "transit"
  | "living"
  | "medical"
  | "park"
  | "childcare";

export type SurroundingPlace = {
  category: SurroundingCategory;
  name: string;
  distanceMeters: number;
  distanceLabel: string;
  /** Present when VWorld returned a point — used for map markers. */
  lat?: number;
  lng?: number;
};

export const SURROUNDING_CATEGORY_LABEL: Record<SurroundingCategory, string> = {
  transit: "교통",
  living: "생활",
  medical: "의료",
  park: "공원",
  childcare: "육아",
};

/** VWorld place category codes (LCLS) — subset used for nearest-POI summary. */
const CATEGORY_QUERIES: Array<{
  category: SurroundingCategory;
  query: string;
}> = [
  { category: "transit", query: "지하철역" },
  { category: "transit", query: "버스정류장" },
  { category: "living", query: "대형마트" },
  { category: "medical", query: "병원" },
  { category: "park", query: "공원" },
  { category: "childcare", query: "어린이집" },
];

type VworldItem = {
  title?: string;
  point?: { x?: string; y?: string };
};

async function searchVworld(
  query: string,
  coords: LatLng,
  key: string,
  signal?: AbortSignal,
): Promise<VworldItem[]> {
  const url = new URL("https://api.vworld.kr/req/search");
  url.searchParams.set("service", "search");
  url.searchParams.set("request", "search");
  url.searchParams.set("version", "2.0");
  url.searchParams.set("crs", "EPSG:4326");
  url.searchParams.set("size", "5");
  url.searchParams.set("page", "1");
  url.searchParams.set("query", query);
  url.searchParams.set("type", "PLACE");
  url.searchParams.set("format", "json");
  url.searchParams.set("errorformat", "json");
  url.searchParams.set("key", key);
  url.searchParams.set("point", `${coords.lng},${coords.lat}`);
  url.searchParams.set("radius", "2000");

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4500);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    const res = await fetch(url.toString(), {
      signal: ctrl.signal,
      // cache via route Cache-Control when needed
    });
    if (!res.ok) return [];
    const json = (await res.json()) as {
      response?: {
        result?: { items?: VworldItem[] };
        status?: string;
      };
    };
    return json.response?.result?.items ?? [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Nearest POIs via VWorld place search. Straight-line distances only.
 * No walking-time claims.
 */
export async function fetchNearbySurroundings(params: {
  coords: LatLng;
  signal?: AbortSignal;
}): Promise<SurroundingPlace[]> {
  const key = vworldApiKey();
  if (!key) return [];

  const settled = await Promise.all(
    CATEGORY_QUERIES.map(async (q) => {
      const items = await searchVworld(
        q.query,
        params.coords,
        key,
        params.signal,
      );
      const found: SurroundingPlace[] = [];
      for (const item of items) {
        const lng = Number(item.point?.x);
        const lat = Number(item.point?.y);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        const meters = haversineMeters(
          params.coords.lat,
          params.coords.lng,
          lat,
          lng,
        );
        if (meters > 2500) continue;
        const name = String(item.title ?? "")
          .replace(/<[^>]+>/g, "")
          .trim();
        if (!name) continue;
        found.push({
          category: q.category,
          name,
          distanceMeters: Math.round(meters),
          distanceLabel: formatStraightDistance(meters),
          lat,
          lng,
        });
      }
      found.sort((a, b) => a.distanceMeters - b.distanceMeters);
      // Transit: keep a few nearest subway/bus hits; other categories: nearest only.
      const keep = q.category === "transit" ? 3 : 1;
      return found.slice(0, keep);
    }),
  );

  // Dedupe by name; transit keeps up to 6 nearest (subway + bus).
  const byCat = new Map<SurroundingCategory, SurroundingPlace[]>();
  for (const places of settled) {
    for (const place of places) {
      const list = byCat.get(place.category) ?? [];
      if (list.some((p) => p.name === place.name)) continue;
      list.push(place);
      list.sort((a, b) => a.distanceMeters - b.distanceMeters);
      byCat.set(
        place.category,
        list.slice(0, place.category === "transit" ? 6 : 1),
      );
    }
  }

  const order: SurroundingCategory[] = [
    "transit",
    "living",
    "medical",
    "park",
    "childcare",
  ];
  return order.flatMap((c) => byCat.get(c) ?? []);
}

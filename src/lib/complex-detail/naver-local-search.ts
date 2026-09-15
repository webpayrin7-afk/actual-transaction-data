/**
 * Server-only NAVER Local Search (API HUB / legacy OpenAPI).
 * Never expose Client Secret to the browser.
 *
 * Contract: GET /search/v1/local
 * https://api.ncloud-docs.com/docs/naver-api-hub-search-local
 */

export type NaverLocalSearchItem = {
  title: string;
  link: string;
  category: string;
  description: string;
  telephone: string;
  address: string;
  roadAddress: string;
  mapx: string;
  mapy: string;
};

export type NaverLocalSearchResponse = {
  lastBuildDate?: string;
  total?: number;
  start?: number;
  display?: number;
  items?: NaverLocalSearchItem[];
};

export type NaverLocalCredentials = {
  clientId: string;
  clientSecret: string;
  /** Which header pair / host to use. */
  mode: "api-hub" | "legacy";
};

const API_HUB_BASE = "https://naverapihub.apigw.ntruss.com/search/v1/local";
const LEGACY_BASE = "https://openapi.naver.com/v1/search/local.json";

/** Cache tag / version for living Local Search payloads. */
export const NAVER_LOCAL_CACHE_VERSION = "living-v1";

/**
 * Resolve server-only Local Search credentials.
 * Prefers NAVER API HUB names; falls back to legacy OpenAPI env names.
 */
export function getNaverLocalSearchCredentials(): NaverLocalCredentials | null {
  const hubId =
    process.env.NAVER_API_HUB_CLIENT_ID?.trim() ||
    process.env.NCP_APIGW_API_KEY_ID?.trim() ||
    process.env.NAVER_SEARCH_CLIENT_ID?.trim() ||
    "";
  const hubSecret =
    process.env.NAVER_API_HUB_CLIENT_SECRET?.trim() ||
    process.env.NCP_APIGW_API_KEY?.trim() ||
    process.env.NAVER_SEARCH_CLIENT_SECRET?.trim() ||
    "";
  if (hubId && hubSecret) {
    return { clientId: hubId, clientSecret: hubSecret, mode: "api-hub" };
  }

  const legacyId = process.env.NAVER_CLIENT_ID?.trim() || "";
  const legacySecret = process.env.NAVER_CLIENT_SECRET?.trim() || "";
  if (legacyId && legacySecret) {
    return {
      clientId: legacyId,
      clientSecret: legacySecret,
      mode: "legacy",
    };
  }
  return null;
}

export function isNaverLocalSearchConfigured(): boolean {
  return getNaverLocalSearchCredentials() != null;
}

/**
 * Official Local Search: mapx = longitude, mapy = latitude (WGS84).
 * Some responses still emit scaled microdegree integers — normalize when needed.
 */
export function parseNaverLocalCoords(
  mapx: string | number | null | undefined,
  mapy: string | number | null | undefined,
): { lat: number; lng: number } | null {
  if (mapx == null || mapy == null) return null;
  let lng = typeof mapx === "number" ? mapx : Number(String(mapx).trim());
  let lat = typeof mapy === "number" ? mapy : Number(String(mapy).trim());
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;

  // Scaled integer form (legacy OpenAPI style), e.g. 127086… / 3751…
  if (Math.abs(lng) > 180 || Math.abs(lat) > 90) {
    lng = lng / 1e7;
    lat = lat / 1e7;
  }

  // Korea WGS84 sanity
  if (lat < 33 || lat > 39 || lng < 124 || lng > 132) return null;
  return { lat, lng };
}

/** Strip HTML emphasis tags / entities from Local Search titles. */
export function cleanNaverLocalTitle(raw: string): string {
  let s = String(raw || "");
  s = s.replace(/<\/?b>/gi, "");
  s = s.replace(/<[^>]+>/g, "");
  s = s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ");
  return s.replace(/\s+/g, " ").trim();
}

export type LocalSearchCallResult = {
  ok: boolean;
  items: NaverLocalSearchItem[];
  status: number;
  error?: string;
};

/**
 * One Local Search query. Uses Next fetch cache (~24h).
 * sort=random = official “정확도 내림차순” (not review-count).
 */
export async function fetchNaverLocalSearch(params: {
  query: string;
  display?: number;
}): Promise<LocalSearchCallResult> {
  const creds = getNaverLocalSearchCredentials();
  if (!creds) {
    return {
      ok: false,
      items: [],
      status: 0,
      error: "NAVER Local Search credentials missing",
    };
  }

  const display = Math.min(5, Math.max(1, params.display ?? 5));
  const qs = new URLSearchParams({
    query: params.query,
    display: String(display),
    start: "1",
    sort: "random",
    format: "json",
  });

  const url =
    creds.mode === "api-hub"
      ? `${API_HUB_BASE}?${qs.toString()}`
      : `${LEGACY_BASE}?${qs.toString()}`;

  const headers: Record<string, string> =
    creds.mode === "api-hub"
      ? {
          "X-NCP-APIGW-API-KEY-ID": creds.clientId,
          "X-NCP-APIGW-API-KEY": creds.clientSecret,
        }
      : {
          "X-Naver-Client-Id": creds.clientId,
          "X-Naver-Client-Secret": creds.clientSecret,
        };

  try {
    const res = await fetch(url, {
      method: "GET",
      headers,
      next: {
        revalidate: 86400,
        tags: [`naver-local:${NAVER_LOCAL_CACHE_VERSION}`],
      },
    });
    if (!res.ok) {
      return {
        ok: false,
        items: [],
        status: res.status,
        error: `Local Search HTTP ${res.status}`,
      };
    }
    const json = (await res.json()) as NaverLocalSearchResponse;
    return {
      ok: true,
      items: Array.isArray(json.items) ? json.items : [],
      status: res.status,
    };
  } catch (e) {
    return {
      ok: false,
      items: [],
      status: 0,
      error: e instanceof Error ? e.message : "Local Search fetch failed",
    };
  }
}

/**
 * Single-injection NAVER Maps JS SDK loader (browser only).
 * Uses NEXT_PUBLIC_NAVER_MAP_CLIENT_ID — never Client Secret.
 */

export type LatLngLiteral = { lat: number; lng: number };

export type NaverGeocodeResponse = {
  v2?: {
    status?: string;
    addresses?: Array<{
      roadAddress?: string;
      jibunAddress?: string;
      x?: string;
      y?: string;
    }>;
  };
};

export type NaverMapsApi = {
  maps: {
    Map: new (
      el: HTMLElement,
      opts: Record<string, unknown>
    ) => NaverMapInstance;
    LatLng: new (lat: number, lng: number) => unknown;
    LatLngBounds: new (sw: unknown, ne: unknown) => unknown;
    Marker: new (opts: Record<string, unknown>) => NaverMarkerInstance;
    Point: new (x: number, y: number) => unknown;
    Event: {
      addListener: (
        target: unknown,
        event: string,
        handler: (...args: unknown[]) => void
      ) => void;
      trigger?: (target: unknown, event: string) => void;
    };
    Position?: { TOP_LEFT?: unknown };
    Service?: {
      geocode: (
        opts: { query: string },
        cb: (status: string, response: NaverGeocodeResponse) => void
      ) => void;
      Status?: { OK?: string; ERROR?: string };
    };
  };
};

export type NaverMapInstance = {
  setCenter: (latlng: unknown) => void;
  panTo: (latlng: unknown) => void;
  getZoom?: () => number;
  setZoom?: (zoom: number, opts?: unknown) => void;
  fitBounds?: (bounds: unknown, margin?: unknown) => void;
  morph?: (
    coord: unknown,
    zoom?: number,
    transitionOptions?: { duration?: number; easing?: string },
  ) => void;
  panToBounds?: (
    bounds: unknown,
    transitionOptions?: { duration?: number; easing?: string },
    margin?: unknown,
  ) => void;
  stop?: () => void;
  destroy?: () => void;
};

export type NaverMarkerInstance = {
  setMap: (map: NaverMapInstance | null) => void;
  setPosition: (latlng: unknown) => void;
  setIcon?: (icon: unknown) => void;
  setZIndex?: (zIndex: number) => void;
};

declare global {
  interface Window {
    naver?: NaverMapsApi;
  }
}

let loadPromise: Promise<
  { ok: true; naver: NaverMapsApi } | { ok: false; reason: string }
> | null = null;

export function getNaverMapClientId(): string | null {
  return process.env.NEXT_PUBLIC_NAVER_MAP_CLIENT_ID?.trim() || null;
}

export function getNaverMapClientIdPresent(): boolean {
  return Boolean(getNaverMapClientId());
}

export async function loadNaverMapsSdk(): Promise<
  { ok: true; naver: NaverMapsApi } | { ok: false; reason: string }
> {
  if (typeof window === "undefined") {
    return { ok: false, reason: "NAVER Maps SDK is browser-only" };
  }
  if (window.naver?.maps) return { ok: true, naver: window.naver };
  if (loadPromise) return loadPromise;

  const id = getNaverMapClientId();
  if (!id) {
    return {
      ok: false,
      reason: "NEXT_PUBLIC_NAVER_MAP_CLIENT_ID is not configured",
    };
  }

  loadPromise = new Promise((resolve) => {
    const finishOk = () => {
      if (window.naver?.maps) resolve({ ok: true, naver: window.naver });
      else
        resolve({
          ok: false,
          reason: "NAVER Maps SDK loaded but naver.maps missing",
        });
    };
    const finishErr = (reason: string) => {
      loadPromise = null;
      resolve({ ok: false, reason });
    };

    const existing = document.querySelector<HTMLScriptElement>(
      "script[data-ziplab-naver-maps]"
    );
    if (existing) {
      if (window.naver?.maps) {
        finishOk();
        return;
      }
      existing.addEventListener("load", finishOk);
      existing.addEventListener("error", () =>
        finishErr("NAVER Maps SDK script failed to load")
      );
      return;
    }

    const script = document.createElement("script");
    script.dataset.ziplabNaverMaps = "1";
    script.async = true;
    // Keep existing Maps loader; add geocoder submodule for address→lat/lng.
    script.src = `https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=${encodeURIComponent(id)}&submodules=geocoder`;
    script.onload = finishOk;
    script.onerror = () =>
      finishErr(
        "NAVER Maps SDK failed to load (check Client ID / authorized domain)"
      );
    document.head.appendChild(script);
  });

  return loadPromise;
}

export type NaverGeocodeResult =
  | {
      ok: true;
      coordinate: LatLngLiteral;
      matchedAddress: string;
      resultCount: number;
    }
  | { ok: false; reason: string; resultCount?: number };

async function waitForNaverGeocoder(timeoutMs = 10000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (typeof window.naver?.maps?.Service?.geocode === "function") return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return typeof window.naver?.maps?.Service?.geocode === "function";
}

/**
 * Browser-only NAVER Maps Geocoder. Fail-closed on 0 / ambiguous / invalid.
 * Never logs or returns the Client ID.
 */
export async function geocodeAddressWithNaver(
  address: string,
  opts?: { acceptFirst?: boolean },
): Promise<NaverGeocodeResult> {
  const query = address.trim();
  if (!query) return { ok: false, reason: "empty address" };
  const acceptFirst = opts?.acceptFirst === true;

  const loaded = await loadNaverMapsSdk();
  if (!loaded.ok) return { ok: false, reason: loaded.reason };

  const ready = await waitForNaverGeocoder();
  if (!ready) {
    return {
      ok: false,
      reason: "NAVER geocoder submodule unavailable (Service.geocode missing)",
    };
  }

  const service = loaded.naver.maps.Service!;

  return new Promise((resolve) => {
    service.geocode({ query }, (status, response) => {
      const okStatus = service.Status?.OK ?? "OK";
      if (status !== okStatus) {
        resolve({
          ok: false,
          reason: `NAVER geocoder status=${String(status)}`,
        });
        return;
      }
      const addresses = response?.v2?.addresses ?? [];
      if (addresses.length === 0) {
        resolve({
          ok: false,
          reason: "NAVER geocoder returned 0 results",
          resultCount: 0,
        });
        return;
      }
      if (addresses.length !== 1 && !acceptFirst) {
        resolve({
          ok: false,
          reason: `ambiguous NAVER geocode (${addresses.length} results)`,
          resultCount: addresses.length,
        });
        return;
      }
      const hit = addresses[0];
      const lat = Number(hit.y);
      const lng = Number(hit.x);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        resolve({ ok: false, reason: "invalid NAVER geocode coordinate" });
        return;
      }
      if (lat < 33 || lat > 39 || lng < 124 || lng > 132) {
        resolve({ ok: false, reason: "NAVER geocode outside Korea bounds" });
        return;
      }
      const matched =
        hit.roadAddress?.trim() || hit.jibunAddress?.trim() || query;
      resolve({
        ok: true,
        coordinate: { lat, lng },
        matchedAddress: matched,
        resultCount: 1,
      });
    });
  });
}

/**
 * Single-injection NAVER Maps JS SDK loader (browser only).
 * Uses NEXT_PUBLIC_NAVER_MAP_CLIENT_ID — never Client Secret.
 */

export type NaverMapsApi = {
  maps: {
    Map: new (
      el: HTMLElement,
      opts: Record<string, unknown>
    ) => NaverMapInstance;
    LatLng: new (lat: number, lng: number) => unknown;
    Marker: new (opts: Record<string, unknown>) => NaverMarkerInstance;
    Point: new (x: number, y: number) => unknown;
    Event: {
      addListener: (target: unknown, event: string, handler: () => void) => void;
    };
    Position?: { TOP_LEFT?: unknown };
  };
};

export type NaverMapInstance = {
  setCenter: (latlng: unknown) => void;
  panTo: (latlng: unknown) => void;
  destroy?: () => void;
};

export type NaverMarkerInstance = {
  setMap: (map: NaverMapInstance | null) => void;
  setPosition: (latlng: unknown) => void;
  setIcon?: (icon: unknown) => void;
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
    script.src = `https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=${encodeURIComponent(id)}`;
    script.onload = finishOk;
    script.onerror = () =>
      finishErr(
        "NAVER Maps SDK failed to load (check Client ID / authorized domain)"
      );
    document.head.appendChild(script);
  });

  return loadPromise;
}

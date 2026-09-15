"use client";

import { useEffect, useState } from "react";
import {
  getNaverMapClientIdPresent,
  loadNaverMapsSdk,
} from "@/lib/nearby-map/naver-sdk";

type ProbeState = {
  clientIdPresent: boolean;
  sdkLoadResult: "idle" | "loading" | "ok" | "error";
  sdkReason: string | null;
  naverMapsPresent: boolean;
};

/**
 * DEV-only: coordinate-independent NAVER Client ID / SDK auth probe.
 * Does not create a map instance and never renders the Client ID value.
 */
export function NaverAuthProbe() {
  const [state, setState] = useState<ProbeState>({
    clientIdPresent: false,
    sdkLoadResult: "idle",
    sdkReason: null,
    naverMapsPresent: false,
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const clientIdPresent = getNaverMapClientIdPresent();
      if (!clientIdPresent) {
        if (!cancelled) {
          setState({
            clientIdPresent: false,
            sdkLoadResult: "error",
            sdkReason: "NEXT_PUBLIC_NAVER_MAP_CLIENT_ID missing in client runtime",
            naverMapsPresent: false,
          });
        }
        return;
      }
      if (!cancelled) {
        setState((s) => ({
          ...s,
          clientIdPresent: true,
          sdkLoadResult: "loading",
          sdkReason: null,
        }));
      }
      const loaded = await loadNaverMapsSdk();
      if (cancelled) return;
      const naverMapsPresent = Boolean(window.naver?.maps);
      setState({
        clientIdPresent: true,
        sdkLoadResult: loaded.ok && naverMapsPresent ? "ok" : "error",
        sdkReason: loaded.ok
          ? naverMapsPresent
            ? null
            : "SDK loaded but window.naver.maps missing"
          : loaded.reason,
        naverMapsPresent,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div
      data-naver-auth-probe="1"
      data-client-id-present={state.clientIdPresent ? "yes" : "no"}
      data-sdk-load={state.sdkLoadResult}
      data-naver-maps={state.naverMapsPresent ? "yes" : "no"}
      className="rounded-lg border border-dashed border-slate-300 bg-white/80 px-3 py-2 text-[12px] text-slate-600"
    >
      <p className="font-medium text-slate-800">DEV · NAVER auth probe</p>
      <ul className="mt-1 space-y-0.5 font-mono">
        <li>clientIdPresent: {state.clientIdPresent ? "yes" : "no"}</li>
        <li>sdkLoadResult: {state.sdkLoadResult}</li>
        <li>naverMapsPresent: {state.naverMapsPresent ? "yes" : "no"}</li>
        {state.sdkReason ? <li>reason: {state.sdkReason}</li> : null}
      </ul>
    </div>
  );
}

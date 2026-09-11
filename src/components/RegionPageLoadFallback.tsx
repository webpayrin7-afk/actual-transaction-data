"use client";

import { useLoadProgressWhen } from "@/components/layout/LoadProgress";

/** Keeps header progress visible while Dashboard suspends on region entry. */
export function RegionPageLoadFallback() {
  useLoadProgressWhen(true, "시장 현황 불러오는 중…", "nav");
  return (
    <div className="mx-auto max-w-7xl px-4 py-8" aria-hidden>
      <div className="lab-skeleton" />
    </div>
  );
}

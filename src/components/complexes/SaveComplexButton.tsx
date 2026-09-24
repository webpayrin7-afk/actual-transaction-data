"use client";

import { useEffect, useSyncExternalStore } from "react";
import { Heart } from "lucide-react";
import {
  getSavedComplexesServerSnapshot,
  getSavedComplexesSnapshot,
  isSavedComplex,
  refreshSavedSnapshot,
  subscribeSavedComplexes,
  toggleSavedComplex,
  type SavedComplexInput,
} from "@/lib/complexes/saved-complexes";

/** 단지 상세 헤더의 관심 단지 토글 (44px, aria-pressed). */
export function SaveComplexButton({
  entry,
}: {
  entry: SavedComplexInput;
}) {
  const items = useSyncExternalStore(
    subscribeSavedComplexes,
    getSavedComplexesSnapshot,
    getSavedComplexesServerSnapshot,
  );
  const saved = isSavedComplex(items, entry);

  // 저장된 단지를 다시 열면 목록의 최근 매매를 최신으로.
  const snapshot = entry.snapshot;
  useEffect(() => {
    if (snapshot) refreshSavedSnapshot(entry, snapshot);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.aptName, entry.regionSlug, entry.gu, snapshot?.areaLabel, snapshot?.latestTradeMan, snapshot?.latestTradeDate]);

  return (
    <button
      type="button"
      aria-pressed={saved}
      aria-label={saved ? "관심 단지에서 빼기" : "관심 단지로 저장"}
      onClick={() => toggleSavedComplex(entry)}
      className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-[color:var(--lab-muted)] transition hover:bg-[color:var(--lab-surface-subtle)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--lab-teal-600)]"
    >
      <Heart
        className="h-5 w-5"
        aria-hidden
        style={saved ? { color: "var(--lab-change-up)", fill: "var(--lab-change-up)" } : undefined}
      />
    </button>
  );
}

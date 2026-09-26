import { useSyncExternalStore } from "react";

/** 헤더 없이 지도가 화면 전체를 쓰는 경로 (지도 첫 화면) — 하단 독은 이 화면에서 조금 더 아래에 붙는다 */
export function isMapHomePath(pathname: string): boolean {
  const p = pathname.replace(/\/+$/, "") || "/";
  return p === "/" || p === "/map";
}

/**
 * 지도에서 단지(또는 정비구역) 카드가 떠 있나 — 떠 있는 동안 하단 독을 숨기고 카드가 맨 아래로 내려간다.
 * MapSearchPage 가 알리고 MobileDock 이 본다.
 */
let cardOpen = false;
const listeners = new Set<() => void>();

export function setMapCardOpen(open: boolean) {
  if (open === cardOpen) return;
  cardOpen = open;
  for (const l of listeners) l();
}

export function useMapCardOpen(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    () => cardOpen,
    () => false,
  );
}

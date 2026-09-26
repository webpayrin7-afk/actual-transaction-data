import { useSyncExternalStore } from "react";

/**
 * 지도 첫 화면(/, /map)에서 하단 독(MobileDock)을 잠시 비키게 하는 작은 저장소.
 * - 지도를 끌거나·확대·돌리는 동안 숨고, 손을 뗀 뒤 1초 지나면 돌아온다 (2D 네이버·3D MapLibre 둘 다 신호).
 * - 단지 카드가 떠 있으면 계속 숨긴다 (카드가 독 자리까지 내려온다).
 * 다른 화면의 독은 이 값을 보지 않는다 (MobileDock 이 경로로 거른다).
 */

/** 손을 뗀 뒤 독이 돌아오기까지 */
const SHOW_AFTER_MS = 1000;
/** 끝 신호를 못 받아도(끌다 만 경우 등) 이만큼 지나면 돌아온다 */
const SAFETY_MS = 6000;

type State = { interacting: boolean; cardOpen: boolean };
let state: State = { interacting: false, cardOpen: false };
const listeners = new Set<() => void>();
let endTimer = 0;
let safetyTimer = 0;

function set(next: Partial<State>) {
  const merged = { ...state, ...next };
  if (merged.interacting === state.interacting && merged.cardOpen === state.cardOpen) return;
  state = merged;
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** 지도 조작 시작 (끌기·핀치·줌·회전) */
export function mapInteractionStart() {
  window.clearTimeout(endTimer);
  window.clearTimeout(safetyTimer);
  safetyTimer = window.setTimeout(() => set({ interacting: false }), SAFETY_MS);
  set({ interacting: true });
}

/** 지도 조작 끝 — 잠시 뒤 독이 돌아온다 */
export function mapInteractionEnd() {
  if (!state.interacting) return;
  window.clearTimeout(endTimer);
  endTimer = window.setTimeout(() => {
    window.clearTimeout(safetyTimer);
    set({ interacting: false });
  }, SHOW_AFTER_MS);
}

/** 단지(또는 정비구역) 카드가 떠 있나 */
export function setMapCardOpen(open: boolean) {
  set({ cardOpen: open });
}

/** 지도 화면을 떠날 때 — 다음에 올 때 독이 숨은 채로 시작하지 않게 */
export function resetMapDock() {
  window.clearTimeout(endTimer);
  window.clearTimeout(safetyTimer);
  set({ interacting: false, cardOpen: false });
}

const hiddenSnapshot = () => state.interacting || state.cardOpen;
const serverSnapshot = () => false;

/** 지도 화면에서 독을 숨길지 */
export function useMapDockHidden(): boolean {
  return useSyncExternalStore(subscribe, hiddenSnapshot, serverSnapshot);
}

/** 헤더 없이 지도가 화면 전체를 쓰는 경로 (지도 첫 화면) */
export function isMapHomePath(pathname: string): boolean {
  const p = pathname.replace(/\/+$/, "") || "/";
  return p === "/" || p === "/map";
}

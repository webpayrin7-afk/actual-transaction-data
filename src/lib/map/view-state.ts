/**
 * 지도 보기 방식(2D | 3D) — URL `?view=3d` 가 기준 (뒤로가기·공유 링크). 토글은 history.replaceState 라 기록이 쌓이지 않는다.
 * 3D 카메라(가운데·줌·기울기·방향)와 고른 단지는 sessionStorage 에 둔다 — 3D 단지 탐색·단지 상세에서 뒤로 오면 그대로.
 * 2D 위치(LAST_VIEW_KEY, localStorage)는 따로다. 브라우저 저장소는 모두 try/catch.
 */

export type Map3dCamera = {
  lat: number;
  lng: number;
  zoom: number;
  pitch?: number;
  bearing?: number;
};

export type Map3dSession = Map3dCamera & { selectedId: string | null };

const SESSION_KEY = "apt-datalab:map-3d-session:v1";

/** 지도 입구(/, /map)마다 따로 기억 */
function keyFor(path: string): string {
  return `${SESSION_KEY}:${path || "/"}`;
}

export function read3dSession(path: string): Map3dSession | null {
  try {
    const raw = window.sessionStorage.getItem(keyFor(path));
    const v = raw ? (JSON.parse(raw) as Partial<Map3dSession>) : null;
    if (!v || !Number.isFinite(v.lat) || !Number.isFinite(v.lng) || !Number.isFinite(v.zoom)) return null;
    return {
      lat: v.lat!,
      lng: v.lng!,
      zoom: v.zoom!,
      pitch: Number.isFinite(v.pitch) ? v.pitch : undefined,
      bearing: Number.isFinite(v.bearing) ? v.bearing : undefined,
      selectedId: typeof v.selectedId === "string" && v.selectedId ? v.selectedId : null,
    };
  } catch {
    return null;
  }
}

export function write3dSession(path: string, s: Map3dSession) {
  try {
    window.sessionStorage.setItem(keyFor(path), JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

export function clear3dSession(path: string) {
  try {
    window.sessionStorage.removeItem(keyFor(path));
  } catch {
    /* ignore */
  }
}

/** 주소의 view 값만 바꾼다 (다른 검색어는 그대로, 기록은 쌓지 않음) */
export function replaceViewParam(mode: "2d" | "3d") {
  try {
    const url = new URL(window.location.href);
    if (mode === "3d") url.searchParams.set("view", "3d");
    else url.searchParams.delete("view");
    const next = `${url.pathname}${url.search}${url.hash}`;
    if (next !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
      window.history.replaceState(null, "", next);
    }
  } catch {
    /* ignore */
  }
}

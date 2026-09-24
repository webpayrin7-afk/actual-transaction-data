import {
  complexIdentityKey,
  recentComplexHref,
  type RecentComplex,
} from "@/lib/complexes/recent-views";

/**
 * 관심 단지 (localStorage MVP) — 서버 저장·계정 없음. 이 브라우저에만 남는다.
 * 저장한 단지를 다시 볼 때마다 최근 매매 스냅샷을 갱신해 목록에서 바로 비교할 수 있게 한다.
 */
export const SAVED_COMPLEXES_KEY = "apt-datalab:saved-complexes:v1";
export const SAVED_COMPLEXES_MAX = 30;
export const SAVED_COMPLEXES_EVENT = "apt-saved-complexes-changed";

export type SavedComplex = Omit<RecentComplex, "viewedAt"> & {
  savedAt: number;
  /** 마지막으로 본 시점의 선택 면적 · 최근 매매 (없으면 null) */
  snapshot: {
    areaLabel: string;
    latestTradeMan: number | null;
    latestTradeDate: string | null;
    checkedAt: number;
  } | null;
};

/** 호출하는 쪽이 넘기는 값 — checkedAt은 저장소가 채운다. */
export type SavedSnapshotInput = Omit<NonNullable<SavedComplex["snapshot"]>, "checkedAt">;
export type SavedComplexInput = Omit<SavedComplex, "savedAt" | "snapshot"> & { snapshot: SavedSnapshotInput | null };

export const savedComplexHref = (item: SavedComplex) => recentComplexHref({ ...item, viewedAt: 0 });

function canUseStorage(): boolean {
  try {
    return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
  } catch {
    return false;
  }
}

function read(): SavedComplex[] {
  if (!canUseStorage()) return [];
  try {
    const raw = window.localStorage.getItem(SAVED_COMPLEXES_KEY);
    const parsed = raw ? (JSON.parse(raw) as SavedComplex[]) : [];
    return Array.isArray(parsed) ? parsed.filter((i) => i && typeof i.aptName === "string") : [];
  } catch {
    return [];
  }
}

function write(items: SavedComplex[]): void {
  if (!canUseStorage()) return;
  try {
    window.localStorage.setItem(SAVED_COMPLEXES_KEY, JSON.stringify(items.slice(0, SAVED_COMPLEXES_MAX)));
  } catch {
    /* quota / private mode — keep UI working without persistence */
  }
  snapshotKey = null;
  window.dispatchEvent(new Event(SAVED_COMPLEXES_EVENT));
}

let snapshotKey: string | null = null;
let snapshotCache: SavedComplex[] = [];
const EMPTY: SavedComplex[] = [];

export function subscribeSavedComplexes(onChange: () => void): () => void {
  const handler = () => {
    snapshotKey = null;
    onChange();
  };
  window.addEventListener(SAVED_COMPLEXES_EVENT, handler);
  window.addEventListener("storage", handler);
  return () => {
    window.removeEventListener(SAVED_COMPLEXES_EVENT, handler);
    window.removeEventListener("storage", handler);
  };
}

export function getSavedComplexesSnapshot(): SavedComplex[] {
  if (!canUseStorage()) return EMPTY;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(SAVED_COMPLEXES_KEY);
  } catch {
    return EMPTY;
  }
  if (raw === snapshotKey) return snapshotCache;
  snapshotKey = raw;
  snapshotCache = read();
  return snapshotCache;
}

export const getSavedComplexesServerSnapshot = () => EMPTY;

type Identity = Pick<SavedComplex, "aptName" | "regionSlug" | "gu">;

export function isSavedComplex(items: SavedComplex[], id: Identity): boolean {
  const key = complexIdentityKey(id);
  return items.some((i) => complexIdentityKey(i) === key);
}

export function toggleSavedComplex(entry: SavedComplexInput): boolean {
  const items = read();
  const key = complexIdentityKey(entry);
  if (items.some((i) => complexIdentityKey(i) === key)) {
    write(items.filter((i) => complexIdentityKey(i) !== key));
    return false;
  }
  const now = Date.now();
  write([{ ...entry, savedAt: now, snapshot: entry.snapshot ? { ...entry.snapshot, checkedAt: now } : null }, ...items]);
  return true;
}

/** 저장된 단지면 스냅샷만 갱신 (저장하지 않은 단지는 건드리지 않음). */
export function refreshSavedSnapshot(id: Identity, snapshot: SavedSnapshotInput): void {
  const items = read();
  const key = complexIdentityKey(id);
  const idx = items.findIndex((i) => complexIdentityKey(i) === key);
  if (idx < 0) return;
  const prev = items[idx]!.snapshot;
  if (
    prev &&
    prev.areaLabel === snapshot.areaLabel &&
    prev.latestTradeMan === snapshot.latestTradeMan &&
    prev.latestTradeDate === snapshot.latestTradeDate
  ) {
    return;
  }
  const next = [...items];
  next[idx] = { ...items[idx]!, snapshot: { ...snapshot, checkedAt: Date.now() } };
  write(next);
}

export function removeSavedComplex(id: Identity): void {
  const key = complexIdentityKey(id);
  write(read().filter((i) => complexIdentityKey(i) !== key));
}

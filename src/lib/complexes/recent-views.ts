import { aptDetailHref } from "@/lib/molit/apt";
import { getRegion } from "@/lib/constants/regions";

/** localStorage key — 스키마 변경 시 버전 bump */
export const RECENT_COMPLEXES_KEY = "apt-datalab:recent-complexes:v1";

export const RECENT_COMPLEXES_MAX = 8;

export const RECENT_COMPLEXES_EVENT = "apt-recent-complexes-changed";

export type RecentComplex = {
  aptName: string;
  regionSlug: string;
  gu?: string;
  dong?: string;
  /** 표시용 지역 한 줄 (예: 서울 송파구 가락동) */
  regionLabel: string;
  viewedAt: number;
};

export function complexIdentityKey(
  item: Pick<RecentComplex, "aptName" | "regionSlug" | "gu">,
): string {
  const name = item.aptName.replace(/\s+/g, "").toLowerCase();
  const gu = (item.gu ?? "").replace(/\s+/g, "").toLowerCase();
  return `${name}|${item.regionSlug}|${gu}`;
}

export function formatComplexLocationLabel(opts: {
  regionSlug: string;
  regionName?: string;
  gu?: string;
  dong?: string;
}): string {
  const region = getRegion(opts.regionSlug);
  const metro =
    region?.metro === "seoul"
      ? "서울"
      : region?.metro === "gyeonggi"
        ? "경기"
        : "";
  const district =
    opts.gu?.trim() || opts.regionName?.trim() || region?.name || "";
  const dong = opts.dong?.trim() || "";
  return [metro, district, dong].filter(Boolean).join(" ");
}

export function recentComplexHref(item: RecentComplex): string {
  return aptDetailHref(item.aptName, item.regionSlug, item.gu);
}

function canUseStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function notifyChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(RECENT_COMPLEXES_EVENT));
}

export function readRecentComplexes(): RecentComplex[] {
  if (!canUseStorage()) return [];
  try {
    const raw = window.localStorage.getItem(RECENT_COMPLEXES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const items: RecentComplex[] = [];
    for (const row of parsed) {
      if (!row || typeof row !== "object") continue;
      const r = row as Record<string, unknown>;
      if (typeof r.aptName !== "string" || !r.aptName.trim()) continue;
      if (typeof r.regionSlug !== "string" || !r.regionSlug.trim()) continue;
      items.push({
        aptName: r.aptName.trim(),
        regionSlug: r.regionSlug.trim(),
        gu: typeof r.gu === "string" && r.gu.trim() ? r.gu.trim() : undefined,
        dong:
          typeof r.dong === "string" && r.dong.trim() ? r.dong.trim() : undefined,
        regionLabel:
          typeof r.regionLabel === "string" && r.regionLabel.trim()
            ? r.regionLabel.trim()
            : formatComplexLocationLabel({
                regionSlug: r.regionSlug.trim(),
                gu: typeof r.gu === "string" ? r.gu : undefined,
                dong: typeof r.dong === "string" ? r.dong : undefined,
              }),
        viewedAt: typeof r.viewedAt === "number" ? r.viewedAt : 0,
      });
    }
    return items
      .sort((a, b) => b.viewedAt - a.viewedAt)
      .slice(0, RECENT_COMPLEXES_MAX);
  } catch {
    return [];
  }
}

export function recordRecentComplex(
  input: Omit<RecentComplex, "viewedAt" | "regionLabel"> & {
    regionLabel?: string;
    viewedAt?: number;
  },
): void {
  if (!canUseStorage()) return;
  const next: RecentComplex = {
    aptName: input.aptName.trim(),
    regionSlug: input.regionSlug.trim(),
    gu: input.gu?.trim() || undefined,
    dong: input.dong?.trim() || undefined,
    regionLabel:
      input.regionLabel?.trim() ||
      formatComplexLocationLabel({
        regionSlug: input.regionSlug,
        gu: input.gu,
        dong: input.dong,
      }),
    viewedAt: input.viewedAt ?? Date.now(),
  };
  if (!next.aptName || !next.regionSlug) return;

  const key = complexIdentityKey(next);
  const prev = readRecentComplexes().filter(
    (item) => complexIdentityKey(item) !== key,
  );
  const list = [next, ...prev].slice(0, RECENT_COMPLEXES_MAX);
  try {
    window.localStorage.setItem(RECENT_COMPLEXES_KEY, JSON.stringify(list));
    notifyChanged();
  } catch {
    // quota / private mode — ignore
  }
}

export function clearRecentComplexes(): void {
  if (!canUseStorage()) return;
  try {
    window.localStorage.removeItem(RECENT_COMPLEXES_KEY);
    notifyChanged();
  } catch {
    // ignore
  }
}

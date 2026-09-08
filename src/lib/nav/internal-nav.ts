/** sessionStorage keys — tab-scoped internal navigation memory */
export const INTERNAL_PREV_URL_KEY = "adl:prevInternalUrl";
export const INTERNAL_CUR_URL_KEY = "adl:curInternalUrl";

export function currentAppUrl(
  pathname: string,
  search: string,
): string {
  const q = search.startsWith("?") ? search : search ? `?${search}` : "";
  return `${pathname}${q}`;
}

/** App-relative path like /stats?period=week — reject absolute external URLs */
export function isInternalAppPath(path: string): boolean {
  if (!path || path.startsWith("//")) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return false;
  return path.startsWith("/");
}

/**
 * True when this tab recorded an earlier same-app URL different from current.
 * Used instead of history.length (which includes external entries).
 */
export function canUseInternalHistoryBack(currentUrl: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    const prev = sessionStorage.getItem(INTERNAL_PREV_URL_KEY);
    if (!prev || !isInternalAppPath(prev)) return false;
    if (prev === currentUrl) return false;
    return true;
  } catch {
    return false;
  }
}
